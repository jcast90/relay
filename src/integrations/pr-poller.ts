/**
 * PR poller — watches tracked pull requests and feeds CI failures and
 * review-requested events back into the harness as follow-up tickets.
 *
 * In-memory only; posts channel entries via `ChannelStore` and dispatches
 * follow-ups through an injected `FollowUpDispatcher` because the existing
 * `TicketScheduler` does not expose a public enqueue surface.
 *
 * Transitions per polled PR:
 *   - ci -> "failing": post entry + enqueue "fix-ci" follow-up.
 *   - review -> "changes_requested": post entry + enqueue "address-reviews".
 *   - prState -> "merged" | "closed": post entry + untrack.
 *   - Any other delta: informational entry only.
 */
import type { CiSummary, EnrichedPR, HarnessPR, HarnessScm, ReviewDecision } from "./scm.js";
import type { ChannelStore } from "../channels/channel-store.js";
import type { PrReviewFindings } from "../domain/pr-row.js";

export interface TrackedPr {
  ticketId: string;
  channelId: string;
  pr: HarnessPR;
  repo: { owner: string; name: string };
  /**
   * AL-5 marker: `true` when the PR was opened by a worker spawned under an
   * autonomous ticket. The PR reviewer wrapper uses this flag to scope its
   * subagent runs — manual `rly pr-watch` rows stay untouched. Defaults to
   * `false` when the field is omitted.
   */
  openedByAutonomous?: boolean;
}

export type FollowUpKind = "fix-ci" | "address-reviews";

export interface FollowUpRequest {
  kind: FollowUpKind;
  parentTicketId: string;
  channelId: string;
  pr: HarnessPR;
  repo: { owner: string; name: string };
  title: string;
  prompt: string;
}

export interface FollowUpDispatcher {
  enqueueFollowUp(request: FollowUpRequest): Promise<string>;
}

/**
 * Snapshot of a single tracked entry — exactly what `listTracked()` returns.
 * Declared at module scope so callers outside this file (pr-watcher-factory)
 * can type their `onSnapshot` mirror sinks.
 *
 * `openedByAutonomous` and `reviewFindings` (AL-5) are surfaced through the
 * snapshot so the on-disk mirror (`tracked-prs.json`) carries them for the
 * TUI / GUI. Both fall back to their schema-default on rows that predate
 * AL-5.
 */
export type TrackedPrSnapshot = {
  ticketId: string;
  channelId: string;
  pr: TrackedPr["pr"];
  repo: TrackedPr["repo"];
  last: EnrichedPR | null;
  openedByAutonomous: boolean;
  reviewFindings: PrReviewFindings | null;
};

export interface PrPollerOptions {
  scm: HarnessScm;
  channelStore: ChannelStore;
  scheduler: FollowUpDispatcher;
  intervalMs?: number;
  /**
   * Optional mirror sink. Fired after every tick, and on `track`/`untrack`,
   * with the full set of current tracked rows. Used by the CLI to persist
   * a disk copy that the TUI and GUI can read (`tracked-prs.json`). The
   * poller does not await the return — sinks run in the background and
   * are swallowed on failure so polling stays crash-free.
   */
  onSnapshot?: (rows: TrackedPrSnapshot[]) => void;
  /**
   * AL-5: fired synchronously from `track()` when a new PR is registered.
   * Subscribers (the `PrReviewer` wrapper) decide whether to act based on
   * `entry.openedByAutonomous`. Errors thrown by the listener are caught
   * and logged — a misbehaving reviewer must not poison tracking.
   */
  onTrack?: (entry: TrackedPr) => void;
  /**
   * AL-14 follow-up: fired exactly once per tracked PR when the poller
   * observes a `prState` transition to `"merged"`. The autonomous-loop
   * driver subscribes so it can drive `TicketRunner.handlePrMerged` and
   * destroy the ticket's worktree within one poll tick of the merge —
   * regardless of whether the merge was performed by a user, an agent,
   * or an external webhook.
   *
   * Fires BEFORE `untrack()` inside the same `onPrStateChange` handler so
   * subscribers that look up other tracked state (e.g. via `listTracked`)
   * still see the entry. Errors thrown by the listener are caught and
   * logged — a misbehaving subscriber must not stop the poller from
   * cleaning up its internal state.
   */
  onMerged?: (evt: PrMergedEvent) => void;
}

/**
 * Payload for {@link PrPollerOptions.onMerged} subscribers. Fires once per
 * tracked PR when the poller observes `prState` flip to `"merged"`.
 */
export interface PrMergedEvent {
  /** The ticket that spawned the worker that opened this PR. */
  ticketId: string;
  /** Channel the PR was tracked under. */
  channelId: string;
  /** Browser-usable PR URL, preserved verbatim from `TrackedPr.pr.url`. */
  prUrl: string;
  /** `(owner, name)` of the repo the PR lives in. */
  repo: { owner: string; name: string };
  /** GitHub PR number. */
  prNumber: number;
}

interface TrackedState {
  entry: TrackedPr;
  last: EnrichedPR | null;
  /**
   * AL-5 review metadata — `null` until the reviewer wrapper stashes
   * findings via {@link PrPoller.setReviewFindings}. Retained in memory so
   * the snapshot writer persists it to `tracked-prs.json` without an
   * external state store.
   */
  reviewFindings: PrReviewFindings | null;
}

const DEFAULT_INTERVAL_MS = 30_000;

export class PrPoller {
  private readonly scm: HarnessScm;
  private readonly channelStore: ChannelStore;
  private readonly scheduler: FollowUpDispatcher;
  private readonly intervalMs: number;
  private readonly tracked = new Map<string, TrackedState>();
  private readonly onSnapshot?: (rows: TrackedPrSnapshot[]) => void;
  private readonly onTrackListener?: (entry: TrackedPr) => void;
  /**
   * AL-14 follow-up: dynamic merge-event subscribers. The constructor
   * option {@link PrPollerOptions.onMerged} pre-registers one listener;
   * {@link onMerged} adds further listeners at runtime. The autonomous-
   * loop driver subscribes via the runtime API after construction so the
   * pr-poller can be shared across multiple subscribers (reviewer + sweep)
   * without forcing a factory-composition pattern.
   */
  private readonly mergedListeners: Array<(evt: PrMergedEvent) => void> = [];

  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(options: PrPollerOptions) {
    this.scm = options.scm;
    this.channelStore = options.channelStore;
    this.scheduler = options.scheduler;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.onSnapshot = options.onSnapshot;
    this.onTrackListener = options.onTrack;
    if (options.onMerged) this.mergedListeners.push(options.onMerged);
  }

  /**
   * Register a dynamic merge-event listener. Returns an `unsubscribe`
   * function so callers can detach cleanly — used by the autonomous-
   * loop driver to remove its listener on terminal exit.
   */
  onMerged(listener: (evt: PrMergedEvent) => void): () => void {
    this.mergedListeners.push(listener);
    return () => {
      const idx = this.mergedListeners.indexOf(listener);
      if (idx >= 0) this.mergedListeners.splice(idx, 1);
    };
  }

  track(entry: TrackedPr): void {
    this.tracked.set(entry.ticketId, { entry, last: null, reviewFindings: null });
    // Fire the onTrack listener BEFORE the snapshot so a reviewer stashing
    // initial "review in progress" findings synchronously shows up in the
    // very first persisted snapshot. Errors are swallowed so a misbehaving
    // reviewer doesn't poison tracking.
    if (this.onTrackListener) {
      try {
        this.onTrackListener(entry);
      } catch (err) {
        console.warn("[pr-poller] onTrack listener threw; ignoring", err);
      }
    }
    this.fireSnapshot();
  }

  untrack(ticketId: string): void {
    this.tracked.delete(ticketId);
    this.fireSnapshot();
  }

  /**
   * AL-5: stash structured review findings produced by the
   * `pr-review-toolkit:code-reviewer` subagent on the tracked row. No-ops
   * silently if the ticket is no longer tracked (the PR could have merged
   * between review kickoff and result delivery — the reviewer is long
   * enough that this is a real race, not a theoretical one). Fires a
   * snapshot so readers pick up the new findings on the next tick boundary.
   */
  setReviewFindings(ticketId: string, findings: PrReviewFindings): void {
    const state = this.tracked.get(ticketId);
    if (!state) return;
    state.reviewFindings = findings;
    this.fireSnapshot();
  }

  /**
   * Read-only snapshot of tracked PRs and their last-seen enriched state.
   * Used by the `pr-status` CLI command to render a table without reaching
   * into the private `tracked` map, and by the mirror sink to persist a
   * disk copy for TUI/GUI readers.
   */
  listTracked(): ReadonlyArray<TrackedPrSnapshot> {
    return Array.from(this.tracked.values()).map((state) => ({
      ticketId: state.entry.ticketId,
      channelId: state.entry.channelId,
      pr: state.entry.pr,
      repo: state.entry.repo,
      last: state.last,
      openedByAutonomous: state.entry.openedByAutonomous === true,
      reviewFindings: state.reviewFindings,
    }));
  }

  private fireSnapshot(): void {
    if (!this.onSnapshot) return;
    try {
      this.onSnapshot(Array.from(this.listTracked()));
    } catch (err) {
      console.warn("[pr-poller] snapshot sink threw; ignoring", err);
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch(() => {
        /* polling must never crash the process */
      });
    }, this.intervalMs);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.running || this.tracked.size === 0) return;

    this.running = true;
    try {
      const states = Array.from(this.tracked.values());
      let enriched: Map<string, EnrichedPR>;
      try {
        enriched = await this.scm.enrichBatch(states.map((s) => s.entry.pr));
      } catch (error) {
        console.warn("[pr-poller] enrichBatch failed; skipping tick", error);
        return;
      }

      for (const state of states) {
        const current = enriched.get(this.keyFor(state.entry));
        if (!current) continue;

        const previous = state.last;
        state.last = current;

        // First observation seeds state without firing events.
        if (previous === null) continue;

        await this.handleTransitions(state.entry, previous, current);
      }
    } finally {
      this.running = false;
      // Fire even when `this.running` blocked the tick — readers want a
      // fresh snapshot on every attempt so stale data doesn't linger.
      this.fireSnapshot();
    }
  }

  private async handleTransitions(
    entry: TrackedPr,
    previous: EnrichedPR,
    current: EnrichedPR
  ): Promise<void> {
    if (current.ci !== previous.ci) {
      await this.onCiChange(entry, previous.ci, current.ci);
    }
    if (current.review !== previous.review) {
      await this.onReviewChange(entry, previous.review, current.review);
    }
    if (current.prState !== previous.prState) {
      await this.onPrStateChange(entry, current.prState);
    }
  }

  private async onCiChange(entry: TrackedPr, from: CiSummary, to: CiSummary): Promise<void> {
    await this.post(entry.channelId, `CI ${from} -> ${to} on ${this.keyFor(entry)}`, {
      ticketId: entry.ticketId,
      prUrl: entry.pr.url,
      ciFrom: from,
      ciTo: to,
    });

    if (to !== "failing") return;

    const label = this.keyFor(entry);
    await this.enqueue({
      kind: "fix-ci",
      parentTicketId: entry.ticketId,
      channelId: entry.channelId,
      pr: entry.pr,
      repo: entry.repo,
      title: `fix-ci: ${label}`,
      prompt: [
        `CI started failing on ${label} (${entry.pr.url}).`,
        `Parent ticket: ${entry.ticketId}.`,
        `Investigate the failing checks, reproduce locally, and push a fix to branch "${entry.pr.branch}".`,
      ].join("\n"),
    });
  }

  private async onReviewChange(
    entry: TrackedPr,
    from: ReviewDecision,
    to: ReviewDecision
  ): Promise<void> {
    await this.post(entry.channelId, `Review ${from} -> ${to} on ${this.keyFor(entry)}`, {
      ticketId: entry.ticketId,
      prUrl: entry.pr.url,
      reviewFrom: from,
      reviewTo: to,
    });

    if (to !== "changes_requested") return;

    const label = this.keyFor(entry);
    await this.enqueue({
      kind: "address-reviews",
      parentTicketId: entry.ticketId,
      channelId: entry.channelId,
      pr: entry.pr,
      repo: entry.repo,
      title: `address-reviews: ${label}`,
      prompt: [
        `Reviewers requested changes on ${label} (${entry.pr.url}).`,
        `Parent ticket: ${entry.ticketId}.`,
        `Read the pending comments, address each one, and push follow-up commits to branch "${entry.pr.branch}".`,
      ].join("\n"),
    });
  }

  private async onPrStateChange(entry: TrackedPr, to: "open" | "merged" | "closed"): Promise<void> {
    await this.post(entry.channelId, `PR ${this.keyFor(entry)} is now ${to}`, {
      ticketId: entry.ticketId,
      prUrl: entry.pr.url,
      prState: to,
    });
    // AL-14 follow-up: fire merge-event listeners BEFORE `untrack()`
    // removes the row so any synchronous subscriber that consults other
    // tracked state (e.g. `listTracked()`) still sees the entry.
    if (to === "merged" && this.mergedListeners.length > 0) {
      const payload: PrMergedEvent = {
        ticketId: entry.ticketId,
        channelId: entry.channelId,
        prUrl: entry.pr.url,
        repo: entry.repo,
        prNumber: entry.pr.number,
      };
      // Snapshot so a listener that unsubscribes mid-dispatch doesn't
      // skip siblings registered against the same event.
      for (const listener of this.mergedListeners.slice()) {
        try {
          listener(payload);
        } catch (err) {
          console.warn("[pr-poller] onMerged listener threw; ignoring", err);
        }
      }
    }
    if (to === "merged" || to === "closed") {
      await this.archiveReviewDmIfPresent(entry, to);
      this.untrack(entry.ticketId);
    }
  }

  /**
   * When the tracked row's `channelId` points at a PR-review DM (minted by
   * the `pr_review_start` MCP tool, identified by the `pr` block on the
   * channel), flip the DM's `pr.state` to `to` — which also archives it —
   * and cross-link back to the parent channel when one is set. Silently
   * skips channels without a `pr` block so project/feature channels that
   * happen to track a PR continue to behave as today.
   */
  private async archiveReviewDmIfPresent(entry: TrackedPr, to: "merged" | "closed"): Promise<void> {
    let channel;
    try {
      channel = await this.channelStore.getChannel(entry.channelId);
    } catch (err) {
      console.warn("[pr-poller] failed to read channel for DM archive check", err);
      return;
    }
    if (!channel?.pr) return;

    try {
      await this.channelStore.postEntry(entry.channelId, {
        type: "status_update",
        fromAgentId: null,
        fromDisplayName: "pr-poller",
        content: `PR ${to} — archiving review thread.`,
        metadata: { prUrl: entry.pr.url, prState: to },
      });
    } catch (err) {
      console.warn("[pr-poller] failed to post DM-archive notice", err);
    }

    try {
      await this.channelStore.updatePrState(entry.channelId, to);
    } catch (err) {
      console.warn("[pr-poller] failed to archive PR DM", err);
    }

    const parentId = channel.pr.parentChannelId;
    if (!parentId) return;
    try {
      await this.channelStore.postEntry(parentId, {
        type: "pr_link",
        fromAgentId: null,
        fromDisplayName: "PR Review",
        content: `PR ${to}: ${entry.pr.url}`,
        metadata: {
          prUrl: entry.pr.url,
          prNumber: entry.pr.number,
          prState: to,
          dmChannelId: entry.channelId,
        },
      });
    } catch (err) {
      console.warn("[pr-poller] failed to post parent cross-link on PR close", err);
    }
  }

  private async post(
    channelId: string,
    content: string,
    metadata: Record<string, string>
  ): Promise<void> {
    try {
      await this.channelStore.postEntry(channelId, {
        type: "status_update",
        fromAgentId: null,
        fromDisplayName: "pr-poller",
        content,
        metadata,
      });
    } catch (error) {
      console.warn("[pr-poller] failed to post channel entry", error);
    }
  }

  private async enqueue(request: FollowUpRequest): Promise<void> {
    try {
      await this.scheduler.enqueueFollowUp(request);
    } catch (error) {
      console.warn(
        `[pr-poller] failed to enqueue follow-up ${request.kind}; next transition will re-fire`,
        error
      );
    }
  }

  private keyFor(entry: TrackedPr): string {
    return `${entry.repo.owner}/${entry.repo.name}#${entry.pr.number}`;
  }
}
