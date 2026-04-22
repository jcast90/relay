/**
 * AL-14 — autonomous-loop drain wiring integration tests.
 *
 * Covers the end-to-end plumbing that `startAutonomousSession` does when
 * both `RELAY_REPO_ADMIN_POOL_ENABLED` and `RELAY_AL14_WORKER_DRAIN` are
 * on. Specifically the pieces that aren't exercised by the `TicketRunner`
 * unit tests (one admin, one fake) or the `RepoAdminPool` tests (no
 * router, no runner, no worker-spawn mock):
 *
 *   - Two repoAssignments → two admins boot. Both admins get their own
 *     `TicketRunner`.
 *   - Each admin's pending queue drains in parallel — the `Promise.all`
 *     invariant is observable: both admins' first tickets are in-flight
 *     simultaneously, neither blocking the other.
 *   - Each admin drains its own queue sequentially (per-admin FIFO).
 *   - On exit, the lifecycle transitions to `killed` with reason
 *     `al-16-pending` when the drain flag is on (AL-14 terminal).
 *   - The `finally` block's `runner.stop("autonomous-loop-exit")` fires
 *     even on error, and a single admin's drain failure does NOT wedge
 *     the other admin — the healthy admin still completes its ticket.
 *
 * The test uses the `startAutonomousSession`'s `testOverrides` seam to
 * inject a fake `RepoAdminProcessSpawner` (so the AL-12 pool boots
 * cleanly without a real Claude binary) and a fake `WorkerSpawner` (so
 * worker drain is deterministic). No real subprocess, no real git, no
 * real `claude` CLI.
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

/**
 * Fake AL-12 repo-admin child. No-op on all streams; `emitExit` is only
 * invoked when the pool is tearing down.
 */
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
    pid: 30_000 + Math.floor(Math.random() * 1000),
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
      // Emit expected exit so the pool's stop() awaits resolve cleanly.
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

/**
 * Fake worker handle driven by the test. Identical in shape to the one
 * used by `ticket-runner.test.ts`, reproduced here so these tests stay
 * hermetic (no shared-fixture coupling).
 */
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

/**
 * Programmable worker-spawner. Exposes the spawned handles per alias so
 * the test can assert on parallel invariants ("both admins' first ticket
 * spawned before either finished"). `onSpawn` callbacks let the test
 * observe the exact moment a spawn lands so parallel assertions don't
 * race.
 */
class FakeWorkerSpawner {
  readonly spawnedByAlias = new Map<string, FakeWorkerHandle[]>();
  readonly destroyed: SandboxRef[] = [];
  private counter = 0;
  private onSpawnListeners: Array<
    (args: { alias: string; ticketId: string; handle: FakeWorkerHandle }) => void
  > = [];

  onSpawn(cb: (args: { alias: string; ticketId: string; handle: FakeWorkerHandle }) => void): void {
    this.onSpawnListeners.push(cb);
  }

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
      for (const cb of this.onSpawnListeners) cb({ alias, ticketId, handle });
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

/**
 * Spin until `pred()` returns truthy. Tests that assert on async
 * interleavings call this in preference to polling sleep so the failure
 * mode on a stuck async op is a clean timeout rather than a flaky pass.
 */
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

/**
 * Seed the on-disk channel with two repo assignments + two tickets per
 * admin. Tickets carry `assignedAlias` so the router deterministically
 * dispatches them to their matching admin.
 */
async function buildFixture() {
  const root = await mkdtemp(join(tmpdir(), "al-14-drain-"));
  const channelsDir = join(root, "channels");
  const harnessStore = new FileHarnessStore(join(root, "__hs__"));
  const channelStore = new ChannelStore(channelsDir, harnessStore);

  const assignments: RepoAssignment[] = [
    { alias: "frontend", workspaceId: "ws-frontend", repoPath: "/tmp/fake-frontend" },
    { alias: "backend", workspaceId: "ws-backend", repoPath: "/tmp/fake-backend" },
  ];
  const persisted = await channelStore.createChannel({
    name: "al-14-drain",
    description: "al-14 drain integration test",
    workspaceIds: ["ws-frontend", "ws-backend"],
    repoAssignments: assignments,
  });
  const channel: Channel = {
    ...persisted,
    repoAssignments: assignments,
    fullAccess: false,
  };

  const tickets: TicketLedgerEntry[] = [
    makeTicket("fe-1", "frontend"),
    makeTicket("fe-2", "frontend"),
    makeTicket("be-1", "backend"),
    makeTicket("be-2", "backend"),
  ];
  await channelStore.writeChannelTickets(channel.channelId, tickets);

  const sessionId = `auto-${Date.now()}`;
  const lifecycle = new SessionLifecycle(sessionId, { rootDir: root });
  // Matches the real CLI flow: start in planning, advance to dispatching
  // before handoff. SessionLifecycle initializes in `planning`, so the
  // only transition we need to mirror is `planning → dispatching`.
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

describe("startAutonomousSession — AL-14 drain wiring", () => {
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

  it("drains both admins in parallel, each serializes internally, and exits killed/al-16-pending", async () => {
    const fx = await buildFixture();
    cleanupFns.push(fx.cleanup);

    // Suppress info console noise from the loop — we only want warnings.
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    cleanupFns.push(async () => {
      logSpy.mockRestore();
      warnSpy.mockRestore();
    });

    // Fire the autonomous driver. It bootstraps pool, routes tickets,
    // then starts parallel drains.
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
      },
    });

    // PARALLEL INVARIANT: both admins must have spawned their FIRST
    // ticket before EITHER has completed. If the drains were serialized
    // at the pool level, we'd see one admin's spawn only.
    await waitUntil(
      () =>
        fx.workerSpawner.handles("frontend").length >= 1 &&
        fx.workerSpawner.handles("backend").length >= 1
    );
    expect(fx.workerSpawner.handles("frontend")).toHaveLength(1);
    expect(fx.workerSpawner.handles("backend")).toHaveLength(1);
    // Per-admin FIFO invariant: the first spawn for each admin is the
    // first ticket assigned to it.
    expect(fx.workerSpawner.handles("frontend")[0].ticketId).toBe("fe-1");
    expect(fx.workerSpawner.handles("backend")[0].ticketId).toBe("be-1");

    // SERIALIZATION INVARIANT: neither admin has spawned its second
    // ticket — their first hasn't exited yet.
    expect(fx.workerSpawner.handles("frontend")).toHaveLength(1);
    expect(fx.workerSpawner.handles("backend")).toHaveLength(1);

    // Complete fe-1 and be-1 so each admin progresses to its second
    // ticket (fe-2 / be-2 respectively). PR URLs are distinct so the
    // verifying-state mirror on the board doesn't collide.
    fx.workerSpawner
      .handles("frontend")[0]
      .fire({ exitCode: 0, prUrl: "https://github.com/o/r/pull/1" });
    fx.workerSpawner
      .handles("backend")[0]
      .fire({ exitCode: 0, prUrl: "https://github.com/o/r/pull/2" });

    await waitUntil(
      () =>
        fx.workerSpawner.handles("frontend").length >= 2 &&
        fx.workerSpawner.handles("backend").length >= 2
    );
    expect(fx.workerSpawner.handles("frontend")[1].ticketId).toBe("fe-2");
    expect(fx.workerSpawner.handles("backend")[1].ticketId).toBe("be-2");

    // Complete the second ticket on each admin.
    fx.workerSpawner
      .handles("frontend")[1]
      .fire({ exitCode: 0, prUrl: "https://github.com/o/r/pull/3" });
    fx.workerSpawner
      .handles("backend")[1]
      .fire({ exitCode: 0, prUrl: "https://github.com/o/r/pull/4" });

    await driverP;

    // LIFECYCLE INVARIANT: drain flag on → `killed / al-16-pending`.
    const lcRaw = await readFile(join(fx.root, "sessions", fx.sessionId, "lifecycle.json"), "utf8");
    const lc = JSON.parse(lcRaw);
    expect(lc.state).toBe("killed");
    const final = lc.transitions[lc.transitions.length - 1];
    expect(final.reason).toBe("al-16-pending");

    // TICKET-STATE INVARIANT: each ticket that drove a spawn was
    // mirrored through upsertChannelTickets. All four move to
    // `verifying` (worker exited 0 with PR URL).
    const board = await fx.channelStore.readChannelTickets(fx.channel.channelId);
    const byId = Object.fromEntries(board.map((t) => [t.ticketId, t]));
    expect(byId["fe-1"].status).toBe("verifying");
    expect(byId["fe-2"].status).toBe("verifying");
    expect(byId["be-1"].status).toBe("verifying");
    expect(byId["be-2"].status).toBe("verifying");

    // SPAWN-COUNT INVARIANT: exactly one spawn per ticket (no retries,
    // no duplicates).
    expect(fx.workerSpawner.spawn).toHaveBeenCalledTimes(4);
  }, 10_000);

  it("one admin's drain failure does NOT wedge the other admin's drain", async () => {
    const fx = await buildFixture();
    cleanupFns.push(fx.cleanup);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    cleanupFns.push(async () => {
      logSpy.mockRestore();
      warnSpy.mockRestore();
    });

    // Make the very first spawn for alias "frontend" throw. The runner
    // catches spawn failures and marks the ticket failed — that's the
    // "drain error path" the review calls out. The key assertion is
    // that "backend" still makes forward progress.
    const origSpawn = fx.workerSpawner.spawn;
    fx.workerSpawner.spawn = vi.fn(async (opts) => {
      if (opts.repoAssignment.alias === "frontend" && opts.ticket.ticketId === "fe-1") {
        throw new Error("synthetic spawn failure for fe-1");
      }
      return origSpawn.call(fx.workerSpawner, opts);
    }) as typeof fx.workerSpawner.spawn;

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
      },
    });

    // Backend's first ticket must spawn independently of frontend's
    // failure. This is the key "parallel drains are isolated"
    // invariant: one admin throwing doesn't lock out the other.
    await waitUntil(() => fx.workerSpawner.handles("backend").length >= 1);
    // Complete be-1 → be-2 chain.
    fx.workerSpawner
      .handles("backend")[0]
      .fire({ exitCode: 0, prUrl: "https://github.com/o/r/pull/b1" });
    await waitUntil(() => fx.workerSpawner.handles("backend").length >= 2);
    fx.workerSpawner
      .handles("backend")[1]
      .fire({ exitCode: 0, prUrl: "https://github.com/o/r/pull/b2" });

    // Frontend: fe-1 failed synthetically, so drain moves to fe-2.
    // fe-2 spawns via the original spawner and we finish it normally.
    await waitUntil(() => fx.workerSpawner.handles("frontend").length >= 1);
    expect(fx.workerSpawner.handles("frontend")[0].ticketId).toBe("fe-2");
    fx.workerSpawner
      .handles("frontend")[0]
      .fire({ exitCode: 0, prUrl: "https://github.com/o/r/pull/f2" });

    await driverP;

    // Terminal lifecycle still reaches killed/al-16-pending — the
    // synthetic failure did not abort the autonomous loop, it just
    // routed one ticket into the `failed` bucket.
    const lcRaw = await readFile(join(fx.root, "sessions", fx.sessionId, "lifecycle.json"), "utf8");
    const lc = JSON.parse(lcRaw);
    expect(lc.state).toBe("killed");
    expect(lc.transitions[lc.transitions.length - 1].reason).toBe("al-16-pending");

    // TICKET-STATE INVARIANTS:
    //  - fe-1 is `failed` (spawn threw → runner.markTicketFailed)
    //  - fe-2 / be-1 / be-2 are `verifying` (clean drains)
    const board = await fx.channelStore.readChannelTickets(fx.channel.channelId);
    const byId = Object.fromEntries(board.map((t) => [t.ticketId, t]));
    expect(byId["fe-1"].status).toBe("failed");
    expect(byId["fe-1"].lastClassification?.category).toBe("fix_code");
    expect(byId["fe-2"].status).toBe("verifying");
    expect(byId["be-1"].status).toBe("verifying");
    expect(byId["be-2"].status).toBe("verifying");
  }, 10_000);

  it("drain-disabled mode (pool flag on, drain flag off) routes but does not spawn workers", async () => {
    process.env[RELAY_AL14_WORKER_DRAIN] = "0";
    const fx = await buildFixture();
    cleanupFns.push(fx.cleanup);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    cleanupFns.push(async () => {
      logSpy.mockRestore();
      warnSpy.mockRestore();
    });

    await startAutonomousSession({
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
      },
    });

    // No worker spawns — drain was gated off.
    expect(fx.workerSpawner.spawn).not.toHaveBeenCalled();

    // Lifecycle reaches killed with reason `al-14-pending` (pool on, drain off).
    const lcRaw = await readFile(join(fx.root, "sessions", fx.sessionId, "lifecycle.json"), "utf8");
    const lc = JSON.parse(lcRaw);
    expect(lc.state).toBe("killed");
    expect(lc.transitions[lc.transitions.length - 1].reason).toBe("al-14-pending");
  });
});
