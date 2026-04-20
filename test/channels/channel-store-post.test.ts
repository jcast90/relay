import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ChannelStore } from "../../src/channels/channel-store.js";

describe("ChannelStore.post", () => {
  it("applies defaults (message type, null agent id, system display name, empty metadata)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "post-defaults-"));
    const store = new ChannelStore(dir);
    try {
      const channel = await store.createChannel({ name: "#main", description: "" });

      const entryId = await store.post(channel.channelId, "hello world");
      expect(typeof entryId).toBe("string");
      expect(entryId).toMatch(/^entry-/);

      const feed = await store.readFeed(channel.channelId);
      expect(feed).toHaveLength(1);
      const entry = feed[0];
      expect(entry.entryId).toBe(entryId);
      expect(entry.type).toBe("message");
      expect(entry.fromAgentId).toBeNull();
      expect(entry.fromDisplayName).toBe("system");
      expect(entry.content).toBe("hello world");
      expect(entry.metadata).toEqual({});
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("honors overrides for type, fromAgentId, fromDisplayName, and metadata", async () => {
    const dir = await mkdtemp(join(tmpdir(), "post-overrides-"));
    const store = new ChannelStore(dir);
    try {
      const channel = await store.createChannel({ name: "#main", description: "" });

      await store.post(channel.channelId, "PR opened", {
        type: "event",
        fromAgentId: "agent-7",
        fromDisplayName: "PR Bot",
        metadata: { eventId: "evt-1", priority: "info" }
      });

      const feed = await store.readFeed(channel.channelId);
      expect(feed).toHaveLength(1);
      const entry = feed[0];
      expect(entry.type).toBe("event");
      expect(entry.fromAgentId).toBe("agent-7");
      expect(entry.fromDisplayName).toBe("PR Bot");
      expect(entry.content).toBe("PR opened");
      expect(entry.metadata).toEqual({ eventId: "evt-1", priority: "info" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("serializes non-string metadata values to JSON strings on write", async () => {
    const dir = await mkdtemp(join(tmpdir(), "post-meta-"));
    const store = new ChannelStore(dir);
    try {
      const channel = await store.createChannel({ name: "#main", description: "" });

      await store.post(channel.channelId, "rich metadata", {
        metadata: {
          simple: "keep-me",
          count: 42,
          flag: true,
          payload: { nested: { value: [1, 2, 3] } },
          tags: ["a", "b"]
        }
      });

      const feed = await store.readFeed(channel.channelId);
      expect(feed).toHaveLength(1);
      const metadata = feed[0].metadata as Record<string, string>;

      // Strings pass through verbatim.
      expect(metadata.simple).toBe("keep-me");
      // Non-string values become JSON strings — verify round-trip.
      expect(typeof metadata.count).toBe("string");
      expect(JSON.parse(metadata.count)).toBe(42);
      expect(JSON.parse(metadata.flag)).toBe(true);
      expect(JSON.parse(metadata.payload)).toEqual({ nested: { value: [1, 2, 3] } });
      expect(JSON.parse(metadata.tags)).toEqual(["a", "b"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("drops null and undefined metadata values", async () => {
    const dir = await mkdtemp(join(tmpdir(), "post-drop-"));
    const store = new ChannelStore(dir);
    try {
      const channel = await store.createChannel({ name: "#main", description: "" });

      await store.post(channel.channelId, "drop test", {
        metadata: {
          keep: "yes",
          droppedNull: null,
          droppedUndef: undefined
        }
      });

      const feed = await store.readFeed(channel.channelId);
      expect(feed[0].metadata).toEqual({ keep: "yes" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
