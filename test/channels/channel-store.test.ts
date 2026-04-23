import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ChannelStore } from "../../src/channels/channel-store.js";

describe("ChannelStore.setProviderProfileId", () => {
  it("writes providerProfileId atomically and records a decision", async () => {
    const dir = await mkdtemp(join(tmpdir(), "set-provider-"));
    const store = new ChannelStore(dir);

    try {
      const channel = await store.createChannel({
        name: "#profile",
        description: "profile binding",
      });

      // Bind.
      const bound = await store.setProviderProfileId(channel.channelId, "openrouter");
      expect(bound?.providerProfileId).toBe("openrouter");

      // Persisted — re-read bypasses any in-memory state.
      const reloaded = await store.getChannel(channel.channelId);
      expect(reloaded?.providerProfileId).toBe("openrouter");

      // Clear.
      const cleared = await store.setProviderProfileId(channel.channelId, null);
      expect(cleared?.providerProfileId).toBeUndefined();

      // Each invocation writes a decision — two setter calls, two entries.
      const decisions = await store.listDecisions(channel.channelId);
      expect(decisions).toHaveLength(2);
      // Most-recent-first sort: clear is newer than bind.
      expect(decisions[0].title).toContain("(none — inherit default)");
      expect(decisions[1].title).toContain("openrouter");

      // And a feed entry lands for each decision so the audit trail is
      // visible from `rly channel feed`.
      const feed = await store.readFeed(channel.channelId);
      const decisionEntries = feed.filter((e) => e.type === "decision");
      expect(decisionEntries.length).toBeGreaterThanOrEqual(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns null for an unknown channel", async () => {
    const dir = await mkdtemp(join(tmpdir(), "set-provider-"));
    const store = new ChannelStore(dir);

    try {
      const result = await store.setProviderProfileId("does-not-exist", "openrouter");
      expect(result).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("re-binding to the same profile still records a decision (audit)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "set-provider-"));
    const store = new ChannelStore(dir);

    try {
      const channel = await store.createChannel({
        name: "#noop",
        description: "no-op bind",
      });
      await store.setProviderProfileId(channel.channelId, "openrouter");
      await store.setProviderProfileId(channel.channelId, "openrouter");
      const decisions = await store.listDecisions(channel.channelId);
      expect(decisions).toHaveLength(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
