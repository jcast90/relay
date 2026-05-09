import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { __resetRelayDirCacheForTests } from "../../../src/cli/paths.js";
import {
  assertValidBriefId,
  readLatestGapFill,
  writeBriefArtifact,
  writeGapFill,
} from "../../../src/orchestrator/handoff/persistence.js";
import type { GapFillBlock } from "../../../src/orchestrator/handoff/types.js";

const CHANNEL_ID = "ch-fixmin-0001";

function buildGap(overrides: Partial<GapFillBlock> = {}): GapFillBlock {
  return {
    schemaVersion: 1,
    briefId: "brief-1746789000000-aabbcc",
    channelId: CHANNEL_ID,
    capturedAt: new Date("2026-05-09T12:00:00.000Z").toISOString(),
    capturedBySessionId: "sess-fixsrc-0001",
    currentLineOfAttack: "Investigating T-3 timeout",
    activeHypothesis: "API token has insufficient scope",
    abandonedApproaches: ["Tried bumping the timeout — no change."],
    openQuestions: ["Is the test fixture token configured?"],
    ...overrides,
  };
}

describe("handoff persistence", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "relay-handoff-persist-"));
    prevHome = process.env.HOME;
    process.env.HOME = home;
    __resetRelayDirCacheForTests();
  });

  afterEach(async () => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    __resetRelayDirCacheForTests();
    await rm(home, { recursive: true, force: true });
  });

  describe("assertValidBriefId", () => {
    it("accepts the canonical shape", () => {
      expect(() => assertValidBriefId("brief-1746789123456-a1b2c3")).not.toThrow();
    });

    it.each([
      ["no suffix", "brief-no-suffix"],
      ["uppercase", "BRIEF-001-x"],
      ["missing random", "brief-001"],
      ["empty", ""],
      ["path traversal", "../../etc"],
    ])("rejects %s", (_label, value) => {
      expect(() => assertValidBriefId(value)).toThrow(/Invalid briefId/);
    });
  });

  describe("writeGapFill", () => {
    it("writes the gap.json atomically with no leftover .tmp files", async () => {
      const gap = buildGap();
      const { gapJsonPath } = await writeGapFill({
        channelId: CHANNEL_ID,
        briefId: gap.briefId,
        payload: gap,
      });

      const onDisk = JSON.parse(await readFile(gapJsonPath, "utf8"));
      expect(onDisk).toEqual(gap);

      const dir = join(home, ".relay", "channels", CHANNEL_ID, "handoffs");
      const entries = await readdir(dir);
      expect(entries.filter((n) => n.includes(".tmp."))).toHaveLength(0);
    });

    it("rejects schemaVersion mismatch (defense in depth)", async () => {
      await expect(
        writeGapFill({
          channelId: CHANNEL_ID,
          briefId: "brief-1746789000000-aabbcc",
          // Cast through unknown — TS would reject at compile time, but
          // runtime callers (e.g. JSON-deserialized records) need the
          // guard too.
          payload: buildGap({ schemaVersion: 2 as unknown as 1 }),
        })
      ).rejects.toThrow(/schemaVersion/);
    });

    it("two consecutive calls produce two distinct gap.json files (no overwrite)", async () => {
      const a = await writeGapFill({
        channelId: CHANNEL_ID,
        briefId: "brief-1746789000000-aaaaaa",
        payload: buildGap({ briefId: "brief-1746789000000-aaaaaa" }),
      });
      const b = await writeGapFill({
        channelId: CHANNEL_ID,
        briefId: "brief-1746789000001-bbbbbb",
        payload: buildGap({ briefId: "brief-1746789000001-bbbbbb" }),
      });

      expect(a.gapJsonPath).not.toBe(b.gapJsonPath);
      const dir = join(home, ".relay", "channels", CHANNEL_ID, "handoffs");
      const entries = (await readdir(dir)).filter((n) => n.endsWith(".gap.json"));
      expect(entries).toHaveLength(2);
    });
  });

  describe("writeBriefArtifact", () => {
    it("writes both md + gap.json atomically", async () => {
      const gap = buildGap();
      const { mdPath, gapJsonPath } = await writeBriefArtifact({
        channelId: CHANNEL_ID,
        briefId: gap.briefId,
        markdown: "# Brief\n\nbody",
        gapFill: gap,
      });

      expect(await readFile(mdPath, "utf8")).toContain("# Brief");
      const onDisk = JSON.parse(await readFile(gapJsonPath, "utf8"));
      expect(onDisk).toEqual(gap);

      const dir = join(home, ".relay", "channels", CHANNEL_ID, "handoffs");
      const entries = await readdir(dir);
      expect(entries.filter((n) => n.includes(".tmp."))).toHaveLength(0);
    });
  });

  describe("readLatestGapFill", () => {
    const now = new Date("2026-05-09T12:00:00.000Z");

    it("returns null when the handoffs directory is missing", async () => {
      const result = await readLatestGapFill(CHANNEL_ID, { now });
      expect(result).toBeNull();
    });

    it("returns null when the directory exists but contains no gap files", async () => {
      const dir = join(home, ".relay", "channels", CHANNEL_ID, "handoffs");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "README.txt"), "ignore me");
      const result = await readLatestGapFill(CHANNEL_ID, { now });
      expect(result).toBeNull();
    });

    it("returns the newest gap.json by capturedAt", async () => {
      const oldGap = buildGap({
        briefId: "brief-1746789000000-aaaaaa",
        capturedAt: new Date(now.getTime() - 30 * 60 * 1000).toISOString(),
        currentLineOfAttack: "old",
      });
      const newGap = buildGap({
        briefId: "brief-1746789000001-bbbbbb",
        capturedAt: new Date(now.getTime() - 5 * 60 * 1000).toISOString(),
        currentLineOfAttack: "new",
      });
      const middleGap = buildGap({
        briefId: "brief-1746789000002-cccccc",
        capturedAt: new Date(now.getTime() - 15 * 60 * 1000).toISOString(),
        currentLineOfAttack: "middle",
      });

      await writeGapFill({ channelId: CHANNEL_ID, briefId: oldGap.briefId, payload: oldGap });
      await writeGapFill({ channelId: CHANNEL_ID, briefId: newGap.briefId, payload: newGap });
      await writeGapFill({
        channelId: CHANNEL_ID,
        briefId: middleGap.briefId,
        payload: middleGap,
      });

      const loaded = await readLatestGapFill(CHANNEL_ID, { now });
      expect(loaded?.briefId).toBe(newGap.briefId);
      expect(loaded?.currentLineOfAttack).toBe("new");
    });

    it("returns null when the newest record is older than the staleness window", async () => {
      const stale = buildGap({
        capturedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString(), // 2h
      });
      await writeGapFill({ channelId: CHANNEL_ID, briefId: stale.briefId, payload: stale });

      const loaded = await readLatestGapFill(CHANNEL_ID, { now });
      expect(loaded).toBeNull();
    });

    it("preserves schemaVersion: 2 on round-trip (does not silently coerce to 1)", async () => {
      // M9 — write a record with a future schema version directly to disk
      // (bypassing the writer's guard) and assert the reader rejects it.
      const dir = join(home, ".relay", "channels", CHANNEL_ID, "handoffs");
      await mkdir(dir, { recursive: true });
      const briefId = "brief-1746789123456-z9z9z9";
      const gapJsonPath = join(dir, `${briefId}.gap.json`);
      await writeFile(
        gapJsonPath,
        JSON.stringify({
          schemaVersion: 2, // intentional future-bump probe
          briefId,
          channelId: CHANNEL_ID,
          capturedAt: new Date(now.getTime() - 30_000).toISOString(),
          capturedBySessionId: null,
          currentLineOfAttack: "v2 should be rejected",
          activeHypothesis: "",
          abandonedApproaches: [],
          openQuestions: [],
        })
      );

      const loaded = await readLatestGapFill(CHANNEL_ID, { now });
      expect(loaded).toBeNull();
    });

    it("skips a malformed file but still returns a valid sibling", async () => {
      const dir = join(home, ".relay", "channels", CHANNEL_ID, "handoffs");
      await mkdir(dir, { recursive: true });
      // Bad file: looks like a brief gap.json but is not valid JSON.
      await writeFile(join(dir, "brief-1746789000000-bbbbbb.gap.json"), "{ not json");
      // Good file:
      const good = buildGap({
        briefId: "brief-1746789000001-cccccc",
        capturedAt: new Date(now.getTime() - 5 * 60 * 1000).toISOString(),
        currentLineOfAttack: "valid",
      });
      await writeGapFill({ channelId: CHANNEL_ID, briefId: good.briefId, payload: good });

      const loaded = await readLatestGapFill(CHANNEL_ID, { now });
      expect(loaded?.briefId).toBe(good.briefId);
    });

    it("rejects path-traversal channelIds", async () => {
      await expect(readLatestGapFill("../etc", { now })).rejects.toThrow(/Unsafe path segment/);
    });
  });
});
