import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { attachThresholdFeed } from "../../src/budget/threshold-feed-bridge.js";
import { TokenTracker } from "../../src/budget/token-tracker.js";
import { ChannelStore } from "../../src/channels/channel-store.js";

const RM_OPTS = { recursive: true, force: true, maxRetries: 3, retryDelay: 50 };

interface FeedEntry {
  type: string;
  metadata: Record<string, string>;
  content: string;
}

async function readFeed(channelsDir: string, channelId: string): Promise<FeedEntry[]> {
  const text = await readFile(join(channelsDir, channelId, "feed.jsonl"), "utf8");
  return text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as FeedEntry);
}

/**
 * RED tests for the 75/90/95 threshold-feed bridge. PR-1 ships the
 * stub-throwing `attachThresholdFeed` so this file fails at runtime; PR-2
 * (Task 5) lands the implementation that makes them GREEN.
 */
describe("attachThresholdFeed", () => {
  let root: string;
  let channelsDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "relay-bridge-"));
    channelsDir = join(root, "channels");
  });

  afterEach(async () => {
    await rm(root, RM_OPTS);
  });

  it("posts exactly one status_update entry when crossing 90%, with the documented metadata shape", async () => {
    const store = new ChannelStore(channelsDir);
    const tracker = new TokenTracker("sess-1", 1000, { rootDir: root });
    attachThresholdFeed(tracker, "ch-1", store, { modelName: "claude-sonnet-4-5" });
    tracker.record(900, 0); // crosses 75 + 85 + 90 thresholds at once
    await tracker.flush();

    const entries = await readFeed(channelsDir, "ch-1");
    const events = entries.filter(
      (e) => e.type === "status_update" && e.metadata.kind === "context_threshold"
    );
    const ninety = events.find((e) => e.metadata.threshold === "90");
    expect(ninety, "expected a 90 threshold entry").toBeDefined();
    expect(ninety?.metadata).toMatchObject({
      kind: "context_threshold",
      schemaVersion: "1",
      threshold: "90",
      sessionId: "sess-1",
      model: "claude-sonnet-4-5",
    });
    // M7 — pin pct precision to two decimal places so future drift to
    // toFixed(3) is caught.
    expect(ninety?.metadata.pct).toMatch(/^\d+\.\d{2}$/);
  });

  it("does not post for thresholds outside [75, 90, 95]", async () => {
    const store = new ChannelStore(channelsDir);
    const tracker = new TokenTracker("sess-quiet", 1000, { rootDir: root });
    attachThresholdFeed(tracker, "ch-quiet", store);
    tracker.record(600, 0); // crosses 50 + 60 only — neither in [75, 90, 95]
    await tracker.flush();

    let entries: FeedEntry[];
    try {
      entries = await readFeed(channelsDir, "ch-quiet");
    } catch {
      entries = [];
    }
    const events = entries.filter((e) => e.metadata?.kind === "context_threshold");
    expect(events).toHaveLength(0);
  });

  it("M5: two trackers with distinct sessionIds emit distinct feed entries", async () => {
    const store = new ChannelStore(channelsDir);
    const a = new TokenTracker("sess-a", 1000, { rootDir: root });
    const b = new TokenTracker("sess-b", 1000, { rootDir: root });
    attachThresholdFeed(a, "ch-multi", store);
    attachThresholdFeed(b, "ch-multi", store);
    a.record(900, 0);
    b.record(900, 0);
    await a.flush();
    await b.flush();

    const entries = await readFeed(channelsDir, "ch-multi");
    const ninety = entries.filter(
      (e) => e.metadata?.kind === "context_threshold" && e.metadata?.threshold === "90"
    );
    const sessionIds = new Set(ninety.map((e) => e.metadata.sessionId));
    expect(sessionIds.size).toBe(2);
    expect(sessionIds.has("sess-a")).toBe(true);
    expect(sessionIds.has("sess-b")).toBe(true);
  });
});
