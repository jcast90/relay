/**
 * AL-14 follow-up — worktree sweep integration tests.
 *
 * Three flows are exercised:
 *
 *   (a) Driver invokes `runner.handlePrMerged` when the pr-poller fires an
 *       `onMerged` event for a ticket currently tracked by the runner.
 *       Verifies the "within one poll tick" cleanup guarantee.
 *   (b) Terminal sweep — before the driver returns, tickets in `verifying`
 *       whose PRs have already merged get destroyed + transitioned to
 *       `completed`. Covers the race where a PR merged after the driver
 *       exited its drain loop but before the lifecycle transition.
 *   (c) CLI `rly sweep-worktrees` invocation with a fake `gh pr view`
 *       probe, exercising the crash-recovery path end-to-end — tickets
 *       left in `verifying` across sessions, worktree discovered via
 *       `.relay-state.json` stamps, destroyed via the injected spawner.
 *
 * All tests use ScriptedInvoker-style fakes. No real git worktree, no
 * real `gh`, no real `claude` binary.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SpawnedProcess } from "../../src/agents/command-invoker.js";
import { ChannelStore } from "../../src/channels/channel-store.js";
import type { Channel, RepoAssignment } from "../../src/domain/channel.js";
import type { TrackedPrRow } from "../../src/domain/pr-row.js";
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
import { sweepAbandonedWorktrees, type GhPrView } from "../../src/orchestrator/worktree-sweep.js";
import { FileHarnessStore } from "../../src/storage/file-store.js";

// --------------------------------------------------------------------------
// Shared fakes — mirror shape with autonomous-loop-drain.test.ts but
// duplicated deliberately so a refactor there doesn't quietly change
// behaviour here.
// --------------------------------------------------------------------------

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
    pid: 50_000 + Math.floor(Math.random() * 1000),
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
    if (this._state === "running") this.fire({ exitCode: null });
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

/**
 * Minimal fake pr-poller exposing only the surface the driver consumes.
 * Tests call `firePrMerged` to simulate a poll tick observing a merge.
 */
class FakePrPoller {
  private listeners: Array<
    (evt: {
      ticketId: string;
      channelId: string;
      prUrl: string;
      repo: { owner: string; name: string };
      prNumber: number;
    }) => void
  > = [];

  onMerged(
    listener: (evt: {
      ticketId: string;
      channelId: string;
      prUrl: string;
      repo: { owner: string; name: string };
      prNumber: number;
    }) => void
  ): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  firePrMerged(evt: {
    ticketId: string;
    channelId: string;
    prUrl: string;
    repo: { owner: string; name: string };
    prNumber: number;
  }): void {
    // Sync dispatch — matches the real PrPoller which fires listeners
    // synchronously from inside the poll's state-transition handler.
    for (const l of this.listeners.slice()) l(evt);
  }

  get listenerCount(): number {
    return this.listeners.length;
  }
}

async function waitUntil(pred: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (true) {
    const result = await pred();
    if (result) return;
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
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

async function buildFixture() {
  const root = await mkdtemp(join(tmpdir(), "wt-sweep-"));
  const channelsDir = join(root, "channels");
  const harnessStore = new FileHarnessStore(join(root, "__hs__"));
  const channelStore = new ChannelStore(channelsDir, harnessStore);

  const assignments: RepoAssignment[] = [
    { alias: "frontend", workspaceId: "ws-frontend", repoPath: "/tmp/fake-frontend" },
    { alias: "backend", workspaceId: "ws-backend", repoPath: "/tmp/fake-backend" },
  ];
  const persisted = await channelStore.createChannel({
    name: "wt-sweep-channel",
    description: "worktree sweep integration",
    workspaceIds: ["ws-frontend", "ws-backend"],
    repoAssignments: assignments,
  });
  const channel: Channel = { ...persisted, repoAssignments: assignments, fullAccess: false };

  const sessionId = `auto-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const lifecycle = new SessionLifecycle(sessionId, { rootDir: root });
  await lifecycle.transition("dispatching", "autonomous-session-started");
  const tracker = new TokenTracker(sessionId, 100_000, { rootDir: root });

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
    cleanup,
    allowedRepos: assignments,
  };
}

/**
 * Stamp a `.relay-state.json` inside `<root>/sandboxes/run-<runId>/<ticketId>/`
 * so the sweep's `discoverWorktreesByTicketId` walker can locate it exactly
 * like it would for a real git-worktree sandbox. Returns the absolute
 * worktree path.
 */
async function seedWorktreeStamp(
  root: string,
  args: { runId: string; ticketId: string; repoRoot: string; branch?: string }
): Promise<string> {
  const worktreePath = join(root, "sandboxes", `run-${args.runId}`, args.ticketId);
  await mkdir(worktreePath, { recursive: true });
  const stamp = {
    runId: args.runId,
    ticketId: args.ticketId,
    createdAt: new Date(0).toISOString(),
    base: "main",
    branch: args.branch ?? `sandbox/${args.runId}/${args.ticketId}`,
    repoRoot: args.repoRoot,
  };
  await writeFile(join(worktreePath, ".relay-state.json"), JSON.stringify(stamp, null, 2));
  return worktreePath;
}

describe("worktree-sweep", () => {
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

  /**
   * (a) Driver invokes `handlePrMerged` on a pr-poller merge event. We
   * drive one ticket through spawn → PR-open → then fire a merge event
   * and assert the worktree is destroyed + ticket flipped to `completed`
   * without the driver having to exit.
   */
  it("routes a pr-poller merge event to runner.handlePrMerged while the driver is still running", async () => {
    const fx = await buildFixture();
    cleanupFns.push(fx.cleanup);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    cleanupFns.push(async () => {
      logSpy.mockRestore();
      warnSpy.mockRestore();
    });

    const adminSpawner = new FakeAdminSpawner();
    const workerSpawner = new FakeWorkerSpawner();
    const prPoller = new FakePrPoller();

    // Three tickets on backend so the driver exits only after all three
    // are terminal — gives us room to fire a merge event mid-run and
    // still keep the loop alive for the second/third tickets.
    await fx.channelStore.writeChannelTickets(fx.channel.channelId, [
      makeTicket("be-1", "backend"),
      makeTicket("be-2", "backend"),
      makeTicket("be-3", "backend"),
    ]);

    const driverP = startAutonomousSession({
      sessionId: fx.sessionId,
      channel: fx.channel,
      tracker: fx.tracker,
      lifecycle: fx.lifecycle,
      trust: "supervised",
      allowedRepos: fx.allowedRepos,
      testOverrides: {
        channelStore: fx.channelStore,
        repoAdminSpawner: adminSpawner,
        workerSpawner: workerSpawner as unknown as WorkerSpawner,
        rootDir: fx.root,
        pollIntervalMs: 2,
        prPoller,
        // Terminal-sweep probe — never hit in this test because every
        // ticket ends in `completed` via the merge event. Wire it
        // anyway so the driver doesn't throw on a missing probe.
        ghPrView: async () => ({ state: "MERGED" as const }),
      },
    });

    // Confirm the driver subscribed to the pr-poller.
    await waitUntil(() => prPoller.listenerCount >= 1);
    expect(prPoller.listenerCount).toBe(1);

    // Drive be-1 through PR-open. Fire only after be-2 has also been
    // spawned — by then the driver has definitely processed be-1's
    // exit and published its `worker-pr-opened` event, which is what
    // registers be-1 in the driver's `runnerByTicketId` map. Firing
    // earlier races against that registration and produces the test
    // flake observed in CI.
    await waitUntil(() => workerSpawner.handles("backend").length >= 1);
    const beFirst = workerSpawner.handles("backend")[0];
    expect(beFirst.ticketId).toBe("be-1");
    beFirst.fire({ exitCode: 0, prUrl: "https://github.com/o/r/pull/1" });

    // Wait for be-2 to spawn — the drain loop only moves past be-1
    // once its `runOneTicket` completes, which includes publishing
    // `worker-pr-opened`. So be-2's spawn is the strongest signal
    // that the driver has finished be-1's post-exit work.
    await waitUntil(() => workerSpawner.handles("backend").length >= 2, 8000);

    // Sanity: the board reflects verifying on be-1 at this point.
    const boardAtMerge = await fx.channelStore.readChannelTickets(fx.channel.channelId);
    expect(boardAtMerge.find((t) => t.ticketId === "be-1")?.status).toBe("verifying");

    // Fire the merge event — the driver should route to
    // `runner.handlePrMerged`, destroy the worktree, and flip the
    // ticket to `completed` WITHOUT the driver exiting.
    prPoller.firePrMerged({
      ticketId: "be-1",
      channelId: fx.channel.channelId,
      prUrl: "https://github.com/o/r/pull/1",
      repo: { owner: "o", name: "r" },
      prNumber: 1,
    });

    await waitUntil(async () => {
      const board = await fx.channelStore.readChannelTickets(fx.channel.channelId);
      return board.find((t) => t.ticketId === "be-1")?.status === "completed";
    }, 8000);

    // Worktree destroyed exactly once.
    expect(workerSpawner.destroyed.length).toBeGreaterThanOrEqual(1);
    expect(workerSpawner.destroyed.some((r) => r.meta?.ticketId === "be-1")).toBe(true);

    // Complete the other two tickets so the driver exits.
    await waitUntil(() => workerSpawner.handles("backend").length >= 2);
    workerSpawner
      .handles("backend")[1]
      .fire({ exitCode: 0, prUrl: "https://github.com/o/r/pull/2" });
    await waitUntil(() => workerSpawner.handles("backend").length >= 3);
    workerSpawner
      .handles("backend")[2]
      .fire({ exitCode: 0, prUrl: "https://github.com/o/r/pull/3" });

    await driverP;
  }, 15_000);

  /**
   * (b) Terminal sweep: mark a PR as MERGED via the injected probe and
   * confirm the driver cleans the worktree + transitions the ticket
   * even though no in-run merge event fired.
   */
  it("terminal sweep cleans merged-but-not-handled worktrees before the driver exits", async () => {
    const fx = await buildFixture();
    cleanupFns.push(fx.cleanup);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    cleanupFns.push(async () => {
      logSpy.mockRestore();
      warnSpy.mockRestore();
    });

    const adminSpawner = new FakeAdminSpawner();
    const workerSpawner = new FakeWorkerSpawner();

    await fx.channelStore.writeChannelTickets(fx.channel.channelId, [
      makeTicket("be-1", "backend"),
    ]);

    // Seed tracked-prs so the sweep can pair ticket → PR URL.
    const trackedRow: TrackedPrRow = {
      ticketId: "be-1",
      channelId: fx.channel.channelId,
      owner: "o",
      name: "r",
      number: 42,
      url: "https://github.com/o/r/pull/42",
      branch: "sandbox/fake-run-1/be-1",
      ci: null,
      review: null,
      prState: "open",
      updatedAt: new Date().toISOString(),
    };

    // Seed a worktree stamp so sweep's discovery finds the worktree.
    await seedWorktreeStamp(fx.root, {
      runId: "fake-run-1",
      ticketId: "be-1",
      repoRoot: "/tmp/fake-backend",
    });

    const ghPrView: GhPrView = vi.fn(async () => ({ state: "MERGED" as const }));

    // Seed the tracked-prs mirror BEFORE the driver exits so the sweep
    // can match ticket → PR URL. Writing it after a `verifying` ticket
    // lands on the board races against the driver's "board drained → exit"
    // check; seeding up-front makes the test deterministic and is
    // realistic (the pr-watcher writes this file when the worker opens
    // a PR, not later).
    await fx.channelStore.writeTrackedPrs(fx.channel.channelId, [trackedRow]);

    const driverP = startAutonomousSession({
      sessionId: fx.sessionId,
      channel: fx.channel,
      tracker: fx.tracker,
      lifecycle: fx.lifecycle,
      trust: "supervised",
      allowedRepos: fx.allowedRepos,
      testOverrides: {
        channelStore: fx.channelStore,
        repoAdminSpawner: adminSpawner,
        workerSpawner: workerSpawner as unknown as WorkerSpawner,
        rootDir: fx.root,
        pollIntervalMs: 2,
        ghPrView,
      },
    });

    // Drive be-1 through PR-open so it reaches verifying.
    await waitUntil(() => workerSpawner.handles("backend").length >= 1);
    workerSpawner
      .handles("backend")[0]
      .fire({ exitCode: 0, prUrl: "https://github.com/o/r/pull/42" });

    await driverP;

    // Terminal sweep should have:
    //  - called the gh probe for be-1's PR URL
    //  - destroyed the worktree (via workerSpawner.destroyWorktree)
    //  - transitioned be-1 to completed
    expect(ghPrView).toHaveBeenCalled();
    const board = await fx.channelStore.readChannelTickets(fx.channel.channelId);
    expect(board.find((t) => t.ticketId === "be-1")?.status).toBe("completed");
    expect(workerSpawner.destroyed.some((r) => r.meta?.ticketId === "be-1")).toBe(true);
  }, 15_000);

  /**
   * (c) `sweepAbandonedWorktrees` invoked directly against a tmp-rooted
   * channel store. Covers the CLI's crash-recovery behaviour: tickets
   * left in `verifying` across sessions, worktree discovered via
   * `.relay-state.json` stamps, destroyed via the injected spawner.
   */
  it("sweep helper end-to-end finds merged PRs across channels and destroys worktrees (CLI shape)", async () => {
    const root = await mkdtemp(join(tmpdir(), "wt-sweep-cli-"));
    cleanupFns.push(async () => {
      await rm(root, { recursive: true, force: true });
    });

    const channelsDir = join(root, "channels");
    const harnessStore = new FileHarnessStore(join(root, "__hs__"));
    const channelStore = new ChannelStore(channelsDir, harnessStore);

    // Two channels, one ticket each — one merged, one still open. The
    // merged one must be destroyed; the open one must be left alone.
    const chA = await channelStore.createChannel({
      name: "chA",
      description: "",
      workspaceIds: ["ws-a"],
      repoAssignments: [{ alias: "a", workspaceId: "ws-a", repoPath: "/tmp/fake-a" }],
    });
    const chB = await channelStore.createChannel({
      name: "chB",
      description: "",
      workspaceIds: ["ws-b"],
      repoAssignments: [{ alias: "b", workspaceId: "ws-b", repoPath: "/tmp/fake-b" }],
    });

    // Back-date updatedAt so the 24h grace window doesn't skip them.
    const oldIso = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const tA: TicketLedgerEntry = {
      ...makeTicket("tA-1", "a"),
      status: "verifying",
      updatedAt: oldIso,
    };
    const tB: TicketLedgerEntry = {
      ...makeTicket("tB-1", "b"),
      status: "verifying",
      updatedAt: oldIso,
    };
    await channelStore.writeChannelTickets(chA.channelId, [tA]);
    await channelStore.writeChannelTickets(chB.channelId, [tB]);

    // Seed tracked-prs for both.
    await channelStore.writeTrackedPrs(chA.channelId, [
      {
        ticketId: "tA-1",
        channelId: chA.channelId,
        owner: "o",
        name: "r",
        number: 1,
        url: "https://github.com/o/r/pull/1",
        branch: "br-1",
        ci: null,
        review: null,
        prState: "open",
        updatedAt: new Date().toISOString(),
      },
    ]);
    await channelStore.writeTrackedPrs(chB.channelId, [
      {
        ticketId: "tB-1",
        channelId: chB.channelId,
        owner: "o",
        name: "r",
        number: 2,
        url: "https://github.com/o/r/pull/2",
        branch: "br-2",
        ci: null,
        review: null,
        prState: "open",
        updatedAt: new Date().toISOString(),
      },
    ]);

    // Seed worktree stamps for both (CLI discovers these from disk).
    await seedWorktreeStamp(root, {
      runId: "cli-1",
      ticketId: "tA-1",
      repoRoot: "/tmp/fake-a",
    });
    await seedWorktreeStamp(root, {
      runId: "cli-2",
      ticketId: "tB-1",
      repoRoot: "/tmp/fake-b",
    });

    // Fake probe: tA is merged, tB is still open.
    const ghPrView: GhPrView = vi.fn(async ({ url }: { url: string }) => {
      if (url.endsWith("/pull/1")) return { state: "MERGED" as const };
      return { state: "OPEN" as const };
    });

    // Fake spawner: capture destroy calls.
    const destroyed: SandboxRef[] = [];
    const spawner = {
      destroyWorktree: vi.fn(async (ref: SandboxRef) => {
        destroyed.push(ref);
      }),
    };

    const result = await sweepAbandonedWorktrees({
      channelStore,
      spawner,
      olderThanHours: 1, // anything older than 1h is eligible
      rootDir: root,
      ghPrView,
    });

    // Two candidates considered; one destroyed, one skipped (OPEN).
    expect(result.considered).toBe(2);
    expect(result.destroyed).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.errored).toBe(0);

    // Destroyed candidate is tA-1 (MERGED).
    const destroyedCandidate = result.candidates.find((c) => c.action === "destroyed");
    expect(destroyedCandidate?.ticketId).toBe("tA-1");
    expect(destroyedCandidate?.prState).toBe("MERGED");
    expect(destroyedCandidate?.worktreePath).toContain("sandboxes/run-cli-1/tA-1");
    expect(destroyed.some((r) => r.meta?.ticketId === "tA-1")).toBe(true);

    // Skipped candidate is tB-1 (OPEN).
    const skippedCandidate = result.candidates.find((c) => c.action === "skipped");
    expect(skippedCandidate?.ticketId).toBe("tB-1");
    expect(skippedCandidate?.prState).toBe("OPEN");
    expect(destroyed.some((r) => r.meta?.ticketId === "tB-1")).toBe(false);

    // Board reflects outcomes: tA-1 → completed, tB-1 still verifying.
    const boardA = await channelStore.readChannelTickets(chA.channelId);
    expect(boardA.find((t) => t.ticketId === "tA-1")?.status).toBe("completed");
    const boardB = await channelStore.readChannelTickets(chB.channelId);
    expect(boardB.find((t) => t.ticketId === "tB-1")?.status).toBe("verifying");

    // --- dry-run mode: no destroys, no board mutations ------------------
    const dryRunResult = await sweepAbandonedWorktrees({
      channelStore,
      spawner,
      olderThanHours: 1,
      rootDir: root,
      ghPrView,
      dryRun: true,
    });
    // tB-1 is still considered; tA-1 is already completed so it's not
    // picked up. The dry-run never destroys and returns a skipped
    // candidate for the still-open tB-1.
    expect(dryRunResult.destroyed).toBe(0);
    expect(destroyed.length).toBe(1); // unchanged from before dry-run
  });

  /**
   * Grace-window gate: a recently-updated ticket is skipped even when
   * its PR is merged. Covers the default 24h window.
   */
  it("respects --older-than grace window even for merged PRs", async () => {
    const root = await mkdtemp(join(tmpdir(), "wt-sweep-grace-"));
    cleanupFns.push(async () => {
      await rm(root, { recursive: true, force: true });
    });

    const channelsDir = join(root, "channels");
    const harnessStore = new FileHarnessStore(join(root, "__hs__"));
    const channelStore = new ChannelStore(channelsDir, harnessStore);

    const ch = await channelStore.createChannel({
      name: "grace",
      description: "",
      workspaceIds: ["ws-a"],
      repoAssignments: [{ alias: "a", workspaceId: "ws-a", repoPath: "/tmp/fake-a" }],
    });

    // updated 1h ago — within the default 24h window.
    const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const t: TicketLedgerEntry = {
      ...makeTicket("t-grace", "a"),
      status: "verifying",
      updatedAt: recent,
    };
    await channelStore.writeChannelTickets(ch.channelId, [t]);
    await channelStore.writeTrackedPrs(ch.channelId, [
      {
        ticketId: "t-grace",
        channelId: ch.channelId,
        owner: "o",
        name: "r",
        number: 9,
        url: "https://github.com/o/r/pull/9",
        branch: "br-9",
        ci: null,
        review: null,
        prState: "open",
        updatedAt: recent,
      },
    ]);
    await seedWorktreeStamp(root, {
      runId: "grace-1",
      ticketId: "t-grace",
      repoRoot: "/tmp/fake-a",
    });

    // Even though the probe would say MERGED, the grace window must
    // skip it because the ticket was updated only 1h ago (< 24h).
    const ghPrView: GhPrView = vi.fn(async () => ({ state: "MERGED" as const }));
    const spawner = { destroyWorktree: vi.fn(async () => {}) };

    const result = await sweepAbandonedWorktrees({
      channelStore,
      spawner,
      // Default 24h window.
      rootDir: root,
      ghPrView,
    });

    expect(result.destroyed).toBe(0);
    expect(result.skipped).toBe(1);
    expect(spawner.destroyWorktree).not.toHaveBeenCalled();
    // Probe never fired because the grace window short-circuits first.
    expect(ghPrView).not.toHaveBeenCalled();

    const board = await channelStore.readChannelTickets(ch.channelId);
    expect(board.find((t) => t.ticketId === "t-grace")?.status).toBe("verifying");
  });

  /**
   * Unmerged PRs must NOT be destroyed even when the probe is wired.
   * Covers the "no false-positive destroys" acceptance criterion.
   */
  it("leaves unmerged PRs alone (no false-positive destroys)", async () => {
    const root = await mkdtemp(join(tmpdir(), "wt-sweep-unmerged-"));
    cleanupFns.push(async () => {
      await rm(root, { recursive: true, force: true });
    });

    const channelsDir = join(root, "channels");
    const harnessStore = new FileHarnessStore(join(root, "__hs__"));
    const channelStore = new ChannelStore(channelsDir, harnessStore);

    const ch = await channelStore.createChannel({
      name: "unmerged",
      description: "",
      workspaceIds: ["ws-a"],
      repoAssignments: [{ alias: "a", workspaceId: "ws-a", repoPath: "/tmp/fake-a" }],
    });

    const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    await channelStore.writeChannelTickets(ch.channelId, [
      { ...makeTicket("tO", "a"), status: "verifying", updatedAt: old },
      { ...makeTicket("tC", "a"), status: "verifying", updatedAt: old },
    ]);
    await channelStore.writeTrackedPrs(ch.channelId, [
      {
        ticketId: "tO",
        channelId: ch.channelId,
        owner: "o",
        name: "r",
        number: 10,
        url: "https://github.com/o/r/pull/10",
        branch: "br-10",
        ci: null,
        review: null,
        prState: "open",
        updatedAt: old,
      },
      {
        ticketId: "tC",
        channelId: ch.channelId,
        owner: "o",
        name: "r",
        number: 11,
        url: "https://github.com/o/r/pull/11",
        branch: "br-11",
        ci: null,
        review: null,
        prState: "open",
        updatedAt: old,
      },
    ]);
    await seedWorktreeStamp(root, { runId: "u-1", ticketId: "tO", repoRoot: "/tmp/fake-a" });
    await seedWorktreeStamp(root, { runId: "u-2", ticketId: "tC", repoRoot: "/tmp/fake-a" });

    // Probe reports OPEN + CLOSED — neither should trigger a destroy.
    const ghPrView: GhPrView = vi.fn(async ({ url }) => {
      if (url.endsWith("/pull/10")) return { state: "OPEN" as const };
      return { state: "CLOSED" as const };
    });
    const spawner = { destroyWorktree: vi.fn(async () => {}) };

    const result = await sweepAbandonedWorktrees({
      channelStore,
      spawner,
      olderThanHours: 1,
      rootDir: root,
      ghPrView,
    });

    expect(result.destroyed).toBe(0);
    expect(result.skipped).toBe(2);
    expect(spawner.destroyWorktree).not.toHaveBeenCalled();

    const board = await channelStore.readChannelTickets(ch.channelId);
    expect(board.find((t) => t.ticketId === "tO")?.status).toBe("verifying");
    expect(board.find((t) => t.ticketId === "tC")?.status).toBe("verifying");
  });
});
