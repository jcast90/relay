/**
 * AL-4 — steady-state autonomous-loop driver integration tests.
 *
 * Exercises the full-drain path gated by `RELAY_REPO_ADMIN_POOL_ENABLED +
 * RELAY_AL14_WORKER_DRAIN`. Scope (mirrors the AL-4 acceptance criteria):
 *
 *   - Three tickets across two repos route to the matching admins,
 *     workers spawn, and the driver exits `done / "done"` once every
 *     ticket lands in a terminal state (`verifying` counts for AL-4 —
 *     PR-merge cleanup is AL-5's follow-up).
 *   - 85% token-budget threshold flips the lifecycle to `winding_down`
 *     mid-drain; the driver lets in-flight tickets complete, refuses to
 *     dispatch any new tickets, and exits `done / "budget-winding-down"`.
 *   - A wall-clock watchdog that fires mid-ticket pushes the lifecycle
 *     to `killed`; the driver exits `killed / "wall-clock-exceeded"` and
 *     the in-flight worker receives its graceful stop signal.
 *
 * Scripted fakes: see `autonomous-loop-drain.test.ts` for the shared
 * shape. The fakes are duplicated rather than imported to keep each
 * integration test hermetic — a refactor of one shouldn't quietly change
 * the behaviour tests rely on.
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
import type {
  WorkerExitEvent,
  WorkerHandle,
  WorkerSpawner,
} from "../../src/orchestrator/worker-spawner.js";
import { FileHarnessStore } from "../../src/storage/file-store.js";

// --- fakes (deliberately duplicated from autonomous-loop-drain.test.ts) --

type StdListener = (chunk: string) => void;
type ExitListener = (code: number | null, signal: NodeJS.Signals | null) => void;
type ErrorListener = (err: Error) => void;

interface FakeAdminChild extends SpawnedProcess {
  emitExit(code: number | null, signal?: NodeJS.Signals | null): void;
  spawnArgs: RepoAdminSpawnArgs;
}

function makeFakeAdminChild(args: RepoAdminSpawnArgs): FakeAdminChild {
  const exitListeners: ExitListener[] = [];
  return {
    pid: 40_000 + Math.floor(Math.random() * 1000),
    spawnArgs: args,
    onStdout(_l: StdListener) {
      /* noop */
    },
    onStderr(_l: StdListener) {
      /* noop */
    },
    onExit(l: ExitListener) {
      exitListeners.push(l);
    },
    onError(_l: ErrorListener) {
      /* noop */
    },
    kill() {
      for (const l of exitListeners) l(0, "SIGTERM");
      return true;
    },
    emitExit(code: number | null, signal: NodeJS.Signals | null = null) {
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

  totalSpawned(): number {
    let n = 0;
    for (const list of this.spawnedByAlias.values()) n += list.length;
    return n;
  }
}

async function waitUntil(pred: () => boolean, timeoutMs = 3000): Promise<void> {
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

interface FixtureOpts {
  tickets: TicketLedgerEntry[];
}

async function buildFixture(opts: FixtureOpts) {
  const root = await mkdtemp(join(tmpdir(), "al-4-steady-"));
  const channelsDir = join(root, "channels");
  const harnessStore = new FileHarnessStore(join(root, "__hs__"));
  const channelStore = new ChannelStore(channelsDir, harnessStore);

  const assignments: RepoAssignment[] = [
    { alias: "frontend", workspaceId: "ws-frontend", repoPath: "/tmp/fake-frontend" },
    { alias: "backend", workspaceId: "ws-backend", repoPath: "/tmp/fake-backend" },
  ];
  const persisted = await channelStore.createChannel({
    name: "al-4-steady",
    description: "al-4 steady-state integration test",
    workspaceIds: ["ws-frontend", "ws-backend"],
    repoAssignments: assignments,
  });
  const channel: Channel = { ...persisted, repoAssignments: assignments, fullAccess: false };

  await channelStore.writeChannelTickets(channel.channelId, opts.tickets);

  const sessionId = `auto-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const lifecycle = new SessionLifecycle(sessionId, { rootDir: root });
  await lifecycle.transition("dispatching", "autonomous-session-started");
  const tracker = new TokenTracker(sessionId, 100_000, { rootDir: root });

  const adminSpawner = new FakeAdminSpawner();
  const workerSpawner = new FakeWorkerSpawner();

  const cleanup = async () => {
    await tracker.close().catch(() => {});
    await lifecycle.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  };

  return {
    root,
    sessionId,
    channel,
    channelStore,
    lifecycle,
    tracker,
    adminSpawner,
    workerSpawner,
    cleanup,
    allowedRepos: assignments,
  };
}

describe("AL-4 steady-state driver", () => {
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

  it("drains 3 tickets across 2 repos, routes through winding_down → done", async () => {
    // AC: 3 tickets on board → routes, waits for all 3 to reach terminal
    // state, exits `done` with reason `done`.
    const fx = await buildFixture({
      tickets: [
        makeTicket("fe-1", "frontend"),
        makeTicket("be-1", "backend"),
        makeTicket("be-2", "backend"),
      ],
    });
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
      testOverrides: {
        channelStore: fx.channelStore,
        repoAdminSpawner: fx.adminSpawner,
        workerSpawner: fx.workerSpawner as unknown as WorkerSpawner,
        rootDir: fx.root,
        pollIntervalMs: 2,
      },
    });

    // Parallel spawn: one admin per alias, each has its first ticket
    // in flight before the other completes.
    await waitUntil(
      () =>
        fx.workerSpawner.handles("frontend").length >= 1 &&
        fx.workerSpawner.handles("backend").length >= 1
    );

    // fe-1 is the only frontend ticket; be-1 must be first on backend
    // (FIFO within an admin's queue).
    expect(fx.workerSpawner.handles("frontend")[0].ticketId).toBe("fe-1");
    expect(fx.workerSpawner.handles("backend")[0].ticketId).toBe("be-1");

    // Complete frontend's one ticket and backend's first ticket.
    fx.workerSpawner
      .handles("frontend")[0]
      .fire({ exitCode: 0, prUrl: "https://github.com/o/r/pull/fe1" });
    fx.workerSpawner
      .handles("backend")[0]
      .fire({ exitCode: 0, prUrl: "https://github.com/o/r/pull/be1" });

    // backend rolls to be-2.
    await waitUntil(() => fx.workerSpawner.handles("backend").length >= 2);
    expect(fx.workerSpawner.handles("backend")[1].ticketId).toBe("be-2");
    fx.workerSpawner
      .handles("backend")[1]
      .fire({ exitCode: 0, prUrl: "https://github.com/o/r/pull/be2" });

    await driverP;

    // Exactly 3 spawns — one per ticket, no retries.
    expect(fx.workerSpawner.totalSpawned()).toBe(3);

    // Lifecycle final state: `done` via `winding_down`. Two successive
    // transitions from `dispatching` — the only legal path to `done`.
    const lcRaw = await readFile(join(fx.root, "sessions", fx.sessionId, "lifecycle.json"), "utf8");
    const lc = JSON.parse(lcRaw);
    expect(lc.state).toBe("done");
    const transitions = lc.transitions as Array<{ from: string; to: string; reason?: string }>;
    const final = transitions[transitions.length - 1];
    expect(final.from).toBe("winding_down");
    expect(final.to).toBe("done");
    expect(final.reason).toBe("done");
    // And the penultimate (from dispatching → winding_down).
    const prior = transitions[transitions.length - 2];
    expect(prior.from).toBe("dispatching");
    expect(prior.to).toBe("winding_down");

    // All tickets reached `verifying` (PR open) — AL-4 treats verifying
    // as terminal for driver exit (AL-5 / pr-watcher moves them to
    // `completed` on merge).
    const board = await fx.channelStore.readChannelTickets(fx.channel.channelId);
    const byId = Object.fromEntries(board.map((t) => [t.ticketId, t]));
    expect(byId["fe-1"].status).toBe("verifying");
    expect(byId["be-1"].status).toBe("verifying");
    expect(byId["be-2"].status).toBe("verifying");
  }, 15_000);

  it("85% token threshold flips winding_down; in-flight completes; no new dispatches; exits done/budget-winding-down", async () => {
    // AC: 85% token threshold flips winding_down mid-drain. The in-
    // flight ticket completes, but no new ticket is routed after the
    // flip. Driver exits `done / "budget-winding-down"`.
    //
    // Layout: two backend tickets so backend still has be-2 queued
    // when the threshold fires during be-1. After the flip, be-2 must
    // NOT spawn (driver refuses new dispatches; backend admin's queue
    // would have it as pending, but the router never sent it there).
    const fx = await buildFixture({
      tickets: [
        makeTicket("be-1", "backend"),
        makeTicket("be-2", "backend"),
        makeTicket("fe-1", "frontend"), // another ready ticket that MUST not be routed after wind-down
      ],
    });
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
      testOverrides: {
        channelStore: fx.channelStore,
        repoAdminSpawner: fx.adminSpawner,
        workerSpawner: fx.workerSpawner as unknown as WorkerSpawner,
        rootDir: fx.root,
        pollIntervalMs: 2,
      },
    });

    // Wait for both admins' first ticket in-flight.
    await waitUntil(
      () =>
        fx.workerSpawner.handles("backend").length >= 1 &&
        fx.workerSpawner.handles("frontend").length >= 1
    );
    const beFirst = fx.workerSpawner.handles("backend")[0];
    const feFirst = fx.workerSpawner.handles("frontend")[0];
    expect(beFirst.ticketId).toBe("be-1");
    expect(feFirst.ticketId).toBe("fe-1");

    // Fire the 85% threshold manually: transition the lifecycle
    // directly. AL-2 wires the tracker → lifecycle bus in production;
    // the test shortcuts that so it doesn't have to game token counts
    // to land exactly on the 85% boundary.
    await fx.lifecycle.transition("winding_down", "token-budget-85pct");

    // Complete both in-flight tickets AFTER the flip. They represent
    // "work already dispatched before wind-down started" and must be
    // allowed to finish.
    beFirst.fire({ exitCode: 0, prUrl: "https://github.com/o/r/pull/be1" });
    feFirst.fire({ exitCode: 0, prUrl: "https://github.com/o/r/pull/fe1" });

    await driverP;

    // Critically: be-2 was still `ready` on the board when the wind-down
    // landed, but the driver refused to route it after that point. The
    // fake spawner records every `spawn()` call, so checking total
    // spawn count is the cleanest way to assert "no new work landed".
    expect(fx.workerSpawner.totalSpawned()).toBe(2);
    // be-2 stayed `ready` (the router never touched it). fe-1 is
    // `verifying` (worker completed with PR URL). Same for be-1.
    const board = await fx.channelStore.readChannelTickets(fx.channel.channelId);
    const byId = Object.fromEntries(board.map((t) => [t.ticketId, t]));
    expect(byId["be-1"].status).toBe("verifying");
    expect(byId["fe-1"].status).toBe("verifying");
    expect(byId["be-2"].status).toBe("ready");

    // Lifecycle final state: `done` with reason `budget-winding-down`.
    const lcRaw = await readFile(join(fx.root, "sessions", fx.sessionId, "lifecycle.json"), "utf8");
    const lc = JSON.parse(lcRaw);
    expect(lc.state).toBe("done");
    const transitions = lc.transitions as Array<{ from: string; to: string; reason?: string }>;
    const final = transitions[transitions.length - 1];
    expect(final.from).toBe("winding_down");
    expect(final.to).toBe("done");
    expect(final.reason).toBe("budget-winding-down");
  }, 15_000);

  it("wall-clock kill mid-ticket: driver exits killed/wall-clock-exceeded and in-flight worker gets graceful stop", async () => {
    // AC: a wall-clock kill while a worker is mid-ticket exits the
    // driver cleanly. The in-flight worker's `stop()` is invoked (the
    // graceful-shutdown signal). The lifecycle file records reason
    // `wall-clock-exceeded`.
    const fx = await buildFixture({
      tickets: [makeTicket("be-1", "backend"), makeTicket("fe-1", "frontend")],
    });
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
      testOverrides: {
        channelStore: fx.channelStore,
        repoAdminSpawner: fx.adminSpawner,
        workerSpawner: fx.workerSpawner as unknown as WorkerSpawner,
        rootDir: fx.root,
        pollIntervalMs: 2,
      },
    });

    await waitUntil(
      () =>
        fx.workerSpawner.handles("backend").length >= 1 &&
        fx.workerSpawner.handles("frontend").length >= 1
    );
    const beFirst = fx.workerSpawner.handles("backend")[0];
    const feFirst = fx.workerSpawner.handles("frontend")[0];

    // Fire the wall-clock kill — same state transition AL-2 would
    // produce when the watchdog elapses (`dispatching → killed` with
    // reason `wall-clock-exceeded`).
    await fx.lifecycle.transition("killed", "wall-clock-exceeded");

    // The driver should resolve promptly — kill is an abort, not a
    // graceful wait-for-drain. The worker handles' `stop` fires via the
    // top-level cleanup path (`runner.stop("autonomous-loop-exit")`),
    // which propagates SIGTERM-equivalent into each handle.
    await driverP;

    expect(beFirst.stop).toHaveBeenCalled();
    expect(feFirst.stop).toHaveBeenCalled();

    const lcRaw = await readFile(join(fx.root, "sessions", fx.sessionId, "lifecycle.json"), "utf8");
    const lc = JSON.parse(lcRaw);
    expect(lc.state).toBe("killed");
    const transitions = lc.transitions as Array<{ from: string; to: string; reason?: string }>;
    const final = transitions[transitions.length - 1];
    expect(final.to).toBe("killed");
    expect(final.reason).toBe("wall-clock-exceeded");
  }, 15_000);
});
