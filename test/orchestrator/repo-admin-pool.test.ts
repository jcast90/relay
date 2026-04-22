/**
 * AL-12 — RepoAdminPool integration-flavour tests.
 *
 * Covers the N-session coordination piece:
 *   - boot one session per assignment
 *   - automatic restart on unexpected exit (with sessionId rotating)
 *   - restart-ceiling / rapid-flap detection
 *   - graceful shutdown tears down every child
 *   - allowedAliases filter
 *   - lifecycle-driven auto-stop
 *   - no restart while the lifecycle is winding_down
 *
 * Tests use a synchronous fake timer (so backoff waits don't burn wall
 * clock) and a FakeSpawner that exposes the child's events to the test.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SpawnedProcess } from "../../src/agents/command-invoker.js";
import type { Channel } from "../../src/domain/channel.js";
import { SessionLifecycle } from "../../src/lifecycle/session-lifecycle.js";
import {
  POOL_STOP_TIMEOUT_MS,
  RAPID_RESTART_CEILING,
  RAPID_RESTART_WINDOW_MS,
  RESTART_BACKOFF_MS,
  RepoAdminPool,
  type RepoAdminPoolEvent,
} from "../../src/orchestrator/repo-admin-pool.js";
import type {
  RepoAdminProcessSpawner,
  RepoAdminSpawnArgs,
} from "../../src/orchestrator/repo-admin-session.js";

type StdListener = (chunk: string) => void;
type ExitListener = (code: number | null, signal: NodeJS.Signals | null) => void;
type ErrorListener = (err: Error) => void;

interface FakeChild extends SpawnedProcess {
  readonly killCalls: Array<NodeJS.Signals | undefined>;
  emitExit(code: number | null, signal?: NodeJS.Signals | null): void;
  spawnArgs: RepoAdminSpawnArgs;
}

function makeFakeChild(args: RepoAdminSpawnArgs): FakeChild {
  const stdoutListeners: StdListener[] = [];
  const stderrListeners: StdListener[] = [];
  const exitListeners: ExitListener[] = [];
  const errorListeners: ErrorListener[] = [];
  const killCalls: Array<NodeJS.Signals | undefined> = [];

  return {
    pid: 10_000 + Math.floor(Math.random() * 1000),
    spawnArgs: args,
    killCalls,
    onStdout(l) {
      stdoutListeners.push(l);
    },
    onStderr(l) {
      stderrListeners.push(l);
    },
    onExit(l) {
      exitListeners.push(l);
    },
    onError(l) {
      errorListeners.push(l);
    },
    kill(signal) {
      killCalls.push(signal);
      return true;
    },
    emitExit(code, signal = null) {
      for (const l of exitListeners) l(code, signal);
    },
  };
}

class FakeSpawner implements RepoAdminProcessSpawner {
  /** One bucket per alias so tests can address "the 2nd child for alias X". */
  readonly byAlias = new Map<string, FakeChild[]>();
  spawn(args: RepoAdminSpawnArgs): SpawnedProcess {
    const child = makeFakeChild(args);
    const list = this.byAlias.get(args.alias) ?? [];
    list.push(child);
    this.byAlias.set(args.alias, list);
    return child;
  }
  children(alias: string): FakeChild[] {
    return this.byAlias.get(alias) ?? [];
  }
}

/**
 * Minimal, in-test scheduled-timer implementation. Tests call
 * `advance(ms)` to fast-forward; the pool observes this via the injected
 * {@link RepoAdminPoolOptions.setTimer} / `clearTimer`.
 */
class FakeTimers {
  private next = 1;
  private now = 0;
  private scheduled = new Map<number, { fireAt: number; fn: () => void }>();

  setTimer = (fn: () => void, ms: number): number => {
    const id = this.next++;
    this.scheduled.set(id, { fireAt: this.now + ms, fn });
    return id;
  };
  clearTimer = (handle: number | NodeJS.Timeout): void => {
    this.scheduled.delete(handle as number);
  };
  clock = (): number => this.now;
  /** Fast-forward wall clock, firing any timers that land in the window. */
  advance(ms: number): void {
    this.now += ms;
    // Copy entries because callbacks may schedule new timers.
    const entries = Array.from(this.scheduled.entries()).sort((a, b) => a[1].fireAt - b[1].fireAt);
    for (const [id, entry] of entries) {
      if (entry.fireAt <= this.now && this.scheduled.has(id)) {
        this.scheduled.delete(id);
        entry.fn();
      }
    }
  }
}

/**
 * Drain pending microtasks + the setImmediate queue so async work kicked
 * off inside a fake-timer callback (e.g. `session.start()`'s `writeFile`)
 * completes before the test asserts. We loop a few times because one
 * `await` only clears one layer of the queue.
 */
async function flushMicrotasks(): Promise<void> {
  // Mix setImmediate (drains Node's task queue) and setTimeout (drains
  // real-timer-scheduled I/O like mkdir/writeFile). The loop guards
  // against ordering surprises when a callback schedules more work.
  for (let i = 0; i < 8; i += 1) {
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 1));
  }
}

function buildChannel(aliases: string[]): Channel {
  return {
    channelId: "channel-test",
    name: "test",
    description: "test channel",
    status: "active",
    workspaceIds: aliases.map((a) => `ws-${a}`),
    members: [],
    pinnedRefs: [],
    repoAssignments: aliases.map((a) => ({
      alias: a,
      workspaceId: `ws-${a}`,
      repoPath: `/tmp/fake-${a}-repo`,
    })),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe("RepoAdminPool", () => {
  let root: string;
  let lifecycleRoot: string;
  let sessionIdCounter: number;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "relay-admin-pool-"));
    lifecycleRoot = await mkdtemp(join(tmpdir(), "relay-admin-pool-lc-"));
    sessionIdCounter = 0;
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(lifecycleRoot, { recursive: true, force: true });
  });

  async function buildPool(opts: {
    aliases: string[];
    allowedAliases?: string[];
    fullAccess?: boolean;
  }) {
    const channel = buildChannel(opts.aliases);
    const lifecycle = new SessionLifecycle(`sess-${Date.now()}`, {
      rootDir: lifecycleRoot,
    });
    const spawner = new FakeSpawner();
    const timers = new FakeTimers();

    const pool = new RepoAdminPool({
      channel,
      lifecycle,
      spawner,
      allowedAliases: opts.allowedAliases,
      fullAccess: opts.fullAccess,
      rootDir: root,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      clock: timers.clock,
      buildSessionId: () => `admin-fake-${++sessionIdCounter}`,
      sessionStopGraceMs: 5,
    });
    return { pool, lifecycle, spawner, timers };
  }

  it("boots one session per repoAssignment with the right cwd + distinct sessionIds", async () => {
    const { pool, spawner } = await buildPool({
      aliases: ["frontend", "backend", "infra"],
    });
    const events: RepoAdminPoolEvent[] = [];
    pool.onSessionEvent((evt) => events.push(evt));

    await pool.start();

    const sessions = pool.listSessions();
    expect(sessions).toHaveLength(3);

    const aliases = sessions.map((s) => s.alias).sort();
    expect(aliases).toEqual(["backend", "frontend", "infra"]);

    for (const alias of aliases) {
      const kids = spawner.children(alias);
      expect(kids).toHaveLength(1);
      expect(kids[0].spawnArgs.repoPath).toBe(`/tmp/fake-${alias}-repo`);
    }

    const startedIds = new Set(
      events.filter((e) => e.kind === "started").map((e) => (e as { sessionId: string }).sessionId)
    );
    expect(startedIds.size).toBe(3);

    const done = pool.stop();
    // Emit exits AFTER stop() has kicked off (so SIGTERM lands first) but
    // before awaiting — otherwise await pool.stop() blocks forever.
    await Promise.resolve();
    for (const alias of aliases) spawner.children(alias)[0].emitExit(0, "SIGTERM");
    await done;
  });

  it("threads the channel's fullAccess flag into spawner args", async () => {
    const { pool, spawner } = await buildPool({
      aliases: ["repo1"],
      fullAccess: true,
    });
    await pool.start();
    expect(spawner.children("repo1")[0].spawnArgs.fullAccess).toBe(true);
    // Clean up to keep vitest process tidy.
    const done = pool.stop();
    spawner.children("repo1")[0].emitExit(0, "SIGTERM");
    await done;
  });

  it("restarts a session whose child exits unexpectedly", async () => {
    const { pool, spawner, timers } = await buildPool({ aliases: ["frontend"] });
    const events: RepoAdminPoolEvent[] = [];
    pool.onSessionEvent((evt) => events.push(evt));
    await pool.start();

    const session = pool.getSession("frontend")!;
    const originalSessionId = session.sessionId;

    // Kill the child unexpectedly.
    spawner.children("frontend")[0].emitExit(137, null);
    expect(session.state).toBe("dead");

    // Backoff is 1000ms for the first restart. Advance past it.
    timers.advance(RESTART_BACKOFF_MS[0] + 1);
    // session.start() is async (writes metadata.json). Let the microtask
    // queue drain so the respawn is observable.
    await flushMicrotasks();

    // Now there must be a second child.
    expect(spawner.children("frontend")).toHaveLength(2);
    expect(session.state).toBe("ready");
    expect(session.sessionId).not.toBe(originalSessionId);

    const restarted = events.find((e) => e.kind === "restarted");
    expect(restarted).toBeDefined();
    if (restarted?.kind === "restarted") {
      expect(restarted.alias).toBe("frontend");
      expect(restarted.previousExitCode).toBe(137);
      expect(restarted.sessionId).toBe(session.sessionId);
    }

    // Pending dispatches survived (AL-13 hasn't populated it yet, but the
    // list object persists across restart).
    expect(session.getPendingDispatches()).toEqual([]);

    const done = pool.stop();
    spawner.children("frontend").at(-1)!.emitExit(0, "SIGTERM");
    await done;
  });

  it("stops restarting after RAPID_RESTART_CEILING deaths in the window", async () => {
    const { pool, spawner, timers } = await buildPool({ aliases: ["frontend"] });
    const events: RepoAdminPoolEvent[] = [];
    pool.onSessionEvent((evt) => events.push(evt));
    await pool.start();

    // Feed one more death than the ceiling allows. Each iteration must
    // advance the clock by the CURRENT tier's backoff (plus a 1ms nudge
    // so the timer actually fires) — otherwise later iterations stall
    // on the 2s / 4s / 8s delays and the handler re-enters on a dead
    // child's re-emitted exit instead of a freshly-respawned one. The
    // saturation-at-last-entry rule means the 5th restart reuses the
    // final index (8s) the same way the pool does.
    for (let i = 0; i < RAPID_RESTART_CEILING + 1; i += 1) {
      const kids = spawner.children("frontend");
      const child = kids.at(-1);
      // Once the ceiling hits, markStopped leaves no child to kill.
      if (!child) break;
      const kidsBefore = kids.length;
      child.emitExit(1, null);

      // On iter i (0-indexed), the pool's attemptIdx is i (history so
      // far), so the scheduled delay is RESTART_BACKOFF_MS[min(i, last)].
      const tierIdx = Math.min(i, RESTART_BACKOFF_MS.length - 1);
      timers.advance(RESTART_BACKOFF_MS[tierIdx] + 1);
      await flushMicrotasks();

      // On non-ceiling iterations we must have gained a fresh child —
      // this is the guard that prevents the bug where advancing too
      // little re-fires on the dead child.
      if (i < RAPID_RESTART_CEILING) {
        expect(spawner.children("frontend").length).toBe(kidsBefore + 1);
      }
    }

    const failing = events.find((e) => e.kind === "session-admin-failing");
    expect(failing).toBeDefined();
    if (failing?.kind === "session-admin-failing") {
      expect(failing.alias).toBe("frontend");
      expect(failing.reason).toBe("rapid-restart-ceiling");
      expect(failing.restartsInWindow).toBe(RAPID_RESTART_CEILING);
    }

    // Each genuine death either respawned a fresh child (5 of them,
    // from iter 0..4) or tripped the ceiling (the 6th, at iter 5). So
    // the total number of children equals the original + ceiling
    // respawns. No new child is spawned by the 6th death.
    expect(spawner.children("frontend")).toHaveLength(RAPID_RESTART_CEILING + 1);
    expect(pool.getSession("frontend")!.state).toBe("stopped");

    await pool.stop();
  });

  it("graceful stop() SIGTERMs every session and awaits exit", async () => {
    const { pool, spawner } = await buildPool({ aliases: ["a", "b", "c"] });
    await pool.start();

    // Kick stop; it will SIGTERM each child. We synthesize their exits
    // so the promise can resolve.
    const stopP = pool.stop();

    // Every child should have received SIGTERM by the next microtask.
    await Promise.resolve();
    for (const alias of ["a", "b", "c"] as const) {
      expect(spawner.children(alias)[0].killCalls).toContain("SIGTERM");
    }

    // Fire exits.
    for (const alias of ["a", "b", "c"] as const) {
      spawner.children(alias)[0].emitExit(0, "SIGTERM");
    }
    await stopP;

    for (const alias of ["a", "b", "c"] as const) {
      expect(pool.getSession(alias)!.state).toBe("stopped");
    }
  });

  it("stop() is idempotent", async () => {
    const { pool, spawner } = await buildPool({ aliases: ["a"] });
    await pool.start();
    const first = pool.stop();
    const second = pool.stop();
    spawner.children("a")[0].emitExit(0, "SIGTERM");
    await Promise.all([first, second]);
    expect(pool.getSession("a")!.state).toBe("stopped");
  });

  it("lifecycle transition to a terminal state auto-stops the pool", async () => {
    const { pool, lifecycle, spawner } = await buildPool({ aliases: ["a"] });
    await pool.start();

    // Walk lifecycle through planning → dispatching → killed. Actual
    // shutdown fires on the killed transition.
    await lifecycle.transition("dispatching");

    // stop() was fired fire-and-forget on the transition; we need to
    // synthesize the child's exit so it can finish.
    const transitionP = lifecycle.transition("killed", "test");
    // The pool subscribes; stop() was kicked synchronously inside the
    // emitter. Resolve the child.
    await Promise.resolve();
    spawner.children("a")[0].emitExit(0, "SIGTERM");
    await transitionP;

    // Let the fire-and-forget stop() settle.
    await new Promise((r) => setImmediate(r));

    expect(pool.getSession("a")!.state).toBe("stopped");
  });

  it("allowedAliases filters which repos get a session", async () => {
    const { pool, spawner } = await buildPool({
      aliases: ["frontend", "backend", "infra"],
      allowedAliases: ["frontend"],
    });
    await pool.start();

    expect(pool.listSessions().map((s) => s.alias)).toEqual(["frontend"]);
    expect(spawner.children("backend")).toHaveLength(0);
    expect(spawner.children("infra")).toHaveLength(0);

    const done = pool.stop();
    spawner.children("frontend")[0].emitExit(0, "SIGTERM");
    await done;
  });

  it("does NOT restart while lifecycle is winding_down", async () => {
    const { pool, lifecycle, spawner, timers } = await buildPool({
      aliases: ["a"],
    });
    await pool.start();

    await lifecycle.transition("dispatching");
    await lifecycle.transition("winding_down", "test");

    // Die the child. Pool should NOT respawn because the lifecycle has
    // already signalled wind-down.
    spawner.children("a")[0].emitExit(1, null);
    timers.advance(RESTART_BACKOFF_MS.at(-1)! + 10);

    expect(spawner.children("a")).toHaveLength(1);

    // Cleanup.
    const done = pool.stop();
    // The session's already dead; stop() will still run its own path but
    // won't try to SIGTERM a non-existent child. The session's markStopped
    // path handles this. We just await.
    await done;
  });

  it("rapid restarts outside the 2-minute window do not trip the ceiling", async () => {
    const { pool, spawner, timers } = await buildPool({ aliases: ["a"] });
    await pool.start();

    // Burn CEILING-1 restarts, then advance past the window, then do one
    // more — total > CEILING but they're not "in the same window". Each
    // iteration must advance the clock by THAT tier's backoff so the
    // respawn timer actually fires and a fresh child exists to exit
    // next round (advancing only the 1s tier stalls iters 2+).
    for (let i = 0; i < RAPID_RESTART_CEILING - 1; i += 1) {
      const kidsBefore = spawner.children("a").length;
      spawner.children("a").at(-1)!.emitExit(1, null);
      const tierIdx = Math.min(i, RESTART_BACKOFF_MS.length - 1);
      timers.advance(RESTART_BACKOFF_MS[tierIdx] + 1);
      await flushMicrotasks();
      expect(spawner.children("a").length).toBe(kidsBefore + 1);
    }
    // Jump past the window boundary. The next death should be attempt
    // index 0 again (old timestamps dropped), so the 1s tier applies.
    timers.advance(RAPID_RESTART_WINDOW_MS + 10);
    spawner.children("a").at(-1)!.emitExit(1, null);
    timers.advance(RESTART_BACKOFF_MS[0] + 1);
    await flushMicrotasks();

    // Still alive, still restarting — no give-up event.
    expect(pool.getSession("a")!.state).toBe("ready");

    const done = pool.stop();
    spawner.children("a").at(-1)!.emitExit(0, "SIGTERM");
    await done;
  });

  it("stop() bails out after POOL_STOP_TIMEOUT_MS if a session never exits", async () => {
    // Regression: pool.stop() awaited Promise.all on session.stop(),
    // which waits on awaitStopped() — a zombie child that never emits
    // exit would hang the entire shutdown. We cap the outer wait and
    // log the stuck aliases.
    const { pool, spawner, timers } = await buildPool({ aliases: ["stuck", "clean"] });
    await pool.start();

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Kick stop. `stuck` never emits exit; `clean` does. Drain
    // microtasks so the pool body reaches session.stop() for both
    // sessions before we emit the clean exit — this guarantees clean's
    // settled.add() runs ahead of the timeout (otherwise the filter
    // would incorrectly report clean as stuck too).
    const stopP = pool.stop();
    await flushMicrotasks();
    spawner.children("clean")[0].emitExit(0, "SIGTERM");
    await flushMicrotasks();

    // Advance past the outer timeout. The outer timer is pool-managed
    // via the injected setTimer, so fake timers drive it.
    timers.advance(POOL_STOP_TIMEOUT_MS + 1);

    // Let microtasks drain the timeout resolve → catch path.
    await stopP;

    const warnCalls = warnSpy.mock.calls.map((args) => String(args[0]));
    const timeoutWarn = warnCalls.find((msg) => msg.includes("stop() timed out"));
    expect(timeoutWarn).toBeDefined();

    // Extract the alias list from the warning (the bit after the colon).
    // The word "cleanly" appears in the fixed prefix so a naive
    // toContain("clean") match would false-positive — isolate the list.
    const aliasesInWarn = (timeoutWarn ?? "").split("exit cleanly:")[1]?.trim() ?? "";
    expect(aliasesInWarn).toContain("stuck");
    expect(aliasesInWarn).not.toContain("clean");

    warnSpy.mockRestore();
  });

  it("start() does not subscribe to lifecycle when it's already terminal", async () => {
    // Regression: start() used to install its onTransition listener
    // BEFORE checking for a terminal lifecycle, then early-returned on
    // the terminal check without unsubscribing. stop()'s `if (stopped)`
    // short-circuit meant the leak never got cleaned up.
    const channel = buildChannel(["a"]);
    const lifecycle = new SessionLifecycle(`sess-${Date.now()}-terminal`, {
      rootDir: lifecycleRoot,
    });
    // Walk the lifecycle into a terminal state before the pool is even
    // constructed.
    await lifecycle.transition("killed", "test-setup");

    const subscribeSpy = vi.spyOn(lifecycle, "onTransition");

    const spawner = new FakeSpawner();
    const timers = new FakeTimers();
    const pool = new RepoAdminPool({
      channel,
      lifecycle,
      spawner,
      rootDir: root,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      clock: timers.clock,
      buildSessionId: () => `admin-fake-${++sessionIdCounter}`,
      sessionStopGraceMs: 5,
    });

    await pool.start();

    // The terminal-state guard MUST run before the subscribe call —
    // otherwise a listener leaks for the lifetime of the process.
    expect(subscribeSpy).not.toHaveBeenCalled();

    // And no children were spawned either.
    expect(spawner.children("a")).toHaveLength(0);

    // stop() is still safe to call; it short-circuits on stopped.
    await pool.stop();
    subscribeSpy.mockRestore();
  });
});
