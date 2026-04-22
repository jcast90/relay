/**
 * AL-15 — Memory-shed cycle tests.
 *
 * Covers the four acceptance criteria:
 *   1. Cycling is invisible to the channel scheduler — in-flight ticket
 *      routing survives it (pending queue preserved).
 *   2. Post-cycle repo-admin can read the board to answer "what's in
 *      flight" (decision entry contains activeTickets).
 *   3. Summary includes activeTickets, worktreesInUse, openPrs,
 *      cycleReason.
 *   4. Force cycle mid-ticket → ticket completes and no state is lost.
 *
 * Plus the supporting sub-invariants:
 *   - Cycle vs. restart distinction: cycles are NOT counted against the
 *     pool's rapid-flap ceiling.
 *   - Manual cycle via `session.cycle("manual")`.
 *   - Pool forwards a `cycled` event.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SpawnedProcess } from "../../src/agents/command-invoker.js";
import { TokenTracker } from "../../src/budget/token-tracker.js";
import type { Channel, RepoAssignment } from "../../src/domain/channel.js";
import { SessionLifecycle } from "../../src/lifecycle/session-lifecycle.js";
import {
  RAPID_RESTART_CEILING,
  RESTART_BACKOFF_MS,
  RepoAdminPool,
  type RepoAdminPoolEvent,
} from "../../src/orchestrator/repo-admin-pool.js";
import {
  CYCLE_THRESHOLD_PCT,
  RepoAdminSession,
  type RepoAdminProcessSpawner,
  type RepoAdminSessionEvent,
  type RepoAdminSpawnArgs,
  type SessionDecisionWriter,
} from "../../src/orchestrator/repo-admin-session.js";
import type { CycleDecisionInput } from "../../src/orchestrator/session-summary.js";

// --- Fakes ---------------------------------------------------------------

type ExitListener = (code: number | null, signal: NodeJS.Signals | null) => void;
type StreamListener = (chunk: string) => void;
type ErrorListener = (err: Error) => void;

interface FakeChild extends SpawnedProcess {
  readonly killCalls: Array<NodeJS.Signals | undefined>;
  spawnArgs: RepoAdminSpawnArgs;
  emitExit(code: number | null, signal?: NodeJS.Signals | null): void;
  emitStderr(chunk: string): void;
}

function makeFakeChild(spawnArgs: RepoAdminSpawnArgs): FakeChild {
  const stdoutListeners: StreamListener[] = [];
  const stderrListeners: StreamListener[] = [];
  const exitListeners: ExitListener[] = [];
  const errorListeners: ErrorListener[] = [];
  const killCalls: Array<NodeJS.Signals | undefined> = [];

  return {
    pid: 30_000 + Math.floor(Math.random() * 1000),
    spawnArgs,
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
    emitStderr(chunk) {
      for (const l of stderrListeners) l(chunk);
    },
  };
}

class FakeSpawner implements RepoAdminProcessSpawner {
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
 * Capture-only decision writer. Stashes every `recordDecision` call so
 * tests can assert on the payload shape without a real ChannelStore.
 */
class FakeDecisionWriter implements SessionDecisionWriter {
  readonly calls: Array<{ channelId: string; input: CycleDecisionInput }> = [];
  recordDecision(channelId: string, input: CycleDecisionInput): Promise<{ ok: true }> {
    this.calls.push({ channelId, input });
    return Promise.resolve({ ok: true });
  }
}

// --- Fake timer for pool backoff ----------------------------------------

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
  advance(ms: number): void {
    this.now += ms;
    const entries = Array.from(this.scheduled.entries()).sort((a, b) => a[1].fireAt - b[1].fireAt);
    for (const [id, entry] of entries) {
      if (entry.fireAt <= this.now && this.scheduled.has(id)) {
        this.scheduled.delete(id);
        entry.fn();
      }
    }
  }
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 12; i += 1) {
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 1));
  }
}

// --- Fixtures ------------------------------------------------------------

const BASE_ASSIGNMENT: RepoAssignment = {
  alias: "frontend",
  workspaceId: "ws-front",
  repoPath: "/tmp/fake-frontend-repo",
};

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

describe("RepoAdminSession — AL-15 cycle", () => {
  let root: string;
  let trackerRoot: string;
  let sessionIdCounter: number;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "relay-admin-cycle-"));
    trackerRoot = await mkdtemp(join(tmpdir(), "relay-admin-tracker-"));
    sessionIdCounter = 0;
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(trackerRoot, { recursive: true, force: true });
  });

  interface BuildArgs {
    tracker?: TokenTracker;
    channelId?: string;
    writer?: FakeDecisionWriter;
    cycleClock?: () => string;
  }

  function buildSession(args: BuildArgs = {}) {
    const spawner = new FakeSpawner();
    const writer = args.writer ?? new FakeDecisionWriter();
    const tracker =
      args.tracker ?? new TokenTracker("admin-frontend-test", 1000, { rootDir: trackerRoot });
    const session = new RepoAdminSession({
      assignment: BASE_ASSIGNMENT,
      fullAccess: false,
      logDir: join(root, "repo-admins", BASE_ASSIGNMENT.alias),
      spawner,
      buildSessionId: () => `admin-cycle-${++sessionIdCounter}`,
      stopGraceMs: 5,
      tokenTracker: tracker,
      cycle: { channelId: args.channelId ?? "channel-test", decisions: writer },
      cycleClock: args.cycleClock,
    });
    return { session, spawner, writer, tracker };
  }

  it("manual cycle: tears down + respawns with a fresh sessionId, queue persists", async () => {
    const { session, spawner, writer } = buildSession();
    const events: RepoAdminSessionEvent[] = [];
    session.onEvent((evt) => events.push(evt));

    await session.start();
    const originalSessionId = session.sessionId;

    // Seed the queue so we can assert cross-cycle preservation.
    session._pushPendingDispatchForTest("ticket-1");
    session._pushPendingDispatchForTest("ticket-2");
    session._pushPendingDispatchForTest("ticket-3");

    const cycleP = session.cycle("manual");
    // The first child must receive SIGTERM. Resolve its exit so the
    // cycle's SIGTERM→exit handshake unblocks.
    await flushMicrotasks();
    expect(spawner.children("frontend")[0].killCalls).toContain("SIGTERM");
    spawner.children("frontend")[0].emitExit(0, "SIGTERM");
    await cycleP;

    // A second child was spawned.
    expect(spawner.children("frontend")).toHaveLength(2);
    expect(session.sessionId).not.toBe(originalSessionId);
    expect(session.state).toBe("ready");
    expect(session.cycleCount).toBe(1);

    // Queue survived the cycle.
    expect(session.getPendingDispatches()).toEqual(["ticket-1", "ticket-2", "ticket-3"]);

    // Decision was written.
    expect(writer.calls).toHaveLength(1);
    const decision = writer.calls[0].input;
    expect(decision.type).toBe("repo_admin_cycle");
    expect(decision.metadata.cycleReason).toBe("manual");
    expect(decision.metadata.activeTickets).toEqual(["ticket-1", "ticket-2", "ticket-3"]);
    // AL-14 will populate these; AL-15 stubs them as empty.
    expect(decision.metadata.worktreesInUse).toEqual([]);
    expect(decision.metadata.openPrs).toEqual([]);
    expect(decision.metadata.previousSessionId).toBe(originalSessionId);
    expect(decision.metadata.nextSessionId).toBe(session.sessionId);

    // A `cycled` event fired with both session ids.
    const cycled = events.find((e) => e.kind === "cycled");
    expect(cycled).toBeDefined();
    if (cycled?.kind === "cycled") {
      expect(cycled.previousSessionId).toBe(originalSessionId);
      expect(cycled.newSessionId).toBe(session.sessionId);
      expect(cycled.reason).toBe("manual");
    }

    // Cleanup.
    const stopP = session.stop("test-cleanup");
    spawner.children("frontend").at(-1)!.emitExit(0, "SIGTERM");
    await stopP;
  });

  it("summary metadata includes every required field (AC #3)", async () => {
    const { session, spawner, writer } = buildSession({
      cycleClock: () => "2026-04-21T12:00:00.000Z",
    });
    await session.start();
    session._pushPendingDispatchForTest({ ticketId: "AL-99" });

    const cycleP = session.cycle("manual");
    await flushMicrotasks();
    spawner.children("frontend")[0].emitExit(0, "SIGTERM");
    await cycleP;

    const meta = writer.calls[0].input.metadata;
    expect(meta.activeTickets).toEqual(["AL-99"]);
    expect(meta.worktreesInUse).toEqual([]);
    expect(meta.openPrs).toEqual([]);
    expect(meta.cycleReason).toBe("manual");
    expect(meta.alias).toBe("frontend");
    expect(meta.cycledAt).toBe("2026-04-21T12:00:00.000Z");
    // title/description are a single-line summary — grep-friendly for
    // the audit export.
    expect(writer.calls[0].input.title).toMatch(/^repo-admin\[frontend\] cycled \(manual\)/);

    const stopP = session.stop("test-cleanup");
    spawner.children("frontend").at(-1)!.emitExit(0, "SIGTERM");
    await stopP;
  });

  it("token tracker crossing 60% fires an automatic cycle (budget-60pct)", async () => {
    const tracker = new TokenTracker("admin-auto", 1000, { rootDir: trackerRoot });
    const { session, spawner, writer } = buildSession({ tracker });

    await session.start();
    const originalSessionId = session.sessionId;

    // Cross 60% exactly. The tracker fires the 60-tier event which the
    // session's subscribe wires to `cycle("budget-60pct")`.
    tracker.record(600, 0);
    await tracker.flush();
    // performCycle() runs async via `void cycle(...)`. Drain microtasks
    // so the SIGTERM lands before we observe it.
    await flushMicrotasks();

    expect(spawner.children("frontend")[0].killCalls).toContain("SIGTERM");
    // Now synthesize the child exit to unblock the cycle flow.
    spawner.children("frontend")[0].emitExit(0, "SIGTERM");
    await flushMicrotasks();

    expect(spawner.children("frontend")).toHaveLength(2);
    expect(session.sessionId).not.toBe(originalSessionId);
    expect(session.cycleCount).toBe(1);

    expect(writer.calls).toHaveLength(1);
    expect(writer.calls[0].input.metadata.cycleReason).toBe("budget-60pct");

    // Sanity-check the threshold constant so a future change to
    // THRESHOLDS that drops 60 surfaces here.
    expect(CYCLE_THRESHOLD_PCT).toBe(60);

    const stopP = session.stop("test-cleanup");
    spawner.children("frontend").at(-1)!.emitExit(0, "SIGTERM");
    await stopP;
    await tracker.close();
  });

  it("cycle after stop() throws — cycle is mid-life only", async () => {
    const { session, spawner } = buildSession();
    await session.start();
    const stopP = session.stop("test");
    spawner.children("frontend")[0].emitExit(0, "SIGTERM");
    await stopP;

    await expect(session.cycle("manual")).rejects.toThrow(/cannot cycle\(\) after stop/);
  });

  it("cycle writes a decision even when the decisions store throws — tear-down still runs", async () => {
    // Regression: a flaky board write must not wedge the session at 60%+.
    const writer: SessionDecisionWriter = {
      recordDecision: () => Promise.reject(new Error("board offline")),
    };
    const tracker = new TokenTracker("admin-flaky", 1000, { rootDir: trackerRoot });
    const spawner = new FakeSpawner();
    const session = new RepoAdminSession({
      assignment: BASE_ASSIGNMENT,
      fullAccess: false,
      logDir: join(root, "repo-admins", BASE_ASSIGNMENT.alias),
      spawner,
      buildSessionId: () => `admin-flaky-${++sessionIdCounter}`,
      stopGraceMs: 5,
      tokenTracker: tracker,
      cycle: { channelId: "c", decisions: writer },
    });
    await session.start();

    const cycleP = session.cycle("manual");
    await flushMicrotasks();
    spawner.children("frontend")[0].emitExit(0, "SIGTERM");
    await cycleP;

    // Cycle completed despite the write failure.
    expect(session.cycleCount).toBe(1);
    expect(spawner.children("frontend")).toHaveLength(2);

    const stopP = session.stop("test-cleanup");
    spawner.children("frontend").at(-1)!.emitExit(0, "SIGTERM");
    await stopP;
    await tracker.close();
  });
});

// ------------------------------------------------------------------------
// Pool-level assertions: cycle is observable, cycles don't trip the
// rapid-flap ceiling.

describe("RepoAdminPool — AL-15 cycle integration", () => {
  let root: string;
  let lifecycleRoot: string;
  let trackerRoot: string;
  let sessionIdCounter: number;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "relay-admin-cycle-pool-"));
    lifecycleRoot = await mkdtemp(join(tmpdir(), "relay-admin-cycle-lc-"));
    trackerRoot = await mkdtemp(join(tmpdir(), "relay-admin-cycle-pool-tr-"));
    sessionIdCounter = 0;
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(lifecycleRoot, { recursive: true, force: true });
    await rm(trackerRoot, { recursive: true, force: true });
  });

  async function buildPool(aliases: string[]) {
    const channel = buildChannel(aliases);
    const lifecycle = new SessionLifecycle(`sess-${Date.now()}`, { rootDir: lifecycleRoot });
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
      buildSessionId: () => `admin-pool-${++sessionIdCounter}`,
      sessionStopGraceMs: 5,
    });
    return { pool, spawner, timers, lifecycle };
  }

  it("pool forwards a `cycled` event when a session cycles", async () => {
    const { pool, spawner } = await buildPool(["frontend"]);
    const events: RepoAdminPoolEvent[] = [];
    pool.onSessionEvent((evt) => events.push(evt));
    await pool.start();

    const session = pool.getSession("frontend")!;
    const originalSessionId = session.sessionId;

    const cycleP = session.cycle("manual");
    await flushMicrotasks();
    spawner.children("frontend")[0].emitExit(0, "SIGTERM");
    await cycleP;

    const cycled = events.find((e) => e.kind === "cycled");
    expect(cycled).toBeDefined();
    if (cycled?.kind === "cycled") {
      expect(cycled.alias).toBe("frontend");
      expect(cycled.sessionId_old).toBe(originalSessionId);
      expect(cycled.sessionId_new).toBe(session.sessionId);
      expect(cycled.reason).toBe("manual");
    }

    const stopP = pool.stop();
    spawner.children("frontend").at(-1)!.emitExit(0, "SIGTERM");
    await stopP;
  });

  it("cycles do not count against rapid-restart ceiling; an unexpected exit after cycles still counts", async () => {
    // Plan: fire N cycles (N > RAPID_RESTART_CEILING). Then trigger a
    // genuine unexpected exit and assert the pool's restart path runs
    // (the rapid-flap counter was NOT bumped by cycles).
    const { pool, spawner, timers } = await buildPool(["frontend"]);
    await pool.start();
    const session = pool.getSession("frontend")!;

    // 5 cycles in a row. If cycles tripped the rapid-flap ceiling, the
    // session would enter `stopped` after the first batch.
    const cycleCount = RAPID_RESTART_CEILING + 1;
    for (let i = 0; i < cycleCount; i += 1) {
      const cycleP = session.cycle("manual");
      await flushMicrotasks();
      // Emit exit for the child currently being torn down.
      const kidsBefore = spawner.children("frontend").length;
      spawner.children("frontend")[kidsBefore - 1].emitExit(0, "SIGTERM");
      await cycleP;
    }

    expect(session.state).toBe("ready");
    expect(session.cycleCount).toBe(cycleCount);

    // Now an unexpected exit. The pool should schedule a restart.
    const kidsBefore = spawner.children("frontend").length;
    spawner.children("frontend").at(-1)!.emitExit(1, null);
    expect(session.state).toBe("dead");

    timers.advance(RESTART_BACKOFF_MS[0] + 1);
    await flushMicrotasks();

    expect(spawner.children("frontend").length).toBe(kidsBefore + 1);
    expect(session.state).toBe("ready");

    const stopP = pool.stop();
    spawner.children("frontend").at(-1)!.emitExit(0, "SIGTERM");
    await stopP;
  });
});
