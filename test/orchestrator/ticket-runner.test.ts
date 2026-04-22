/**
 * AL-14 — TicketRunner unit tests.
 *
 * Covers the per-ticket drain loop in isolation:
 *  - serialization inside one admin (AC: serialize)
 *  - PR-merge cleanup destroys worktree + marks ticket completed (AC3)
 *  - worker failure surfaces on the feed + emits `worker-failed`; worktree
 *    is NOT destroyed on failure (AC4)
 *  - PR-URL fallback probe is invoked when stdout scrape misses
 *  - stop() terminates in-flight workers without destroying worktrees
 *
 * Uses fake WorkerSpawner + fake admin.pendingDispatches so no real git
 * or claude binary is involved.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChannelStore } from "../../src/channels/channel-store.js";
import type { Channel, RepoAssignment } from "../../src/domain/channel.js";
import type { TicketLedgerEntry } from "../../src/domain/ticket.js";
import type { SandboxRef } from "../../src/execution/sandbox.js";
import type { RepoAdminSession } from "../../src/orchestrator/repo-admin-session.js";
import { TicketRunner } from "../../src/orchestrator/ticket-runner.js";
import type {
  WorkerExitEvent,
  WorkerHandle,
  WorkerSpawner,
} from "../../src/orchestrator/worker-spawner.js";
import { FileHarnessStore } from "../../src/storage/file-store.js";

/**
 * Minimal admin stub — only the API the runner actually uses
 * (`takeNextPendingTicket`) is exercised, so we don't need the full
 * RepoAdminSession machinery.
 */
class FakeAdmin {
  readonly alias: string;
  readonly queue: TicketLedgerEntry[] = [];

  constructor(alias: string) {
    this.alias = alias;
  }

  enqueue(ticket: TicketLedgerEntry): void {
    this.queue.push(ticket);
  }

  takeNextPendingTicket(): TicketLedgerEntry | null {
    return this.queue.shift() ?? null;
  }
}

/**
 * Programmable fake worker handle. Tests drive exit via `fire()`.
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
  readonly stopCalls: string[] = [];

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
    // Replay final event to late subscribers, mirroring LiveWorkerHandle.
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

  stop = vi.fn(async (reason: string): Promise<void> => {
    this.stopCalls.push(reason);
    if (this._state === "running") {
      this.fire({ exitCode: null, signal: "SIGTERM", stdoutTail: "", stderrTail: "", prUrl: null });
    }
  });

  fire(args: {
    exitCode: number | null;
    signal?: NodeJS.Signals | null;
    stdoutTail?: string;
    stderrTail?: string;
    prUrl?: string | null;
  }): void {
    if (this.finalEvent) return; // idempotent
    this._prUrl = args.prUrl ?? null;
    const evt: WorkerExitEvent = {
      exitCode: args.exitCode,
      signal: args.signal ?? null,
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
 * Fake spawner: deterministic worktree + sandbox refs; exposes every
 * handle it created so tests can drive exits.
 */
class FakeSpawner {
  readonly spawned: FakeWorkerHandle[] = [];
  readonly destroyed: SandboxRef[] = [];
  private counter = 0;

  spawn = vi.fn(
    async (opts: {
      ticket: TicketLedgerEntry;
      repoAssignment: RepoAssignment;
      channel: Channel;
    }) => {
      this.counter += 1;
      const runId = `run-${this.counter}`;
      const ticketId = opts.ticket.ticketId;
      const worktreePath = `/tmp/worktree/${runId}/${ticketId}`;
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
      this.spawned.push(handle);
      return { handle, worktreePath, sandboxRef };
    }
  );

  destroyWorktree = vi.fn(async (ref: SandboxRef) => {
    this.destroyed.push(ref);
  });

  last(): FakeWorkerHandle {
    const h = this.spawned.at(-1);
    if (!h) throw new Error("no spawn yet");
    return h;
  }
}

/** Spin briefly until `pred()` returns true, so tests don't race async awaits. */
async function waitUntil(pred: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitUntil timed out");
    }
    await new Promise((r) => setTimeout(r, 1));
  }
}

function buildTicket(id: string, overrides: Partial<TicketLedgerEntry> = {}): TicketLedgerEntry {
  return {
    ticketId: id,
    title: `ticket ${id}`,
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
    assignedAlias: "backend",
    ...overrides,
  };
}

async function buildHarness() {
  const root = await mkdtemp(join(tmpdir(), "runner-test-"));
  const channelsDir = join(root, "channels");
  const harnessStore = new FileHarnessStore(join(root, "__hs__"));
  const channelStore = new ChannelStore(channelsDir, harnessStore);

  const repoAssignments = [
    { alias: "backend", workspaceId: "ws-backend", repoPath: "/repo/backend" },
  ];
  const persisted = await channelStore.createChannel({
    name: "runner-test",
    description: "runner-test",
    workspaceIds: ["ws-backend"],
    repoAssignments,
  });
  const channel: Channel = {
    ...persisted,
    repoAssignments,
    fullAccess: false,
  };

  const admin = new FakeAdmin("backend");
  const spawner = new FakeSpawner();
  const runner = new TicketRunner({
    admin: admin as unknown as RepoAdminSession,
    repoAssignment: repoAssignments[0],
    channel,
    channelStore,
    spawner: spawner as unknown as WorkerSpawner,
    now: () => "2026-04-21T00:00:00.000Z",
  });

  const cleanup = async () => {
    await rm(root, { recursive: true, force: true });
  };

  return { root, channelStore, channel, admin, spawner, runner, cleanup };
}

describe("TicketRunner", () => {
  let cleanup: (() => Promise<void>) | null = null;
  beforeEach(() => {
    cleanup = null;
  });
  afterEach(async () => {
    if (cleanup) await cleanup();
  });

  it("serializes multiple queued tickets inside one admin (MVP AC)", async () => {
    const h = await buildHarness();
    cleanup = h.cleanup;

    h.admin.enqueue(buildTicket("t-1"));
    h.admin.enqueue(buildTicket("t-2"));

    // Start the drain. It spawns t-1 but the runner won't move to t-2 until
    // t-1's worker exits — that's the MVP serialization guarantee.
    const drainP = h.runner.drain();

    await waitUntil(() => h.spawner.spawned.length >= 1);
    expect(h.spawner.spawned).toHaveLength(1);
    expect(h.spawner.spawned[0].ticketId).toBe("t-1");

    // Still waiting on t-1 — t-2 hasn't been touched.
    expect(h.admin.queue.map((t) => t.ticketId)).toEqual(["t-2"]);

    // Complete t-1 with a PR URL so it moves to awaiting-merge.
    h.spawner.spawned[0].fire({ exitCode: 0, prUrl: "https://github.com/o/r/pull/1" });

    await waitUntil(() => h.spawner.spawned.length >= 2);
    expect(h.spawner.spawned[1].ticketId).toBe("t-2");

    // Finish t-2 so drain() can return.
    h.spawner.spawned[1].fire({ exitCode: 0, prUrl: "https://github.com/o/r/pull/2" });
    await drainP;
  });

  it("PR merge triggers worktree destroy + transitions ticket to completed (AC3)", async () => {
    const h = await buildHarness();
    cleanup = h.cleanup;

    h.admin.enqueue(buildTicket("t-merge"));
    const drainP = h.runner.drain();
    await waitUntil(() => h.spawner.spawned.length >= 1);
    h.spawner.last().fire({ exitCode: 0, prUrl: "https://github.com/o/r/pull/9" });
    await drainP;

    // Ticket is in `verifying` while awaiting merge; worktree not yet
    // destroyed.
    let board = await h.channelStore.readChannelTickets(h.channel.channelId);
    const verifyingEntry = board.find((t) => t.ticketId === "t-merge");
    expect(verifyingEntry?.status).toBe("verifying");
    expect(h.spawner.destroyed).toHaveLength(0);

    // Simulate PR merge.
    await h.runner.handlePrMerged("t-merge");

    // Worktree destroyed + ticket completed.
    expect(h.spawner.destroyed).toHaveLength(1);
    board = await h.channelStore.readChannelTickets(h.channel.channelId);
    const completedEntry = board.find((t) => t.ticketId === "t-merge");
    expect(completedEntry?.status).toBe("completed");
    expect(completedEntry?.completedAt).toBeTruthy();

    // Second call is a no-op (idempotent).
    await h.runner.handlePrMerged("t-merge");
    expect(h.spawner.destroyed).toHaveLength(1);
  });

  it("worker failure surfaces on feed + does NOT destroy worktree (AC4)", async () => {
    const h = await buildHarness();
    cleanup = h.cleanup;

    const failures: Array<{ ticketId: string; exitCode: number | null }> = [];
    h.runner.on("worker-failed", (evt) =>
      failures.push({ ticketId: evt.ticketId, exitCode: evt.exitCode })
    );

    h.admin.enqueue(buildTicket("t-fail"));
    const drainP = h.runner.drain();
    await waitUntil(() => h.spawner.spawned.length >= 1);
    h.spawner.last().fire({
      exitCode: 2,
      stdoutTail: "line1\nline2",
      stderrTail: "boom!",
    });
    await drainP;

    // Worktree preserved (AC4).
    expect(h.spawner.destroyed).toHaveLength(0);

    // Ticket marked failed on the board.
    const board = await h.channelStore.readChannelTickets(h.channel.channelId);
    const entry = board.find((t) => t.ticketId === "t-fail");
    expect(entry?.status).toBe("failed");
    expect(entry?.lastClassification?.category).toBe("fix_code");
    expect(entry?.lastClassification?.rationale).toContain("exit 2");

    // Feed carries the failure note — not swallowed (AC4).
    const feed = await h.channelStore.readFeed(h.channel.channelId);
    const note = feed.find((e) => e.type === "status_update" && e.metadata?.ticketId === "t-fail");
    expect(note).toBeDefined();
    expect(String(note?.content ?? "")).toContain("Worktree preserved");

    // Event emitted on the runner (AC4).
    expect(failures).toEqual([{ ticketId: "t-fail", exitCode: 2 }]);
  });

  it("clean exit with no PR URL fails the ticket and preserves the worktree", async () => {
    const h = await buildHarness();
    cleanup = h.cleanup;

    h.admin.enqueue(buildTicket("t-nopr"));
    const drainP = h.runner.drain();
    await waitUntil(() => h.spawner.spawned.length >= 1);
    h.spawner.last().fire({ exitCode: 0, prUrl: null, stdoutTail: "done" });
    await drainP;

    const board = await h.channelStore.readChannelTickets(h.channel.channelId);
    const entry = board.find((t) => t.ticketId === "t-nopr");
    expect(entry?.status).toBe("failed");
    expect(h.spawner.destroyed).toHaveLength(0);
  });

  it("invokes the PR-URL fallback probe when stdout tail misses", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-fallback-"));
    cleanup = async () => {
      await rm(root, { recursive: true, force: true });
    };

    const channelsDir = join(root, "channels");
    const harnessStore = new FileHarnessStore(join(root, "__hs__"));
    const channelStore = new ChannelStore(channelsDir, harnessStore);
    const persisted = await channelStore.createChannel({
      name: "fb",
      description: "fb",
      workspaceIds: ["ws-backend"],
      repoAssignments: [{ alias: "backend", workspaceId: "ws-backend", repoPath: "/repo/backend" }],
    });
    const channel: Channel = {
      ...persisted,
      repoAssignments: [{ alias: "backend", workspaceId: "ws-backend", repoPath: "/repo/backend" }],
      fullAccess: false,
    };
    const admin = new FakeAdmin("backend");
    const spawner = new FakeSpawner();

    const fallback = vi.fn(
      async (_args: { branch: string; worktreePath: string }): Promise<string | null> =>
        "https://github.com/o/r/pull/77"
    );

    const runner = new TicketRunner({
      admin: admin as unknown as RepoAdminSession,
      repoAssignment: channel.repoAssignments![0],
      channel,
      channelStore,
      spawner: spawner as unknown as WorkerSpawner,
      now: () => "2026-04-21T00:00:00.000Z",
      prUrlFallback: fallback,
    });

    admin.enqueue(buildTicket("t-fallback"));
    const drainP = runner.drain();
    await waitUntil(() => spawner.spawned.length >= 1);
    spawner.last().fire({ exitCode: 0, prUrl: null });
    await drainP;

    expect(fallback).toHaveBeenCalledTimes(1);
    const board = await channelStore.readChannelTickets(channel.channelId);
    const entry = board.find((t) => t.ticketId === "t-fallback");
    expect(entry?.status).toBe("verifying");
    const inflight = runner.listInflight();
    expect(inflight.find((r) => r.ticketId === "t-fallback")?.prUrl).toBe(
      "https://github.com/o/r/pull/77"
    );
  });

  it("stop() terminates in-flight workers without destroying worktrees", async () => {
    const h = await buildHarness();
    cleanup = h.cleanup;

    h.admin.enqueue(buildTicket("t-stop"));
    const drainP = h.runner.drain();
    await waitUntil(() => h.spawner.spawned.length >= 1);
    // Don't fire exit yet — stop() will drive it.
    await h.runner.stop("pool-shutdown");
    await drainP;

    expect(h.spawner.last().stopCalls).toContain("pool-shutdown");
    // No destroy on stop — operator inspection path.
    expect(h.spawner.destroyed).toHaveLength(0);
  });

  it("spawn failure marks the ticket failed with the spawn error (AC4)", async () => {
    const h = await buildHarness();
    cleanup = h.cleanup;

    h.spawner.spawn.mockImplementationOnce(async () => {
      throw new Error("worktree path already exists");
    });

    h.admin.enqueue(buildTicket("t-spawn-fail"));
    const drainP = h.runner.drain();
    await drainP;

    const board = await h.channelStore.readChannelTickets(h.channel.channelId);
    const entry = board.find((t) => t.ticketId === "t-spawn-fail");
    expect(entry?.status).toBe("failed");
    expect(entry?.lastClassification?.rationale).toContain("worktree path already exists");
    expect(h.spawner.destroyed).toHaveLength(0);
  });
});
