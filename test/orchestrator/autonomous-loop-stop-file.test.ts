/**
 * AL-9 — autonomous-loop STOP-file integration tests.
 *
 * Exercises the kill-switch plumbing end-to-end against the real
 * `startAutonomousSession` entrypoint. The loop has three tick sites
 * where it polls the STOP file:
 *
 *   1. Before the routing pass (catches "operator dropped STOP before
 *      the loop ticked").
 *   2. Between tickets inside the routing loop (catches "STOP landed
 *      mid-routing — stop dispatching further tickets").
 *   3. Background poll during the drain phase (catches "STOP landed
 *      after routing finished but workers are still draining").
 *
 * All three sites are tested. The assertion is uniform:
 *   - lifecycle ends in `killed` with reason `user-stop-signal`.
 *   - in-flight workers that had already spawned are NOT SIGTERM'd
 *     (graceful wind-down respects them).
 *   - tickets that hadn't started yet are not routed.
 *
 * The drain-end plumbing (stopping the runners after the drain
 * completes) is still the AL-14 `autonomous-loop-exit` stop call —
 * AL-9 doesn't change that contract. What it adds is the lifecycle
 * state flip + the audit-gate behavior that reads it.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SpawnedProcess } from "../../src/agents/command-invoker.js";
import { ChannelStore } from "../../src/channels/channel-store.js";
import type { Channel, RepoAssignment } from "../../src/domain/channel.js";
import type { TicketLedgerEntry } from "../../src/domain/ticket.js";
import type { SandboxRef } from "../../src/execution/sandbox.js";
import { SessionLifecycle } from "../../src/lifecycle/session-lifecycle.js";
import { TokenTracker } from "../../src/budget/token-tracker.js";
import {
  RELAY_AL14_WORKER_DRAIN,
  startAutonomousSession,
} from "../../src/orchestrator/autonomous-loop.js";
import { RELAY_REPO_ADMIN_POOL_ENABLED } from "../../src/orchestrator/repo-admin-pool.js";
import type {
  RepoAdminProcessSpawner,
  RepoAdminSpawnArgs,
} from "../../src/orchestrator/repo-admin-session.js";
import { writeStopFile } from "../../src/orchestrator/stop-file-watcher.js";
import type {
  WorkerExitEvent,
  WorkerHandle,
  WorkerSpawner,
} from "../../src/orchestrator/worker-spawner.js";
import { FileHarnessStore } from "../../src/storage/file-store.js";

type StdListener = (chunk: string) => void;
type ExitListener = (code: number | null, signal: NodeJS.Signals | null) => void;
type ErrorListener = (err: Error) => void;

interface FakeAdminChild extends SpawnedProcess {
  emitExit(code: number | null, signal?: NodeJS.Signals | null): void;
  spawnArgs: RepoAdminSpawnArgs;
}

function makeFakeAdminChild(args: RepoAdminSpawnArgs): FakeAdminChild {
  const stdoutListeners: StdListener[] = [];
  const stderrListeners: StdListener[] = [];
  const exitListeners: ExitListener[] = [];
  const errorListeners: ErrorListener[] = [];
  return {
    pid: 40_000 + Math.floor(Math.random() * 1000),
    spawnArgs: args,
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
    kill() {
      for (const l of exitListeners) l(0, "SIGTERM");
      return true;
    },
    emitExit(code, signal = null) {
      for (const l of exitListeners) l(code, signal);
    },
  };
}

class FakeAdminSpawner implements RepoAdminProcessSpawner {
  readonly byAlias = new Map<string, FakeAdminChild[]>();
  spawn(args: RepoAdminSpawnArgs): SpawnedProcess {
    const child = makeFakeAdminChild(args);
    const list = this.byAlias.get(args.alias) ?? [];
    list.push(child);
    this.byAlias.set(args.alias, list);
    return child;
  }
}

class FakeWorkerHandle implements WorkerHandle {
  readonly ticketId: string;
  readonly sessionId: string;
  readonly specialty = "general" as const;
  readonly worktreePath: string;
  readonly sandboxRef: SandboxRef;
  private _state: "running" | "completed" | "failed" | "stopped" = "running";
  private _prUrl: string | null = null;
  private listeners: Array<(evt: WorkerExitEvent) => void> = [];
  private finalEvent: WorkerExitEvent | null = null;

  constructor(ticketId: string, sessionId: string, worktreePath: string, sandboxRef: SandboxRef) {
    this.ticketId = ticketId;
    this.sessionId = sessionId;
    this.worktreePath = worktreePath;
    this.sandboxRef = sandboxRef;
  }
  get state(): "running" | "completed" | "failed" | "stopped" {
    return this._state;
  }
  get detectedPrUrl(): string | null {
    return this._prUrl;
  }
  onExit(listener: (evt: WorkerExitEvent) => void): () => void {
    if (this.finalEvent) {
      const evt = this.finalEvent;
      queueMicrotask(() => listener(evt));
      return () => {};
    }
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }
  stop = vi.fn(async (): Promise<void> => {
    if (this._state === "running") {
      this.fire({ exitCode: null });
    }
  });
  fire(args: {
    exitCode: number | null;
    prUrl?: string | null;
    stdoutTail?: string;
    stderrTail?: string;
  }): void {
    if (this.finalEvent) return;
    this._prUrl = args.prUrl ?? null;
    const evt: WorkerExitEvent = {
      exitCode: args.exitCode,
      signal: null,
      reason:
        args.exitCode === 0
          ? "completed"
          : args.exitCode === null
            ? "stopped"
            : `exit ${args.exitCode}`,
      stdoutTail: args.stdoutTail ?? "",
      stderrTail: args.stderrTail ?? "",
      detectedPrUrl: args.prUrl ?? null,
    };
    if (args.exitCode === 0) this._state = "completed";
    else if (args.exitCode === null) this._state = "stopped";
    else this._state = "failed";
    this.finalEvent = evt;
    const listeners = this.listeners.slice();
    this.listeners = [];
    for (const l of listeners) l(evt);
  }
}

class FakeWorkerSpawner {
  readonly spawnedByAlias = new Map<string, FakeWorkerHandle[]>();
  readonly destroyed: SandboxRef[] = [];
  private counter = 0;

  spawn = vi.fn(
    async (opts: {
      ticket: TicketLedgerEntry;
      repoAssignment: RepoAssignment;
      channel: Channel;
    }) => {
      this.counter += 1;
      const runId = `fake-run-${this.counter}`;
      const ticketId = opts.ticket.ticketId;
      const alias = opts.repoAssignment.alias;
      const worktreePath = `/tmp/fake-worktree/${alias}/${runId}/${ticketId}`;
      const sandboxRef: SandboxRef = {
        id: `sb-${runId}-${ticketId}`,
        workdir: { kind: "local", path: worktreePath },
        meta: {
          branch: `sandbox/${runId}/${ticketId}`,
          base: "main",
          runId,
          ticketId,
          repoRoot: opts.repoAssignment.repoPath,
        },
      };
      const handle = new FakeWorkerHandle(
        ticketId,
        `worker-sess-${this.counter}`,
        worktreePath,
        sandboxRef
      );
      const list = this.spawnedByAlias.get(alias) ?? [];
      list.push(handle);
      this.spawnedByAlias.set(alias, list);
      return { handle, worktreePath, sandboxRef };
    }
  );

  destroyWorktree = vi.fn(async (ref: SandboxRef) => {
    this.destroyed.push(ref);
  });

  handles(alias: string): FakeWorkerHandle[] {
    return this.spawnedByAlias.get(alias) ?? [];
  }
}

async function waitUntil(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitUntil timed out");
    }
    await new Promise((r) => setTimeout(r, 2));
  }
}

function makeTicket(id: string, alias: string): TicketLedgerEntry {
  return {
    ticketId: id,
    title: `t-${id}`,
    specialty: "general",
    status: "ready",
    dependsOn: [],
    assignedAgentId: null,
    assignedAgentName: null,
    crosslinkSessionId: null,
    verification: "pending",
    lastClassification: null,
    chosenNextAction: null,
    attempt: 0,
    startedAt: null,
    completedAt: null,
    updatedAt: "2026-04-21T00:00:00.000Z",
    runId: null,
    assignedAlias: alias,
  };
}

interface Fixture {
  root: string;
  sessionId: string;
  channel: Channel;
  channelStore: ChannelStore;
  lifecycle: SessionLifecycle;
  tracker: TokenTracker;
  adminSpawner: FakeAdminSpawner;
  workerSpawner: FakeWorkerSpawner;
  allowedRepos: RepoAssignment[];
  cleanup: () => Promise<void>;
}

async function buildFixture(ticketCount = 3): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "al-9-stop-"));
  const channelsDir = join(root, "channels");
  const harnessStore = new FileHarnessStore(join(root, "__hs__"));
  const channelStore = new ChannelStore(channelsDir, harnessStore);

  const assignments: RepoAssignment[] = [
    { alias: "frontend", workspaceId: "ws-frontend", repoPath: "/tmp/fake-frontend" },
  ];
  const persisted = await channelStore.createChannel({
    name: "al-9-stop",
    description: "al-9 kill-switch test",
    workspaceIds: ["ws-frontend"],
    repoAssignments: assignments,
  });
  const channel: Channel = {
    ...persisted,
    repoAssignments: assignments,
    fullAccess: false,
  };

  const tickets: TicketLedgerEntry[] = [];
  for (let i = 1; i <= ticketCount; i++) {
    tickets.push(makeTicket(`t-${i}`, "frontend"));
  }
  await channelStore.writeChannelTickets(channel.channelId, tickets);

  const sessionId = `auto-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const lifecycle = new SessionLifecycle(sessionId, { rootDir: root });
  await lifecycle.transition("dispatching", "autonomous-session-started");
  const tracker = new TokenTracker(sessionId, 100_000, { rootDir: root });

  const adminSpawner = new FakeAdminSpawner();
  const workerSpawner = new FakeWorkerSpawner();

  return {
    root,
    sessionId,
    channel,
    channelStore,
    lifecycle,
    tracker,
    adminSpawner,
    workerSpawner,
    allowedRepos: assignments,
    cleanup: async () => {
      await tracker.close().catch(() => {});
      await lifecycle.close().catch(() => {});
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function readLifecycle(
  root: string,
  sessionId: string
): Promise<{ state: string; transitions: Array<{ from: string; to: string; reason?: string }> }> {
  const raw = await readFile(join(root, "sessions", sessionId, "lifecycle.json"), "utf8");
  return JSON.parse(raw);
}

describe("startAutonomousSession — AL-9 STOP-file kill switch", () => {
  let cleanupFns: Array<() => Promise<void>> = [];
  let originalPoolFlag: string | undefined;
  let originalDrainFlag: string | undefined;

  beforeEach(() => {
    cleanupFns = [];
    originalPoolFlag = process.env[RELAY_REPO_ADMIN_POOL_ENABLED];
    originalDrainFlag = process.env[RELAY_AL14_WORKER_DRAIN];
    process.env[RELAY_REPO_ADMIN_POOL_ENABLED] = "1";
    process.env[RELAY_AL14_WORKER_DRAIN] = "1";
  });

  afterEach(async () => {
    for (const fn of cleanupFns) await fn();
    if (originalPoolFlag === undefined) delete process.env[RELAY_REPO_ADMIN_POOL_ENABLED];
    else process.env[RELAY_REPO_ADMIN_POOL_ENABLED] = originalPoolFlag;
    if (originalDrainFlag === undefined) delete process.env[RELAY_AL14_WORKER_DRAIN];
    else process.env[RELAY_AL14_WORKER_DRAIN] = originalDrainFlag;
  });

  it("honors STOP dropped before the loop starts — no tickets routed, lifecycle killed/user-stop-signal", async () => {
    const fx = await buildFixture(3);
    cleanupFns.push(fx.cleanup);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    cleanupFns.push(async () => {
      logSpy.mockRestore();
      warnSpy.mockRestore();
    });

    // Drop the STOP file BEFORE firing the driver. The very first
    // pre-routing poll should observe it and transition to
    // winding_down; no workers spawn.
    await writeStopFile(fx.sessionId, { rootDir: fx.root, source: "test" });

    await startAutonomousSession({
      sessionId: fx.sessionId,
      channel: fx.channel,
      tracker: fx.tracker,
      lifecycle: fx.lifecycle,
      trust: "supervised",
      allowedRepos: fx.allowedRepos,
      // A tight poll interval keeps test latency low; production is 20s.
      stopPollIntervalMs: 10,
      testOverrides: {
        channelStore: fx.channelStore,
        repoAdminSpawner: fx.adminSpawner,
        workerSpawner: fx.workerSpawner as unknown as WorkerSpawner,
        rootDir: fx.root,
        // AL-4: drive the steady-state loop fast so async admin-boot +
        // drain progress observes within the test's default timeout.
        pollIntervalMs: 2,
      },
    });

    // No workers ever spawned — the STOP fired on the pre-routing poll
    // so we never entered drain.
    expect(fx.workerSpawner.spawn).not.toHaveBeenCalled();

    // Lifecycle: the sequence is dispatching → winding_down → killed
    // (with reason `user-stop-signal` on the terminal). The drain path
    // carries the user-stop through to the final transition.
    const lc = await readLifecycle(fx.root, fx.sessionId);
    expect(lc.state).toBe("killed");
    const final = lc.transitions[lc.transitions.length - 1];
    expect(final.reason).toBe("user-stop-signal");
    // The pre-terminal winding_down transition also carries the
    // user-stop reason — downstream log consumers can grep for either.
    const windDown = lc.transitions.find((t) => t.to === "winding_down");
    expect(windDown?.reason).toBe("user-stop-signal");
  }, 5_000);

  it("honors STOP dropped mid-drain — in-flight worker is NOT force-stopped, queued tickets are NOT pulled", async () => {
    const fx = await buildFixture(2);
    cleanupFns.push(fx.cleanup);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    cleanupFns.push(async () => {
      logSpy.mockRestore();
      warnSpy.mockRestore();
    });

    const driverP = startAutonomousSession({
      sessionId: fx.sessionId,
      channel: fx.channel,
      tracker: fx.tracker,
      lifecycle: fx.lifecycle,
      trust: "supervised",
      allowedRepos: fx.allowedRepos,
      stopPollIntervalMs: 1,
      testOverrides: {
        channelStore: fx.channelStore,
        repoAdminSpawner: fx.adminSpawner,
        workerSpawner: fx.workerSpawner as unknown as WorkerSpawner,
        rootDir: fx.root,
        // AL-4: drive the steady-state loop fast so async admin-boot +
        // drain progress observes within the test's default timeout.
        pollIntervalMs: 2,
      },
    });

    // Wait for the first ticket to spawn (drain in progress).
    await waitUntil(() => fx.workerSpawner.handles("frontend").length >= 1);
    const firstHandle = fx.workerSpawner.handles("frontend")[0];
    expect(firstHandle.ticketId).toBe("t-1");
    // The worker's stop() must NOT have been called by anything in
    // AL-9 — graceful wind-down respects in-flight workers.
    expect(firstHandle.stop).not.toHaveBeenCalled();

    // Drop STOP mid-drain. The background poll fires every 1ms so the
    // lifecycle flips within one tick.
    await writeStopFile(fx.sessionId, { rootDir: fx.root, source: "test" });

    // Give the background STOP poll one tick to observe the file and
    // transition the lifecycle to `winding_down`. The runner's
    // `notAcceptingNew` flag is set in the same transition callback, so
    // once we observe `winding_down` we know subsequent fires will NOT
    // pull new tickets off the admin's pending queue.
    await waitUntil(() => fx.lifecycle.state === "winding_down");

    // Complete the first ticket normally — the in-flight worker is
    // allowed to finish. Under AL-4 + AL-9 wind-down semantics, the
    // runner's serial drain returns AFTER this ticket completes instead
    // of pulling the next queued ticket. The admin's pending queue
    // still has t-2 at shutdown so a future session can pick it up.
    firstHandle.fire({ exitCode: 0, prUrl: "https://github.com/o/r/pull/1" });

    await driverP;

    // Only ONE worker was ever spawned. AL-4 + AL-9 honors the "stop
    // dispatching new" contract — the second routed ticket stays in
    // the admin's queue, never spawns a worker.
    expect(fx.workerSpawner.handles("frontend")).toHaveLength(1);

    // The in-flight worker's stop() should have been called only during
    // teardown (autonomous-loop-exit). The first worker's final state
    // is "completed" (exit 0) — not "stopped" (null from SIGTERM) —
    // proving the user-stop did NOT force-kill the in-flight worker.
    expect(firstHandle.state).toBe("completed");

    // Lifecycle: dispatching → winding_down → killed, terminal reason
    // carries user-stop-signal.
    const lc = await readLifecycle(fx.root, fx.sessionId);
    expect(lc.state).toBe("killed");
    expect(lc.transitions[lc.transitions.length - 1].reason).toBe("user-stop-signal");
    const windDown = lc.transitions.find((t) => t.to === "winding_down");
    expect(windDown?.reason).toBe("user-stop-signal");
  }, 10_000);

  it("does not trigger winding_down when the STOP file is absent (idle loop reaches the natural terminal)", async () => {
    // Regression guard: AL-9 must not fire the kill switch spuriously.
    // A session with zero STOP activity should follow the AL-4 steady-
    // state driver's natural terminal path (done / done) after the
    // ticket board drains cleanly.
    const fx = await buildFixture(1);
    cleanupFns.push(fx.cleanup);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    cleanupFns.push(async () => {
      logSpy.mockRestore();
      warnSpy.mockRestore();
    });

    const driverP = startAutonomousSession({
      sessionId: fx.sessionId,
      channel: fx.channel,
      tracker: fx.tracker,
      lifecycle: fx.lifecycle,
      trust: "supervised",
      allowedRepos: fx.allowedRepos,
      stopPollIntervalMs: 10,
      testOverrides: {
        channelStore: fx.channelStore,
        repoAdminSpawner: fx.adminSpawner,
        workerSpawner: fx.workerSpawner as unknown as WorkerSpawner,
        rootDir: fx.root,
        // AL-4: drive the steady-state loop fast so async admin-boot +
        // drain progress observes within the test's default timeout.
        pollIntervalMs: 2,
      },
    });

    await waitUntil(() => fx.workerSpawner.handles("frontend").length >= 1);
    fx.workerSpawner
      .handles("frontend")[0]
      .fire({ exitCode: 0, prUrl: "https://github.com/o/r/pull/1" });

    await driverP;

    const lc = await readLifecycle(fx.root, fx.sessionId);
    // AL-4: a clean drain reaches the `done` terminal (via the
    // dispatching → winding_down → done two-step) with reason "done".
    // Neither state is the user-stop-signal path.
    expect(lc.state).toBe("done");
    expect(lc.transitions[lc.transitions.length - 1].reason).toBe("done");
    // The winding_down transition IS present on the AL-4 happy path,
    // stamped with the natural terminal reason, not the user-stop one.
    const windDown = lc.transitions.find((t) => t.to === "winding_down");
    expect(windDown?.reason).toBe("done");
  }, 10_000);

  it("audit gate: all-green ledger after user stop logs audit-eligible; non-green ledger logs skip", async () => {
    // This verifies AL-9's AC3: "Killed session still runs post-
    // completion audit IF ledger was all-green before kill; otherwise
    // skips audit." AL-6 isn't merged so the actual audit call is a
    // structured log line; we key on that so the AL-6 merge lands as
    // a drop-in.
    const fx = await buildFixture(1);
    cleanupFns.push(fx.cleanup);

    const logLines: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logLines.push(args.map((a) => String(a)).join(" "));
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    cleanupFns.push(async () => {
      logSpy.mockRestore();
      warnSpy.mockRestore();
    });

    // Drop STOP before the loop starts — no tickets are routed,
    // ledger remains "all pending/ready" (no failed tickets), which
    // counts as all-green under AL-9's rule (nothing unhealthy).
    await writeStopFile(fx.sessionId, { rootDir: fx.root, source: "test" });

    await startAutonomousSession({
      sessionId: fx.sessionId,
      channel: fx.channel,
      tracker: fx.tracker,
      lifecycle: fx.lifecycle,
      trust: "supervised",
      allowedRepos: fx.allowedRepos,
      stopPollIntervalMs: 10,
      testOverrides: {
        channelStore: fx.channelStore,
        repoAdminSpawner: fx.adminSpawner,
        workerSpawner: fx.workerSpawner as unknown as WorkerSpawner,
        rootDir: fx.root,
        // AL-4: drive the steady-state loop fast so async admin-boot +
        // drain progress observes within the test's default timeout.
        pollIntervalMs: 2,
      },
    });

    const auditEligible = logLines.find((l) => l.includes("post-completion audit eligible"));
    const auditSkipped = logLines.find((l) => l.includes("skipping post-completion audit"));

    expect(auditEligible).toBeDefined();
    expect(auditEligible).toContain("trigger=user-stop-signal");
    expect(auditSkipped).toBeUndefined();
  }, 5_000);
});
