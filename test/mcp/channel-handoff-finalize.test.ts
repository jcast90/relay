import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ChannelStore } from "../../src/channels/channel-store.js";
import { __resetRelayDirCacheForTests } from "../../src/cli/paths.js";
import { callChannelTool, getChannelToolDefinitions } from "../../src/mcp/channel-tools.js";

/**
 * Wave 2 (PR-2) — `channel_handoff_finalize` MCP tool.
 *
 * The tool persists a versioned `<briefId>.gap.json` under
 * `~/.relay/channels/<id>/handoffs/`. The four working-memory slots are
 * Zod-validated for length caps and any `schemaVersion !== 1` payload is
 * rejected at runtime (M9 — fail closed; future bumps require coordinated
 * upgrade across writer + reader).
 *
 * Channel store is a stand-in stub: this tool doesn't touch the channel
 * feed (the brief-rendering CLI does that in a later wave), so the bare
 * minimum surface is enough.
 */

function fakeChannelStore(): ChannelStore {
  return {} as unknown as ChannelStore;
}

const CHANNEL_ID = "ch-fixmin-0001";

describe("channel_handoff_finalize MCP tool", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "relay-handoff-mcp-"));
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

  it("is registered in the tool catalogue", () => {
    const defs = getChannelToolDefinitions();
    const def = defs.find(
      (d): d is { name: string } => (d as { name?: string }).name === "channel_handoff_finalize"
    );
    expect(def).toBeDefined();
  });

  it("happy path — writes gap.json with schemaVersion 1 + ISO capturedAt", async () => {
    const result = (await callChannelTool(
      "channel_handoff_finalize",
      {
        channelId: CHANNEL_ID,
        currentLineOfAttack: "Investigating T-3 timeout",
        activeHypothesis: "API token has insufficient scope",
        abandonedApproaches: ["Tried bumping the timeout — no change."],
        openQuestions: ["Is the test fixture token configured?"],
        sessionId: "sess-x",
      },
      { sessionId: null, channelStore: fakeChannelStore() }
    )) as {
      ok: boolean;
      briefId: string;
      gapJsonPath: string;
      schemaVersion: number;
      capturedAt: string;
    };

    expect(result.ok).toBe(true);
    expect(result.briefId).toMatch(/^brief-[0-9]+-[a-z0-9]+$/);
    expect(result.schemaVersion).toBe(1);
    expect(result.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const onDisk = JSON.parse(await readFile(result.gapJsonPath, "utf8"));
    expect(onDisk.schemaVersion).toBe(1);
    expect(onDisk.briefId).toBe(result.briefId);
    expect(onDisk.channelId).toBe(CHANNEL_ID);
    expect(onDisk.currentLineOfAttack).toBe("Investigating T-3 timeout");
    expect(onDisk.capturedBySessionId).toBe("sess-x");
  });

  it("falls back to state.sessionId when args.sessionId is omitted", async () => {
    const result = (await callChannelTool(
      "channel_handoff_finalize",
      {
        channelId: CHANNEL_ID,
        currentLineOfAttack: "x",
        activeHypothesis: "y",
        abandonedApproaches: [],
        openQuestions: [],
      },
      { sessionId: "sess-fallback", channelStore: fakeChannelStore() }
    )) as { gapJsonPath: string };

    const onDisk = JSON.parse(await readFile(result.gapJsonPath, "utf8"));
    expect(onDisk.capturedBySessionId).toBe("sess-fallback");
  });

  it("rejects missing required fields", async () => {
    await expect(
      callChannelTool(
        "channel_handoff_finalize",
        { channelId: CHANNEL_ID },
        { sessionId: null, channelStore: fakeChannelStore() }
      )
    ).rejects.toThrow(/invalid input/i);
  });

  it("rejects oversized currentLineOfAttack (> 4000 chars)", async () => {
    const huge = "x".repeat(4001);
    await expect(
      callChannelTool(
        "channel_handoff_finalize",
        {
          channelId: CHANNEL_ID,
          currentLineOfAttack: huge,
          activeHypothesis: "",
          abandonedApproaches: [],
          openQuestions: [],
        },
        { sessionId: null, channelStore: fakeChannelStore() }
      )
    ).rejects.toThrow(/currentLineOfAttack/);
  });

  it("rejects schemaVersion !== 1 with a field-named error (M9)", async () => {
    await expect(
      callChannelTool(
        "channel_handoff_finalize",
        {
          channelId: CHANNEL_ID,
          currentLineOfAttack: "x",
          activeHypothesis: "y",
          abandonedApproaches: [],
          openQuestions: [],
          schemaVersion: 2, // intentional future-bump probe
        },
        { sessionId: null, channelStore: fakeChannelStore() }
      )
    ).rejects.toThrow(/schemaVersion/);
  });

  it("rejects path-traversal channelIds", async () => {
    await expect(
      callChannelTool(
        "channel_handoff_finalize",
        {
          channelId: "../../etc",
          currentLineOfAttack: "x",
          activeHypothesis: "y",
          abandonedApproaches: [],
          openQuestions: [],
        },
        { sessionId: null, channelStore: fakeChannelStore() }
      )
    ).rejects.toThrow(/Unsafe path segment/);
  });

  it("two consecutive calls write two distinct gap.json files", async () => {
    const a = (await callChannelTool(
      "channel_handoff_finalize",
      {
        channelId: CHANNEL_ID,
        currentLineOfAttack: "first",
        activeHypothesis: "",
        abandonedApproaches: [],
        openQuestions: [],
      },
      { sessionId: null, channelStore: fakeChannelStore() }
    )) as { briefId: string; gapJsonPath: string };

    // Without a delay, `buildBriefId` is deterministic over (channelId,
    // now), so back-to-back calls in the same millisecond produce the
    // same id. That's a real-world risk — the persistence layer would
    // overwrite. Sleep 5ms to ensure distinct unix-ms suffixes.
    await new Promise((r) => setTimeout(r, 5));

    const b = (await callChannelTool(
      "channel_handoff_finalize",
      {
        channelId: CHANNEL_ID,
        currentLineOfAttack: "second",
        activeHypothesis: "",
        abandonedApproaches: [],
        openQuestions: [],
      },
      { sessionId: null, channelStore: fakeChannelStore() }
    )) as { briefId: string; gapJsonPath: string };

    expect(a.briefId).not.toBe(b.briefId);
    expect(a.gapJsonPath).not.toBe(b.gapJsonPath);

    const dir = join(home, ".relay", "channels", CHANNEL_ID, "handoffs");
    const entries = (await readdir(dir)).filter((n) => n.endsWith(".gap.json"));
    expect(entries).toHaveLength(2);
  });

  it("end-to-end: gap written via tool flows into buildBrief without placeholder", async () => {
    // Wave 2 wires `synthesizer.buildBrief` to auto-load the newest
    // non-stale `*.gap.json` from disk when the caller doesn't pass
    // `gapFill` explicitly. This test exercises that loop end-to-end.
    const writeResult = (await callChannelTool(
      "channel_handoff_finalize",
      {
        channelId: CHANNEL_ID,
        currentLineOfAttack: "wired-end-to-end",
        activeHypothesis: "the synthesizer reads the latest gap on disk",
        abandonedApproaches: [],
        openQuestions: [],
      },
      { sessionId: null, channelStore: fakeChannelStore() }
    )) as { ok: boolean };
    expect(writeResult.ok).toBe(true);

    // Build a fixture-channel brief through the synthesizer using the
    // same `~/.relay/` HOME the tool just wrote into.
    const fixtureDir = new URL("../orchestrator/handoff/fixtures/channel-min/", import.meta.url);
    const channelsRoot = join(home, ".relay", "channels");
    // Mirror the channel-store on-disk layout: <channelsDir>/<id>.json
    // (manifest) + <channelsDir>/<id>/{feed.jsonl,…}.
    const { cp, mkdir } = await import("node:fs/promises");
    await mkdir(channelsRoot, { recursive: true });
    await cp(
      new URL("manifest.json", fixtureDir).pathname,
      join(channelsRoot, `${CHANNEL_ID}.json`)
    );
    await cp(fixtureDir.pathname, join(channelsRoot, CHANNEL_ID), { recursive: true });

    const { buildBrief } = await import("../../src/orchestrator/handoff/synthesizer.js");
    const { ChannelStore } = await import("../../src/channels/channel-store.js");
    const store = new ChannelStore(channelsRoot);

    const brief = await buildBrief({
      channelId: CHANNEL_ID,
      now: new Date(),
      channelStore: store,
      gitLogEnabled: false,
    });

    expect(brief.sections.workingMemory.body).toContain("wired-end-to-end");
    expect(brief.sections.workingMemory.body).not.toContain("[gap-fill not provided]");
  });
});
