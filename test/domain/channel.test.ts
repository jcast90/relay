import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ChannelStore } from "../../src/channels/channel-store.js";

describe("Channel providerProfileId field", () => {
  it("round-trips providerProfileId through the channel manifest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "channel-profile-"));
    const store = new ChannelStore(dir);

    try {
      const created = await store.createChannel({
        name: "#profile-rt",
        description: "round-trip test",
      });

      // Absent on create (back-compat default).
      expect(created.providerProfileId).toBeUndefined();

      const bound = await store.updateChannel(created.channelId, {
        providerProfileId: "openrouter",
      });
      expect(bound?.providerProfileId).toBe("openrouter");

      const reloaded = await store.getChannel(created.channelId);
      expect(reloaded?.providerProfileId).toBe("openrouter");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("treats missing providerProfileId as undefined, not an error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "channel-profile-"));
    const store = new ChannelStore(dir);

    try {
      const created = await store.createChannel({
        name: "#no-profile",
        description: "absent field",
      });
      // Re-read to simulate a fresh process; ensures the serializer didn't
      // accidentally stamp `providerProfileId: null` or similar.
      const reloaded = await store.getChannel(created.channelId);
      expect(reloaded).not.toBeNull();
      expect(reloaded!.providerProfileId).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
