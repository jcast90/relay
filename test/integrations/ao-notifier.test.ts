import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ChannelStore } from "../../src/channels/channel-store.js";
import { HarnessChannelNotifier } from "../../src/channels/ao-notifier.js";

function buildEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt-1",
    type: "pr.updated",
    priority: "info",
    sessionId: "sess-1",
    projectId: "proj-1",
    timestamp: new Date("2026-04-20T12:00:00.000Z"),
    message: "PR updated",
    data: {},
    ...overrides
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("HarnessChannelNotifier", () => {
  it("notify posts an event entry with event metadata and preserves event.data", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ao-notif-"));
    const store = new ChannelStore(dir);
    try {
      const channel = await store.createChannel({ name: "#main", description: "" });
      const notifier = new HarnessChannelNotifier({
        channelStore: store,
        defaultChannelId: channel.channelId
      });

      const data = { prNumber: 42, reviewer: "alice", labels: ["urgent", "bug"] };
      await notifier.notify(buildEvent({ data }));

      const feed = await store.readFeed(channel.channelId);
      expect(feed).toHaveLength(1);
      const entry = feed[0];
      expect(entry.type).toBe("event");
      expect(entry.fromDisplayName).toBe("orchestrator");
      expect(entry.content).toContain("[pr.updated]");
      expect(entry.content).toContain("session=sess-1");
      expect(entry.content).toContain("PR updated");
      expect(entry.metadata.eventId).toBe("evt-1");
      expect(entry.metadata.eventType).toBe("pr.updated");
      expect(entry.metadata.priority).toBe("info");
      expect(entry.metadata.sessionId).toBe("sess-1");
      expect(entry.metadata.projectId).toBe("proj-1");
      expect(entry.metadata.timestamp).toBe("2026-04-20T12:00:00.000Z");
      // event.data is tagged+serialized on write so downstream Rust/GUI
      // readers (typed Record<string, string>) keep seeing string metadata;
      // TS callers get the original object back after the symmetric
      // denormalization performed in readFeed.
      expect(entry.metadata.data).toEqual(data);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("notifyWithActions appends an actions trailer to the body", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ao-notif-"));
    const store = new ChannelStore(dir);
    try {
      const channel = await store.createChannel({ name: "#main", description: "" });
      const notifier = new HarnessChannelNotifier({
        channelStore: store,
        defaultChannelId: channel.channelId
      });

      await notifier.notifyWithActions(buildEvent(), [
        { label: "View PR", url: "https://example.com/pr/1" },
        { label: "Ack", callbackEndpoint: "https://example.com/ack" }
      ]);

      const feed = await store.readFeed(channel.channelId);
      expect(feed).toHaveLength(1);
      const body = feed[0].content;
      expect(body).toContain("Actions:");
      expect(body).toContain("- View PR: https://example.com/pr/1");
      expect(body).toContain("- Ack: https://example.com/ack");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("post routes to context.channel when provided instead of the default channel", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ao-notif-"));
    const store = new ChannelStore(dir);
    try {
      const defaultChannel = await store.createChannel({ name: "#default", description: "" });
      const otherChannel = await store.createChannel({ name: "#other", description: "" });
      const notifier = new HarnessChannelNotifier({
        channelStore: store,
        defaultChannelId: defaultChannel.channelId
      });

      const entryId = await notifier.post("hi", { channel: otherChannel.channelId });
      expect(entryId).toBeTruthy();

      const defaultFeed = await store.readFeed(defaultChannel.channelId);
      const otherFeed = await store.readFeed(otherChannel.channelId);

      expect(defaultFeed).toHaveLength(0);
      expect(otherFeed).toHaveLength(1);
      expect(otherFeed[0].type).toBe("message");
      expect(otherFeed[0].content).toBe("hi");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("post falls back to the default channel when no context.channel is provided", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ao-notif-"));
    const store = new ChannelStore(dir);
    try {
      const channel = await store.createChannel({ name: "#default", description: "" });
      const notifier = new HarnessChannelNotifier({
        channelStore: store,
        defaultChannelId: channel.channelId
      });

      await notifier.post("ping", { sessionId: "s-1", projectId: "p-1", prUrl: "u" });

      const feed = await store.readFeed(channel.channelId);
      expect(feed).toHaveLength(1);
      expect(feed[0].content).toBe("ping");
      expect(feed[0].metadata.sessionId).toBe("s-1");
      expect(feed[0].metadata.projectId).toBe("p-1");
      expect(feed[0].metadata.prUrl).toBe("u");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
