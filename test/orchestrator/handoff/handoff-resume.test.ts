/**
 * Wave 4 / PR-4 — `--save` and `--resume` mode tests.
 *
 * Covers D-08 (resume-after-week) and M7 (--resume reads only gap.json,
 * never the brief.md snapshot).
 */

import { cp, mkdir, mkdtemp, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ChannelStore } from "../../../src/channels/channel-store.js";
import { __resetRelayDirCacheForTests } from "../../../src/cli/paths.js";
import {
  handleHandoffCommand,
  type HandoffSpawnInput,
  type HandoffSpawnResult,
} from "../../../src/cli/handoff.js";
import { ProviderProfileStore } from "../../../src/storage/provider-profile-store.js";
import type { GapFillBlock } from "../../../src/orchestrator/handoff/types.js";

const FIXTURE_CHANNEL_ID = "ch-fixmin-0001";
const FIXTURE_DIR = fileURLToPath(new URL("./fixtures/channel-min", import.meta.url));

class WriteBuffer {
  private chunks: string[] = [];
  write(chunk: string | Uint8Array): boolean {
    this.chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return true;
  }
  toString(): string {
    return this.chunks.join("");
  }
}

function makeStubSpawner(): {
  spawner: (input: HandoffSpawnInput) => Promise<HandoffSpawnResult>;
  calls: { input: HandoffSpawnInput }[];
} {
  const calls: { input: HandoffSpawnInput }[] = [];
  const spawner = async (input: HandoffSpawnInput): Promise<HandoffSpawnResult> => {
    calls.push({ input });
    return {
      newSessionId: `sess-stub-${calls.length}`,
      destinationLabel: input.profile?.displayName ?? input.adapter,
      adapter: input.adapter,
    };
  };
  return { spawner, calls };
}

async function setUpEnv(): Promise<{
  home: string;
  channelsDir: string;
  cleanup: () => Promise<void>;
}> {
  const home = await mkdtemp(join(tmpdir(), "relay-handoff-resume-"));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  __resetRelayDirCacheForTests();
  const channelsDir = join(home, ".relay", "channels");
  await mkdir(channelsDir, { recursive: true });
  await cp(join(FIXTURE_DIR, "manifest.json"), join(channelsDir, `${FIXTURE_CHANNEL_ID}.json`));
  await cp(FIXTURE_DIR, join(channelsDir, FIXTURE_CHANNEL_ID), { recursive: true });
  return {
    home,
    channelsDir,
    cleanup: async () => {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      __resetRelayDirCacheForTests();
      await rm(home, { recursive: true, force: true });
    },
  };
}

function buildGap(briefId: string, overrides: Partial<GapFillBlock> = {}): GapFillBlock {
  return {
    schemaVersion: 1,
    briefId,
    channelId: FIXTURE_CHANNEL_ID,
    capturedAt: "2026-05-08T12:00:00.000Z",
    capturedBySessionId: "sess-fixsrc-0001",
    currentLineOfAttack: "Investigate T-3 timeout via fixture",
    activeHypothesis: "Token scope is wrong",
    abandonedApproaches: ["Bumped timeout — no change."],
    openQuestions: ["Is the fixture token configured?"],
    ...overrides,
  };
}

describe("rly handoff — `--save` + `--resume` modes (Wave 4)", () => {
  let env: Awaited<ReturnType<typeof setUpEnv>>;
  let channelStore: ChannelStore;
  let providerProfileStore: ProviderProfileStore;
  let stdoutBuf: WriteBuffer;
  let stderrBuf: WriteBuffer;
  const fixedNow = new Date("2026-05-09T12:00:00.000Z");

  beforeEach(async () => {
    env = await setUpEnv();
    channelStore = new ChannelStore(env.channelsDir);
    providerProfileStore = new ProviderProfileStore({ rootDir: join(env.home, ".relay") });
    stdoutBuf = new WriteBuffer();
    stderrBuf = new WriteBuffer();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("--save writes the brief artifact and does NOT spawn a destination session", async () => {
    const { spawner, calls } = makeStubSpawner();

    const result = await handleHandoffCommand({
      argv: [FIXTURE_CHANNEL_ID, "--save", "--wait-gap", "0"],
      stdout: stdoutBuf,
      stderr: stderrBuf,
      env: process.env,
      channelStore,
      providerProfileStore,
      spawner,
      now: () => fixedNow,
    });

    expect(result.exitCode).toBe(0);
    expect(calls).toHaveLength(0);

    const handoffsDir = join(env.channelsDir, FIXTURE_CHANNEL_ID, "handoffs");
    const files = await readdir(handoffsDir);
    expect(files.some((n) => n.endsWith(".md"))).toBe(true);
    expect(files.some((n) => n.endsWith(".gap.json"))).toBe(true);

    const feed = await channelStore.readFeed(FIXTURE_CHANNEL_ID);
    const handoffEntry = feed.find(
      (e) => e.metadata && (e.metadata as Record<string, unknown>).handoff === true
    );
    expect(handoffEntry).toBeDefined();
    expect((handoffEntry?.metadata as Record<string, unknown>).mode).toBe("save");
  });

  it("--save accepts a too-long brief in PERMISSIVE mode without --force (M2)", async () => {
    const { spawner } = makeStubSpawner();

    // Force the brief over the hard cap by passing --max-tokens 1 in STRICT
    // first to confirm the same brief WOULD be rejected, then re-run with
    // --save (PERMISSIVE) — which must accept it.
    let result = await handleHandoffCommand({
      argv: [FIXTURE_CHANNEL_ID, "--to", "claude", "--max-tokens", "1", "--wait-gap", "0"],
      stdout: stdoutBuf,
      stderr: stderrBuf,
      env: process.env,
      channelStore,
      providerProfileStore,
      spawner,
      now: () => fixedNow,
    });
    expect(result.exitCode).toBe(1);
    expect(stderrBuf.toString()).toMatch(/exceeds hard cap/);

    stdoutBuf = new WriteBuffer();
    stderrBuf = new WriteBuffer();
    result = await handleHandoffCommand({
      argv: [FIXTURE_CHANNEL_ID, "--save", "--max-tokens", "1", "--wait-gap", "0"],
      stdout: stdoutBuf,
      stderr: stderrBuf,
      env: process.env,
      channelStore,
      providerProfileStore,
      spawner,
      now: () => fixedNow,
    });
    expect(result.exitCode).toBe(0);
    // Permissive mode warns instead of erroring.
    expect(stderrBuf.toString()).toMatch(/Save accepted/);
  });

  it("--resume <briefId> --to claude reads ONLY <briefId>.gap.json (NOT <briefId>.md, per M7)", async () => {
    // Pre-place a saved brief pair on disk.
    const originalBriefId = "brief-1746604800000-aabbcc";
    const handoffsDir = join(env.channelsDir, FIXTURE_CHANNEL_ID, "handoffs");
    await mkdir(handoffsDir, { recursive: true });
    const gap = buildGap(originalBriefId);
    await writeFile(join(handoffsDir, `${originalBriefId}.gap.json`), JSON.stringify(gap));
    await writeFile(
      join(handoffsDir, `${originalBriefId}.md`),
      "# OLD BRIEF SNAPSHOT — must NOT be re-read"
    );

    // M7 — the .md is a snapshot, never re-fed into buildBrief. Strongest
    // proof: delete the .md before --resume runs. If anything in the resume
    // path tries to read it, the call would surface ENOENT and fail the test.
    // Combined with the non-poisoned-content assertion below, this fully
    // demonstrates "ONLY the gap.json is consumed".
    await unlink(join(handoffsDir, `${originalBriefId}.md`));

    const { spawner, calls } = makeStubSpawner();

    const result = await handleHandoffCommand({
      argv: [FIXTURE_CHANNEL_ID, "--resume", originalBriefId, "--to", "claude", "--wait-gap", "0"],
      stdout: stdoutBuf,
      stderr: stderrBuf,
      env: process.env,
      channelStore,
      providerProfileStore,
      spawner,
      now: () => fixedNow,
    });

    expect(result.exitCode).toBe(0);
    expect(calls).toHaveLength(1);

    // The new brief carries resumedFrom and the rendered markdown shows it.
    const briefMd = calls[0].input.briefMarkdown;
    expect(briefMd).toContain(`**Resumed from:** ${originalBriefId}`);

    // The poisoned snapshot content is NOT present in the new brief — extra
    // belt-and-suspenders proof we never ingested the .md.
    expect(briefMd).not.toContain("OLD BRIEF SNAPSHOT");

    // The new brief also re-uses the saved gap-fill content.
    expect(briefMd).toContain("Investigate T-3 timeout via fixture");

    // The on-disk new brief id is distinct from the resume target.
    const filesAfter = await readdir(handoffsDir);
    const newMdFiles = filesAfter
      .filter((n) => n.endsWith(".md") && !n.startsWith(originalBriefId))
      .sort();
    expect(newMdFiles.length).toBeGreaterThanOrEqual(1);
  });

  it("--resume latest --to claude resolves to the newest brief in handoffs/", async () => {
    const handoffsDir = join(env.channelsDir, FIXTURE_CHANNEL_ID, "handoffs");
    await mkdir(handoffsDir, { recursive: true });

    // Three briefs at different timestamps. Newest = brief-3.
    const ids = [
      "brief-1746000000000-aaaaaa", // oldest
      "brief-1746500000000-bbbbbb",
      "brief-1747000000000-cccccc", // newest
    ];
    for (const id of ids) {
      await writeFile(join(handoffsDir, `${id}.gap.json`), JSON.stringify(buildGap(id)));
      await writeFile(join(handoffsDir, `${id}.md`), "# snapshot — must not be re-read");
    }

    const { spawner, calls } = makeStubSpawner();

    const result = await handleHandoffCommand({
      argv: [FIXTURE_CHANNEL_ID, "--resume", "latest", "--to", "claude", "--wait-gap", "0"],
      stdout: stdoutBuf,
      stderr: stderrBuf,
      env: process.env,
      channelStore,
      providerProfileStore,
      spawner,
      now: () => fixedNow,
    });

    expect(result.exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].input.briefMarkdown).toContain("**Resumed from:** brief-1747000000000-cccccc");
  });
});
