import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ChannelStore } from "../src/channels/channel-store.js";
import { TrackedPrRowSchema, type TrackedPrRow } from "../src/domain/pr-row.js";

describe("tracked-prs persistence (OSS-05)", () => {
  it("round-trips rows through writeTrackedPrs / readTrackedPrs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tracked-prs-"));
    try {
      const store = new ChannelStore(dir);
      const channel = await store.createChannel({ name: "#pr", description: "" });

      expect(await store.readTrackedPrs(channel.channelId)).toEqual([]);

      const rows: TrackedPrRow[] = [
        {
          ticketId: "T-1",
          channelId: channel.channelId,
          owner: "acme",
          name: "widgets",
          number: 42,
          url: "https://github.com/acme/widgets/pull/42",
          branch: "feat/42",
          ci: "passing",
          review: "pending",
          prState: "open",
          updatedAt: new Date().toISOString()
        }
      ];
      await store.writeTrackedPrs(channel.channelId, rows);

      const back = await store.readTrackedPrs(channel.channelId);
      expect(back).toHaveLength(1);
      expect(back[0].ticketId).toBe("T-1");
      expect(back[0].ci).toBe("passing");
      // Every row written should satisfy the schema the TUI/GUI read against.
      expect(() => TrackedPrRowSchema.parse(back[0])).not.toThrow();

      // The on-disk file layout must match the shape the Rust crate expects
      // (an object with updatedAt + rows). Breaking the envelope would
      // silently blank the TUI tab.
      const raw = await readFile(
        join(dir, channel.channelId, "tracked-prs.json"),
        "utf8"
      );
      const parsed = JSON.parse(raw);
      expect(parsed.rows).toHaveLength(1);
      expect(typeof parsed.updatedAt).toBe("string");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("readTrackedPrs returns [] for a missing channel file instead of throwing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tracked-prs-"));
    try {
      const store = new ChannelStore(dir);
      const channel = await store.createChannel({ name: "#pr", description: "" });
      const result = await store.readTrackedPrs(channel.channelId);
      expect(result).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("writes overwrite atomically — second write replaces first", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tracked-prs-"));
    try {
      const store = new ChannelStore(dir);
      const channel = await store.createChannel({ name: "#pr", description: "" });

      const now = new Date().toISOString();
      await store.writeTrackedPrs(channel.channelId, [
        {
          ticketId: "T-1",
          channelId: channel.channelId,
          owner: "acme",
          name: "widgets",
          number: 42,
          url: "u",
          branch: "b",
          ci: null,
          review: null,
          prState: null,
          updatedAt: now
        }
      ]);
      await store.writeTrackedPrs(channel.channelId, []);
      expect(await store.readTrackedPrs(channel.channelId)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
