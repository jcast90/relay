/**
 * Per-ticket runner — AL-14.
 *
 * The repo-admin session (AL-12) collects tickets on an in-memory queue
 * via AL-13's router. AL-14's `TicketRunner` drains that queue: for each
 * ticket, it asks {@link WorkerSpawner} to create a worktree + spawn a
 * worker agent, monitors until the worker exits, and advances the ticket's
 * status on the channel board.
 *
 * ## Serialization
 *
 * AL-14 MVP **serializes** inside each repo. One repo-admin runs one
 * worker at a time. The AL-12 design note acknowledged this as a
 * deliberate trade-off; parallel workers inside the same repo (and the
 * worktree-clobber risks that come with them) are deferred to a later
 * ticket. Documented here so a future reader doesn't mistake the single-
 * threaded drain for an oversight. Two DIFFERENT repo-admins (separate
 * `TicketRunner` instances, one per admin) DO run in parallel — that's
 * the whole point of the pool.
 *
 * ## Lifecycle of a ticket
 *
 * 1. Take from `admin.pendingDispatches` (FIFO).
 * 2. Spawn a worker via {@link WorkerSpawner}. Mark ticket `executing`,
 *    stamp `crosslinkSessionId = worker.sessionId`.
 * 3. Monitor the worker's exit.
 *    - Exit code 0 + PR URL detected → ticket `verifying`, runner emits
 *      `worker-pr-opened` so an outer watcher can track the PR through
 *      merge (AL-5 will later wire the reviewer). Worktree is NOT
 *      destroyed here — we keep it until PR merge.
 *    - Exit code 0 + no PR URL → ticket `failed` with `fix_code`
 *      classification. AC4: the failure surfaces on the feed + an event
 *      fires on the runner's own emitter so the admin pool can log it.
 *      Worktree is preserved for operator inspection.
 *    - Non-zero exit → ticket `failed`, feed entry with stdout/stderr
 *      tail, worktree preserved. AC4.
 * 4. When the PR merges, the caller invokes `handlePrMerged(ticketId)`.
 *    The runner destroys the worktree (AC3) and marks the ticket
 *    `completed`. The call is idempotent: repeated merge events for the
 *    same ticket are no-ops.
 *
 * ## What lives elsewhere
 *
 * - Who dispatches PR-merge events into the runner is NOT AL-14's scope
 *   — the PR poller (`src/integrations/pr-poller.ts`) already surfaces
 *   `prState -> merged` transitions; wiring it to `handlePrMerged` is the
 *   autonomous-loop's job (AL-4 steady-state driver, out of scope here).
 *   AL-14 provides the hook; AL-4 calls it.
 * - Reviewer integration (AL-5), approval gates (AL-7/8), and inter-admin
 *   coordination (AL-16) are all explicitly out of scope.
 */

import { EventEmitter } from "node:events";

import type { ChannelStore } from "../channels/channel-store.js";
import type { Channel, RepoAssignment } from "../domain/channel.js";
import type { TicketLedgerEntry, TicketStatus } from "../domain/ticket.js";

import type { RepoAdminSession } from "./repo-admin-session.js";
import type { WorkerHandle, WorkerExitEvent, WorkerSpawner } from "./worker-spawner.js";
import type { SandboxRef } from "../execution/sandbox.js";

export interface TicketRunnerEvent {
  ticketId: string;
  workerSessionId: string;
}

export type TicketRunnerEventMap = {
  "worker-started": TicketRunnerEvent;
  "worker-pr-opened": TicketRunnerEvent & { prUrl: string };
  "worker-completed": TicketRunnerEvent & { prUrl: string | null };
  "worker-failed": TicketRunnerEvent & {
    exitCode: number | null;
    reason: string;
    worktreePath: string;
  };
  "ticket-merged": TicketRunnerEvent & { prUrl: string | null };
};

export interface TicketRunnerOptions {
  admin: RepoAdminSession;
  repoAssignment: RepoAssignment;
  channel: Channel;
  channelStore: ChannelStore;
  spawner: WorkerSpawner;
  /**
   * Clock for `updatedAt` stamps. Tests inject deterministic values so the
   * ticket mirror is snapshot-friendly. Defaults to `() => new Date().toISOString()`.
   */
  now?: () => string;
  /**
   * Optional PR-URL fallback probe. Invoked with `{branch}` when the worker
   * exited cleanly but no URL appeared in stdout. Returns the PR URL or
   * `null`. When omitted, the runner skips the fallback and treats a
   * missing URL as a failure (AC4 for the "no PR" case).
   *
   * The spec's "fallback `gh pr list` query" lives here — injecting it
   * keeps the runner testable without shelling out in unit tests.
   */
  prUrlFallback?: (args: { branch: string; worktreePath: string }) => Promise<string | null>;
}

/**
 * Tracker record for a ticket currently in-flight or awaiting its PR to
 * merge. Kept on the runner so `handlePrMerged` can find the right
 * sandbox to destroy.
 */
interface InflightTicket {
  ticketId: string;
  sandboxRef: SandboxRef;
  worktreePath: string;
  prUrl: string | null;
  state: "running" | "awaiting-merge" | "failed" | "completed" | "stopped";
  workerSessionId: string;
}

export class TicketRunner {
  private readonly admin: RepoAdminSession;
  private readonly repoAssignment: RepoAssignment;
  private readonly channel: Channel;
  private readonly channelStore: ChannelStore;
  private readonly spawner: WorkerSpawner;
  private readonly now: () => string;
  private readonly prUrlFallback?: (args: {
    branch: string;
    worktreePath: string;
  }) => Promise<string | null>;

  /**
   * FIFO in-flight map keyed by ticketId. `state` tells callers whether
   * the ticket is still running, waiting on the PR, or terminal. Runner
   * keeps records for terminal tickets until cleanup so `handlePrMerged`
   * can still map a ticketId to its sandbox when the merge event arrives
   * after the runner loop has moved on.
   */
  private readonly inflight = new Map<string, InflightTicket>();

  private readonly emitter = new EventEmitter();
  private draining = false;
  private drainPromise: Promise<void> | null = null;
  private stopped = false;
  /**
   * AL-4 steady-state hook. When flipped true, the drain loop stops
   * pulling new tickets off the admin's pending queue — the current
   * in-flight worker (if any) completes normally, then the drain loop
   * exits. Unlike {@link stop}, this does NOT signal the running
   * worker; it only refuses to start additional workers.
   *
   * Set via {@link stopAcceptingNew}. Kept separate from `stopped` so
   * the distinction between "abort the in-flight worker" (kill path)
   * and "let the in-flight worker finish but start no new ones"
   * (wind-down path) is explicit in the flow control.
   */
  private notAcceptingNew = false;

  constructor(options: TicketRunnerOptions) {
    this.admin = options.admin;
    this.repoAssignment = options.repoAssignment;
    this.channel = options.channel;
    this.channelStore = options.channelStore;
    this.spawner = options.spawner;
    this.now = options.now ?? (() => new Date().toISOString());
    this.prUrlFallback = options.prUrlFallback;
  }

  /**
   * Subscribe to runner events. Uses a typed key so consumers don't guess
   * the event strings.
   */
  on<K extends keyof TicketRunnerEventMap>(
    event: K,
    listener: (evt: TicketRunnerEventMap[K]) => void
  ): () => void {
    this.emitter.on(event, listener);
    return () => {
      this.emitter.off(event, listener);
    };
  }

  /**
   * Drain the admin's pending queue: for each queued ticket, spawn a
   * worker, monitor its exit, and advance the ticket board. Serializes
   * at the admin level — see top-of-file doc.
   *
   * Subsequent calls while a drain is in flight return the same promise
   * so the autonomous-loop can fire this opportunistically without
   * double-processing.
   */
  async drain(): Promise<void> {
    if (this.drainPromise) return this.drainPromise;
    this.drainPromise = this.runDrainLoop()
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.warn(
          `[ticket-runner] drain failed for alias=${this.repoAssignment.alias}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      })
      .finally(() => {
        this.drainPromise = null;
      });
    return this.drainPromise;
  }

  /**
   * AC3: worktree cleanup on PR merge. Idempotent — calling twice for the
   * same ticket is a no-op the second time. Destroys the worktree via the
   * spawner (which routes to the sandbox provider), transitions the
   * ticket to `completed`, and posts a feed update.
   *
   * Cleanup happens regardless of WHO merged the PR (user, agent, GOD
   * mode) — the runner doesn't inspect the merge source. That's AC3's
   * second clause.
   */
  async handlePrMerged(ticketId: string): Promise<void> {
    const record = this.inflight.get(ticketId);
    if (!record) return;
    if (record.state === "completed") return; // idempotent

    try {
      await this.spawner.destroyWorktree(record.sandboxRef);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[ticket-runner] failed to destroy worktree for ticket ${ticketId}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }

    record.state = "completed";
    await this.updateTicket(ticketId, (ticket) => {
      ticket.status = "completed";
      ticket.completedAt = this.now();
      ticket.updatedAt = this.now();
    });

    await this.channelStore
      .postEntry(this.channel.channelId, {
        type: "status_update",
        fromAgentId: null,
        fromDisplayName: "repo-admin",
        content: `Ticket ${ticketId} PR merged. Worktree cleaned up.`,
        metadata: {
          ticketId,
          prUrl: record.prUrl ?? null,
          worktreePath: record.worktreePath,
        },
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.warn(
          `[ticket-runner] failed to post merge status for ticket ${ticketId}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      });

    this.emit("ticket-merged", {
      ticketId,
      workerSessionId: record.workerSessionId,
      prUrl: record.prUrl,
    });

    // Drop the record once we're fully done so the map doesn't grow
    // unbounded across a long-lived session.
    this.inflight.delete(ticketId);
  }

  /**
   * AL-4 steady-state wind-down signal. After this call, the drain loop
   * stops pulling new tickets off the admin's pending queue — any
   * currently-executing worker runs to completion (PR open / failure /
   * exit), but no additional workers are spawned. Idempotent.
   *
   * This is the "let in-flight workers complete, don't start new ones"
   * semantic the autonomous-loop driver needs when the lifecycle
   * transitions to `winding_down` (e.g. 85% budget threshold). Distinct
   * from {@link stop} which signals SIGTERM to running workers.
   */
  stopAcceptingNew(): void {
    this.notAcceptingNew = true;
  }

  /**
   * Stop the runner. After this call, {@link drain} is a no-op and any
   * in-flight workers are signalled SIGTERM. Does NOT destroy worktrees
   * — operator inspection of failed workers (AC4) takes precedence over
   * aggressive cleanup.
   */
  async stop(reason: string): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;

    // Snapshot so handler mutations during iteration don't skip entries.
    const handles = Array.from(this.activeHandles.values());
    await Promise.all(
      handles.map(async (handle) => {
        try {
          await handle.stop(reason);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn(
            `[ticket-runner] handle.stop(${handle.ticketId}) threw: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      })
    );

    this.emitter.removeAllListeners();
  }

  /**
   * Snapshot of in-flight + pending-merge tickets. Useful to tests and the
   * TUI for a quick "what's this admin working on?" readout.
   */
  listInflight(): ReadonlyArray<Readonly<InflightTicket>> {
    return Array.from(this.inflight.values());
  }

  // --- internals ---------------------------------------------------------

  /**
   * Live handles to active workers. Separate from {@link inflight} because a
   * ticket may remain in `inflight` (awaiting PR merge) long after its
   * worker handle has gone away.
   */
  private readonly activeHandles = new Map<string, WorkerHandle>();

  private async runDrainLoop(): Promise<void> {
    if (this.stopped) return;
    this.draining = true;
    try {
      // AL-14 MVP: serialize. While the loop is running, new tickets that
      // land via `dispatchTicket` pile up in the admin queue and get picked
      // up on the next pass through the while-loop body.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (this.stopped) return;
        // AL-4 wind-down: when the driver flipped `notAcceptingNew`
        // after a lifecycle `winding_down` transition, the currently
        // running ticket finishes (this check only fires BEFORE the
        // next pull) but no more queued tickets get pulled. The admin's
        // pending queue is left intact so a future session can pick
        // them up if the operator resumes.
        if (this.notAcceptingNew) return;
        const ticket = this.admin.takeNextPendingTicket();
        if (!ticket) return;
        try {
          await this.runOneTicket(ticket);
        } catch (err) {
          // Defense in depth: runOneTicket already catches + surfaces most
          // failures via updateTicket + feed posts, but a truly unexpected
          // throw shouldn't wedge the drain loop. Log and move on.
          // eslint-disable-next-line no-console
          console.warn(
            `[ticket-runner] unexpected error running ticket ${ticket.ticketId}: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private async runOneTicket(ticket: TicketLedgerEntry): Promise<void> {
    if (this.stopped) return;

    // Spawn. Any error during spawn (worktree create, child spawn) → ticket
    // failed, feed surfaced, runner event fired. Worktree is NOT created
    // if spawner threw before `create` completed — nothing to clean up.
    let handle: WorkerHandle;
    let worktreePath: string;
    let sandboxRef: SandboxRef;
    try {
      const result = await this.spawner.spawn({
        ticket,
        repoAssignment: this.repoAssignment,
        channel: this.channel,
      });
      handle = result.handle;
      worktreePath = result.worktreePath;
      sandboxRef = result.sandboxRef;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await this.markTicketFailed(ticket.ticketId, {
        reason,
        stdoutTail: "",
        stderrTail: reason,
        worktreePath: "(never created)",
        exitCode: null,
      });
      return;
    }

    const inflight: InflightTicket = {
      ticketId: ticket.ticketId,
      sandboxRef,
      worktreePath,
      prUrl: null,
      state: "running",
      workerSessionId: handle.sessionId,
    };
    this.inflight.set(ticket.ticketId, inflight);
    this.activeHandles.set(ticket.ticketId, handle);

    await this.updateTicket(ticket.ticketId, (t) => {
      t.status = "executing";
      t.crosslinkSessionId = handle.sessionId;
      t.startedAt = this.now();
      t.updatedAt = this.now();
      t.attempt = (t.attempt ?? 0) + 1;
    });

    this.emit("worker-started", {
      ticketId: ticket.ticketId,
      workerSessionId: handle.sessionId,
    });

    // Wait for exit. `onExit` already handles the "already-exited" case on
    // the next microtask, so this promise resolves deterministically.
    const evt: WorkerExitEvent = await new Promise((resolve) => {
      const off = handle.onExit((e) => {
        off();
        resolve(e);
      });
    });

    this.activeHandles.delete(ticket.ticketId);

    // Resolve the PR URL: prefer stdout-tail; fall back to an injected
    // probe (typically `gh pr list --head <branch>`).
    let prUrl: string | null = evt.detectedPrUrl;
    if (!prUrl && evt.exitCode === 0 && this.prUrlFallback) {
      try {
        prUrl = await this.prUrlFallback({
          branch: branchNameFor(sandboxRef),
          worktreePath,
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[ticket-runner] prUrlFallback threw for ticket ${ticket.ticketId}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }

    inflight.prUrl = prUrl;

    if (evt.exitCode === 0 && prUrl) {
      // Happy path. Ticket is awaiting the PR to merge before we destroy
      // the worktree (AC3). Status moves to `verifying` so the board
      // reflects "worker done, PR open".
      inflight.state = "awaiting-merge";
      await this.updateTicket(ticket.ticketId, (t) => {
        t.status = "verifying";
        t.updatedAt = this.now();
      });
      this.emit("worker-pr-opened", {
        ticketId: ticket.ticketId,
        workerSessionId: handle.sessionId,
        prUrl,
      });
      this.emit("worker-completed", {
        ticketId: ticket.ticketId,
        workerSessionId: handle.sessionId,
        prUrl,
      });
      return;
    }

    // Failure paths: non-zero exit OR clean exit without a PR URL. Per AC4
    // the worktree is NOT destroyed here — keep it around for inspection.
    inflight.state = "failed";
    await this.markTicketFailed(ticket.ticketId, {
      reason: evt.reason,
      stdoutTail: evt.stdoutTail,
      stderrTail: evt.stderrTail,
      worktreePath,
      exitCode: evt.exitCode,
    });
    this.emit("worker-failed", {
      ticketId: ticket.ticketId,
      workerSessionId: handle.sessionId,
      exitCode: evt.exitCode,
      reason: evt.reason,
      worktreePath,
    });
  }

  private async markTicketFailed(
    ticketId: string,
    args: {
      reason: string;
      stdoutTail: string;
      stderrTail: string;
      worktreePath: string;
      exitCode: number | null;
    }
  ): Promise<void> {
    await this.updateTicket(ticketId, (t) => {
      t.status = "failed";
      t.updatedAt = this.now();
      t.lastClassification = {
        category: "fix_code",
        rationale: args.reason || "worker exited without producing a PR",
        nextAction: "inspect worktree and retry or fix manually",
      };
    });

    const tail = lastLines(args.stdoutTail, 20);
    const content = [
      `Worker failed on ticket ${ticketId} (exit ${args.exitCode ?? "null"}).`,
      `Worktree preserved at ${args.worktreePath} for inspection.`,
      tail ? `Last stdout:\n${tail}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    await this.channelStore
      .postEntry(this.channel.channelId, {
        type: "status_update",
        fromAgentId: null,
        fromDisplayName: "repo-admin",
        content,
        metadata: {
          ticketId,
          worktreePath: args.worktreePath,
          exitCode: args.exitCode,
          stderrTail: lastLines(args.stderrTail, 20),
        },
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.warn(
          `[ticket-runner] failed to post failure status for ticket ${ticketId}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      });
  }

  private async updateTicket(
    ticketId: string,
    mutator: (ticket: TicketLedgerEntry) => void
  ): Promise<void> {
    try {
      const board = await this.channelStore.readChannelTickets(this.channel.channelId);
      const existing = board.find((t) => t.ticketId === ticketId);
      const base: TicketLedgerEntry = existing ?? {
        ticketId,
        title: ticketId,
        specialty: "general",
        status: "pending" as TicketStatus,
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
        updatedAt: this.now(),
        runId: null,
      };
      mutator(base);
      await this.channelStore.upsertChannelTickets(this.channel.channelId, [base]);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[ticket-runner] failed to update ticket ${ticketId}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  private emit<K extends keyof TicketRunnerEventMap>(
    event: K,
    payload: TicketRunnerEventMap[K]
  ): void {
    const listeners = this.emitter.listeners(event) as Array<(p: TicketRunnerEventMap[K]) => void>;
    for (const listener of listeners) {
      try {
        listener(payload);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[ticket-runner] listener threw on ${String(event)}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }
  }
}

function lastLines(text: string, n: number): string {
  if (!text) return "";
  const lines = text.split("\n");
  return lines.slice(Math.max(0, lines.length - n)).join("\n");
}

function branchNameFor(ref: SandboxRef): string {
  // The git-worktree provider stamps `branch` in `ref.meta`. Fall back to a
  // reasonable synthetic if a custom provider didn't populate it — the
  // fallback's only consumer is the PR-URL probe, which tolerates an empty
  // string gracefully.
  return ref.meta?.branch ?? "";
}
