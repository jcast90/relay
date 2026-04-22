import { mkdtemp, readFile, rm } from "node:fs/promises";
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
        metadata: { eventId: "evt-1", priority: "info" },
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

  it("round-trips non-string metadata back to original types on read", async () => {
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
          tags: ["a", "b"],
        },
      });

      const feed = await store.readFeed(channel.channelId);
      expect(feed).toHaveLength(1);
      const metadata = feed[0].metadata;

      // Strings pass through verbatim.
      expect(metadata.simple).toBe("keep-me");
      // Non-string values are restored to their original types.
      expect(metadata.count).toBe(42);
      expect(metadata.flag).toBe(true);
      expect(metadata.payload).toEqual({ nested: { value: [1, 2, 3] } });
      expect(metadata.tags).toEqual(["a", "b"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps the on-disk wire format as Record<string, string> with a JSON tag for non-strings", async () => {
    const dir = await mkdtemp(join(tmpdir(), "post-wire-"));
    const store = new ChannelStore(dir);
    try {
      const channel = await store.createChannel({ name: "#main", description: "" });

      await store.post(channel.channelId, "wire check", {
        metadata: {
          plain: "hello",
          count: 42,
          payload: { x: 1 },
        },
      });

      const rawLine = (await readFile(join(dir, channel.channelId, "feed.jsonl"), "utf8")).trim();
      const onDisk = JSON.parse(rawLine) as {
        metadata: Record<string, string>;
      };

      // Every value on disk is a string — Rust and GUI readers rely on this.
      for (const v of Object.values(onDisk.metadata)) {
        expect(typeof v).toBe("string");
      }
      expect(onDisk.metadata.plain).toBe("hello");
      expect(onDisk.metadata.count).toBe("__ah_meta_json::42");
      expect(onDisk.metadata.payload).toBe('__ah_meta_json::{"x":1}');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not mis-parse literal strings that happen to start with the JSON tag", async () => {
    const dir = await mkdtemp(join(tmpdir(), "post-tag-"));
    const store = new ChannelStore(dir);
    try {
      const channel = await store.createChannel({ name: "#main", description: "" });

      // A string that coincidentally begins with the JSON tag must still
      // round-trip unchanged — the store re-tags it on write so the reader
      // restores the exact original bytes instead of treating it as a
      // serialized payload.
      const literalTagged = "__ah_meta_json::some-raw-value";
      const doubleTagged = "__ah_meta_json::__ah_meta_json::deep";

      await store.post(channel.channelId, "literal tag strings", {
        metadata: {
          literal: literalTagged,
          deep: doubleTagged,
          // A plain string that never touches the tag must not be double-
          // encoded (it should stay verbatim on disk).
          plain: "just a string",
        },
      });

      const feed = await store.readFeed(channel.channelId);
      expect(feed[0].metadata.literal).toBe(literalTagged);
      expect(feed[0].metadata.deep).toBe(doubleTagged);
      expect(feed[0].metadata.plain).toBe("just a string");

      // On-disk shape is still strings only; the plain string stays
      // verbatim while the tag-colliding strings are tagged JSON.
      const rawLine = (await readFile(join(dir, channel.channelId, "feed.jsonl"), "utf8")).trim();
      const onDisk = JSON.parse(rawLine) as {
        metadata: Record<string, string>;
      };
      for (const v of Object.values(onDisk.metadata)) {
        expect(typeof v).toBe("string");
      }
      expect(onDisk.metadata.plain).toBe("just a string");
      // Tag-colliding strings are escaped via the tagged JSON form.
      expect(onDisk.metadata.literal.startsWith("__ah_meta_json::")).toBe(true);
      expect(onDisk.metadata.literal).not.toBe(literalTagged);
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
          droppedUndef: undefined,
        },
      });

      const feed = await store.readFeed(channel.channelId);
      expect(feed[0].metadata).toEqual({ keep: "yes" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
