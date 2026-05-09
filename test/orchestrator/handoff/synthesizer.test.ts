import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ChannelStore } from "../../../src/channels/channel-store.js";
import { buildBrief, buildBriefId } from "../../../src/orchestrator/handoff/synthesizer.js";
import type { GapFillBlock } from "../../../src/orchestrator/handoff/types.js";

const FIXTURE_CHANNEL_ID = "ch-fixmin-0001";
const FIXTURE_DIR = fileURLToPath(new URL("./fixtures/channel-min", import.meta.url));

async function setUpFixtureChannelsDir(): Promise<{
  channelsDir: string;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "handoff-synth-"));
  const channelsDir = join(root, "channels");
  await mkdir(channelsDir, { recursive: true });
  // ChannelStore expects: <channelsDir>/<channelId>.json (manifest) +
  // <channelsDir>/<channelId>/{feed.jsonl,tickets.json,runs.json,decisions/*.json}.
  // The fixture's `manifest.json` is the channel record; we copy it to
  // `<id>.json` and copy the remaining files into `<id>/`.
  await cp(join(FIXTURE_DIR, "manifest.json"), join(channelsDir, `${FIXTURE_CHANNEL_ID}.json`));
  await cp(FIXTURE_DIR, join(channelsDir, FIXTURE_CHANNEL_ID), { recursive: true });
  return {
    channelsDir,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

describe("buildBrief — synthesizer", () => {
  let channelsDir: string;
  let cleanup: () => Promise<void>;
  let store: ChannelStore;

  beforeEach(async () => {
    ({ channelsDir, cleanup } = await setUpFixtureChannelsDir());
    store = new ChannelStore(channelsDir);
  });

  afterEach(async () => {
    await cleanup();
  });

  it("renders all six required sections with schemaVersion 1", async () => {
    const now = new Date("2026-05-09T12:00:00.000Z");
    const brief = await buildBrief({
      channelId: FIXTURE_CHANNEL_ID,
      now,
      channelStore: store,
      gitLogEnabled: false,
    });

    expect(brief.schemaVersion).toBe(1);
    expect(brief.briefId).toMatch(/^brief-[0-9]+-[a-z0-9]+$/);
    expect(brief.channelId).toBe(FIXTURE_CHANNEL_ID);
    expect(brief.channelName).toBe("fixture-min");
    expect(brief.generatedAt).toBe(now.toISOString());

    // All six sections present + non-empty.
    expect(brief.sections.statusSnapshot.body.length).toBeGreaterThan(0);
    expect(brief.sections.mission.body.length).toBeGreaterThan(0);
    expect(brief.sections.ticketDag.body.length).toBeGreaterThan(0);
    expect(brief.sections.recentDecisions.body.length).toBeGreaterThan(0);
    expect(brief.sections.filesTouched.body.length).toBeGreaterThan(0);
    expect(brief.sections.workingMemory.body.length).toBeGreaterThan(0);

    // tokenEstimate is sum of section estimates.
    const sum =
      brief.sections.statusSnapshot.estimatedTokens +
      brief.sections.mission.estimatedTokens +
      brief.sections.ticketDag.estimatedTokens +
      brief.sections.recentDecisions.estimatedTokens +
      brief.sections.filesTouched.estimatedTokens +
      brief.sections.workingMemory.estimatedTokens;
    expect(brief.tokenEstimate).toBe(sum);
  });

  it("is deterministic when gitLogEnabled is false (two consecutive calls deep-equal)", async () => {
    const now = new Date("2026-05-09T12:00:00.000Z");
    const a = await buildBrief({
      channelId: FIXTURE_CHANNEL_ID,
      now,
      channelStore: store,
      gitLogEnabled: false,
    });
    const b = await buildBrief({
      channelId: FIXTURE_CHANNEL_ID,
      now,
      channelStore: store,
      gitLogEnabled: false,
    });
    expect(b).toEqual(a);
  });

  it("renders tickets in topological order (T-1, T-2, T-3) by dependsOn", async () => {
    const now = new Date("2026-05-09T12:00:00.000Z");
    const brief = await buildBrief({
      channelId: FIXTURE_CHANNEL_ID,
      now,
      channelStore: store,
      gitLogEnabled: false,
    });
    const ticketBody = brief.sections.ticketDag.body;
    const i1 = ticketBody.indexOf("t-001");
    const i2 = ticketBody.indexOf("t-002");
    const i3 = ticketBody.indexOf("t-003");
    expect(i1).toBeGreaterThan(-1);
    expect(i2).toBeGreaterThan(i1);
    expect(i3).toBeGreaterThan(i2);
  });

  it("renders recent decisions newest-first with full rationale + alternatives", async () => {
    const now = new Date("2026-05-09T12:00:00.000Z");
    const brief = await buildBrief({
      channelId: FIXTURE_CHANNEL_ID,
      now,
      channelStore: store,
      gitLogEnabled: false,
    });
    const body = brief.sections.recentDecisions.body;
    // d-002 is newer (10:40) than d-001 (10:10) — newest first
    const i002 = body.indexOf("Defer first-class file tracking");
    const i001 = body.indexOf("Use git log for files-touched");
    expect(i002).toBeGreaterThan(-1);
    expect(i001).toBeGreaterThan(i002);
    // d-002 has alternatives, d-001 doesn't
    expect(body).toContain("schema churn");
    expect(body).toContain("(none recorded)"); // for d-001's empty alternatives
  });

  it("renders [gap-fill not provided] placeholder when gap.json is older than 1h", async () => {
    const now = new Date("2026-05-09T12:00:00.000Z");
    const staleGap: GapFillBlock = {
      schemaVersion: 1,
      briefId: "brief-1746000000000-stale1",
      channelId: FIXTURE_CHANNEL_ID,
      capturedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString(),
      capturedBySessionId: "sess-fixsrc-0001",
      currentLineOfAttack: "should not appear",
      activeHypothesis: "should not appear",
      abandonedApproaches: ["should not appear"],
      openQuestions: ["should not appear"],
    };
    const brief = await buildBrief({
      channelId: FIXTURE_CHANNEL_ID,
      now,
      gapFill: staleGap,
      gitLogEnabled: false,
      channelStore: store,
    });
    expect(brief.sections.workingMemory.body).toContain("[gap-fill not provided]");
    expect(brief.sections.workingMemory.body).not.toContain("should not appear");
  });

  it("renders fresh gap-fill in workingMemory section", async () => {
    const now = new Date("2026-05-09T12:00:00.000Z");
    const freshGap: GapFillBlock = {
      schemaVersion: 1,
      briefId: "brief-1746789000000-fresh1",
      channelId: FIXTURE_CHANNEL_ID,
      capturedAt: new Date(now.getTime() - 5 * 60 * 1000).toISOString(), // 5min ago
      capturedBySessionId: "sess-fixsrc-0001",
      currentLineOfAttack: "Investigating T-3 timeout",
      activeHypothesis: "API token has insufficient scope for /v2/list",
      abandonedApproaches: ["Tried bumping the timeout to 60s — no change."],
      openQuestions: ["Does the test fixture have a real API token configured?"],
    };
    const brief = await buildBrief({
      channelId: FIXTURE_CHANNEL_ID,
      now,
      gapFill: freshGap,
      gitLogEnabled: false,
      channelStore: store,
    });
    const body = brief.sections.workingMemory.body;
    expect(body).toContain("Investigating T-3 timeout");
    expect(body).toContain("API token has insufficient scope");
    expect(body).toContain("Tried bumping the timeout");
    expect(body).toContain("Does the test fixture have a real API token");
    expect(body).not.toContain("[gap-fill not provided]");
  });
});

describe("buildBriefId", () => {
  it("produces deterministic id under fixed inputs", () => {
    const now = new Date("2026-05-09T12:00:00.000Z");
    const id1 = buildBriefId("ch-fixmin-0001", now);
    const id2 = buildBriefId("ch-fixmin-0001", now);
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^brief-[0-9]+-[a-z0-9]+$/);
  });

  it("differs across distinct channelIds", () => {
    const now = new Date("2026-05-09T12:00:00.000Z");
    const id1 = buildBriefId("ch-a", now);
    const id2 = buildBriefId("ch-b", now);
    expect(id1).not.toBe(id2);
  });
});
