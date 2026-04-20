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
import type {
  CiSummary,
  EnrichedPR,
  HarnessPR,
  HarnessScm,
  ReviewDecision,
} from "./scm.js";
import type { ChannelStore } from "../channels/channel-store.js";

export interface TrackedPr {
  ticketId: string;
  channelId: string;
  pr: HarnessPR;
  repo: { owner: string; name: string };
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

export interface PrPollerOptions {
  scm: HarnessScm;
  channelStore: ChannelStore;
  scheduler: FollowUpDispatcher;
  intervalMs?: number;
}

interface TrackedState {
  entry: TrackedPr;
  last: EnrichedPR | null;
}

const DEFAULT_INTERVAL_MS = 30_000;

export class PrPoller {
  private readonly scm: HarnessScm;
  private readonly channelStore: ChannelStore;
  private readonly scheduler: FollowUpDispatcher;
  private readonly intervalMs: number;
  private readonly tracked = new Map<string, TrackedState>();

  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(options: PrPollerOptions) {
    this.scm = options.scm;
    this.channelStore = options.channelStore;
    this.scheduler = options.scheduler;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  }

  track(entry: TrackedPr): void {
    this.tracked.set(entry.ticketId, { entry, last: null });
  }

  untrack(ticketId: string): void {
    this.tracked.delete(ticketId);
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
      } catch {
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
    }
  }

  private async handleTransitions(
    entry: TrackedPr,
    previous: EnrichedPR,
    current: EnrichedPR,
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
    to: ReviewDecision,
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

  private async onPrStateChange(
    entry: TrackedPr,
    to: "open" | "merged" | "closed",
  ): Promise<void> {
    await this.post(entry.channelId, `PR ${this.keyFor(entry)} is now ${to}`, {
      ticketId: entry.ticketId,
      prUrl: entry.pr.url,
      prState: to,
    });
    if (to === "merged" || to === "closed") this.untrack(entry.ticketId);
  }

  private async post(
    channelId: string,
    content: string,
    metadata: Record<string, string>,
  ): Promise<void> {
    try {
      await this.channelStore.postEntry(channelId, {
        type: "status_update",
        fromAgentId: null,
        fromDisplayName: "pr-poller",
        content,
        metadata,
      });
    } catch {
      /* non-critical */
    }
  }

  private async enqueue(request: FollowUpRequest): Promise<void> {
    try {
      await this.scheduler.enqueueFollowUp(request);
    } catch {
      /* non-critical; next transition will re-fire */
    }
  }

  private keyFor(entry: TrackedPr): string {
    return `${entry.repo.owner}/${entry.repo.name}#${entry.pr.number}`;
  }
}
