import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { ChannelStore } from "../../src/channels/channel-store.js";
import {
  PrPoller,
  type FollowUpDispatcher,
  type FollowUpRequest,
  type TrackedPr
} from "../../src/integrations/pr-poller.js";
import type { EnrichedPR, HarnessScm } from "../../src/integrations/scm.js";

function makeTracked(channelId: string): TrackedPr {
  return {
    ticketId: "T-1",
    channelId,
    pr: {
      number: 42,
      url: "https://github.com/acme/widgets/pull/42",
      branch: "feat/42"
    },
    repo: { owner: "acme", name: "widgets" }
  };
}

function seed(state: Partial<EnrichedPR> = {}): EnrichedPR {
  return {
    ci: state.ci ?? "none",
    review: state.review ?? "pending",
    prState: state.prState ?? "open"
  };
}

/**
 * Build a scripted HarnessScm stub whose enrichBatch returns successive
 * values per tick.
 */
function scriptedScm(series: Array<Map<string, EnrichedPR>>): HarnessScm {
  let i = 0;
  return {
    detectPR: vi.fn(),
    getCiSummary: vi.fn(),
    getReviewDecision: vi.fn(),
    getPendingComments: vi.fn(),
    enrichBatch: vi.fn(async () => {
      const next = series[Math.min(i, series.length - 1)];
      i += 1;
      return next;
    })
  } as unknown as HarnessScm;
}

describe("PrPoller", () => {
  it("first tick seeds state without firing events or enqueuing follow-ups", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pr-poller-seed-"));
    const store = new ChannelStore(dir);
    try {
      const channel = await store.createChannel({ name: "#pr", description: "" });
      const enqueueFollowUp = vi.fn<(req: FollowUpRequest) => Promise<string>>(
        async () => "followup-id"
      );
      const scheduler: FollowUpDispatcher = { enqueueFollowUp };

      const scm = scriptedScm([
        new Map([["acme/widgets#42", seed({ ci: "none", review: "pending", prState: "open" })]])
      ]);
      const poller = new PrPoller({ scm, channelStore: store, scheduler });
      poller.track(makeTracked(channel.channelId));

      await poller.tick();

      expect(enqueueFollowUp).not.toHaveBeenCalled();
      const feed = await store.readFeed(channel.channelId);
      // Channel has a "channel created" style entry set? No — ChannelStore doesn't post on create.
      // So feed should be empty after the seeding tick.
      expect(feed.filter((e) => e.fromDisplayName === "pr-poller")).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fires fix-ci follow-up when CI transitions none -> failing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pr-poller-ci-"));
    const store = new ChannelStore(dir);
    try {
      const channel = await store.createChannel({ name: "#pr-ci", description: "" });
      const enqueueFollowUp = vi.fn<(req: FollowUpRequest) => Promise<string>>(
        async () => "followup-id"
      );
      const scheduler: FollowUpDispatcher = { enqueueFollowUp };

      const scm = scriptedScm([
        new Map([["acme/widgets#42", seed({ ci: "none" })]]),
        new Map([["acme/widgets#42", seed({ ci: "failing" })]])
      ]);
      const poller = new PrPoller({ scm, channelStore: store, scheduler });
      poller.track(makeTracked(channel.channelId));

      await poller.tick(); // seed
      await poller.tick(); // transition

      expect(enqueueFollowUp).toHaveBeenCalledTimes(1);
      const firstCall = enqueueFollowUp.mock.calls[0];
      expect(firstCall).toBeDefined();
      const arg = firstCall![0];
      expect(arg.kind).toBe("fix-ci");
      expect(arg.parentTicketId).toBe("T-1");
      expect(arg.channelId).toBe(channel.channelId);
      expect(arg.pr.number).toBe(42);
      expect(arg.repo).toEqual({ owner: "acme", name: "widgets" });
      expect(arg.title).toContain("fix-ci");
      expect(arg.prompt).toContain("acme/widgets#42");

      const feed = await store.readFeed(channel.channelId);
      const statusEntries = feed.filter((e) => e.fromDisplayName === "pr-poller");
      expect(statusEntries.length).toBeGreaterThanOrEqual(1);
      const ciEntry = statusEntries.find((e) => e.content.startsWith("CI "));
      expect(ciEntry).toBeDefined();
      expect(ciEntry!.content).toContain("none -> failing");
      expect(ciEntry!.metadata.ciTo).toBe("failing");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fires address-reviews follow-up when review transitions pending -> changes_requested", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pr-poller-review-"));
    const store = new ChannelStore(dir);
    try {
      const channel = await store.createChannel({ name: "#pr-rev", description: "" });
      const enqueueFollowUp = vi.fn<(req: FollowUpRequest) => Promise<string>>(
        async () => "followup-id"
      );
      const scheduler: FollowUpDispatcher = { enqueueFollowUp };

      const scm = scriptedScm([
        new Map([["acme/widgets#42", seed({ review: "pending" })]]),
        new Map([["acme/widgets#42", seed({ review: "changes_requested" })]])
      ]);
      const poller = new PrPoller({ scm, channelStore: store, scheduler });
      poller.track(makeTracked(channel.channelId));

      await poller.tick();
      await poller.tick();

      expect(enqueueFollowUp).toHaveBeenCalledTimes(1);
      const firstCall = enqueueFollowUp.mock.calls[0];
      expect(firstCall).toBeDefined();
      const arg = firstCall![0];
      expect(arg.kind).toBe("address-reviews");
      expect(arg.title).toContain("address-reviews");

      const feed = await store.readFeed(channel.channelId);
      const reviewEntry = feed.find(
        (e) => e.fromDisplayName === "pr-poller" && e.content.startsWith("Review ")
      );
      expect(reviewEntry).toBeDefined();
      expect(reviewEntry!.metadata.reviewTo).toBe("changes_requested");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("untracks the PR when prState transitions to merged", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pr-poller-merge-"));
    const store = new ChannelStore(dir);
    try {
      const channel = await store.createChannel({ name: "#pr-merge", description: "" });
      const enqueueFollowUp = vi.fn<(req: FollowUpRequest) => Promise<string>>(
        async () => "followup-id"
      );
      const scheduler: FollowUpDispatcher = { enqueueFollowUp };

      const scm = scriptedScm([
        new Map([["acme/widgets#42", seed({ prState: "open" })]]),
        new Map([["acme/widgets#42", seed({ prState: "merged" })]]),
        // third tick returns nothing new — if still tracked, poller would query
        new Map([["acme/widgets#42", seed({ prState: "merged" })]])
      ]);
      const poller = new PrPoller({ scm, channelStore: store, scheduler });
      poller.track(makeTracked(channel.channelId));

      await poller.tick(); // seed
      await poller.tick(); // detect merge → untrack

      const enrichBatchMock = scm.enrichBatch as unknown as ReturnType<typeof vi.fn>;
      const callsAfterMerge = enrichBatchMock.mock.calls.length;

      await poller.tick(); // should be no-op because nothing is tracked

      expect(enrichBatchMock.mock.calls.length).toBe(callsAfterMerge);

      const feed = await store.readFeed(channel.channelId);
      const mergedEntry = feed.find(
        (e) => e.fromDisplayName === "pr-poller" && e.content.includes("merged")
      );
      expect(mergedEntry).toBeDefined();
      expect(mergedEntry!.metadata.prState).toBe("merged");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
