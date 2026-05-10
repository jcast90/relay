/**
 * Wave 4 / PR-4 — `rly handoff` CLI handler tests.
 *
 * Covers `--to <value>` mode dispatch (D-03), STRICT validation (M2),
 * Codex chat-seed argv (M6), the L4 best-effort recordDecision case, and the
 * D-06 placeholder fallback when no gap.json arrives in the wait window.
 */

import { cp, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ChannelStore } from "../../../src/channels/channel-store.js";
import { __resetRelayDirCacheForTests } from "../../../src/cli/paths.js";
import {
  buildClaudeChatArgv,
  buildCodexChatArgv,
  handleHandoffCommand,
  type HandoffSpawnInput,
  type HandoffSpawnResult,
} from "../../../src/cli/handoff.js";
import { ProviderProfileStore } from "../../../src/storage/provider-profile-store.js";

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

interface SpawnRecord {
  input: HandoffSpawnInput;
}

function makeStubSpawner(): {
  spawner: (input: HandoffSpawnInput) => Promise<HandoffSpawnResult>;
  calls: SpawnRecord[];
} {
  const calls: SpawnRecord[] = [];
  const spawner = async (input: HandoffSpawnInput): Promise<HandoffSpawnResult> => {
    calls.push({ input });
    return {
      newSessionId: `sess-stub-${input.adapter}-${calls.length}`,
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
  prevHome: string | undefined;
}> {
  const home = await mkdtemp(join(tmpdir(), "relay-handoff-cli-"));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  __resetRelayDirCacheForTests();
  const channelsDir = join(home, ".relay", "channels");
  await mkdir(channelsDir, { recursive: true });
  // ChannelStore manifest layout: <channelsDir>/<id>.json + <channelsDir>/<id>/{...}
  await cp(join(FIXTURE_DIR, "manifest.json"), join(channelsDir, `${FIXTURE_CHANNEL_ID}.json`));
  await cp(FIXTURE_DIR, join(channelsDir, FIXTURE_CHANNEL_ID), { recursive: true });
  return {
    home,
    channelsDir,
    prevHome,
    cleanup: async () => {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      __resetRelayDirCacheForTests();
      await rm(home, { recursive: true, force: true });
    },
  };
}

describe("rly handoff — `--to <value>` happy path (Wave 4)", () => {
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

  it("--to claude writes brief artifacts and dispatches with the brief markdown", async () => {
    const { spawner, calls } = makeStubSpawner();

    const result = await handleHandoffCommand({
      argv: [FIXTURE_CHANNEL_ID, "--to", "claude", "--wait-gap", "0"],
      stdout: stdoutBuf,
      stderr: stderrBuf,
      env: process.env,
      channelStore,
      providerProfileStore,
      spawner,
      now: () => fixedNow,
    });

    expect(result.exitCode).toBe(0);

    // Spawner saw the claude adapter and the brief markdown as the seed.
    expect(calls).toHaveLength(1);
    expect(calls[0].input.adapter).toBe("claude");
    expect(calls[0].input.briefMarkdown).toContain("# Handoff brief: fixture-min");
    expect(calls[0].input.briefMarkdown).toContain("**Channel id:** ch-fixmin-0001");

    // Brief artifacts exist on disk.
    const handoffsDir = join(env.channelsDir, FIXTURE_CHANNEL_ID, "handoffs");
    const files = await readdir(handoffsDir);
    expect(files.some((n) => n.endsWith(".md"))).toBe(true);
    expect(files.some((n) => n.endsWith(".gap.json"))).toBe(true);

    // Feed entry posted with metadata.handoff === true.
    const feed = await channelStore.readFeed(FIXTURE_CHANNEL_ID);
    const handoffEntry = feed.find(
      (e) => e.metadata && (e.metadata as Record<string, unknown>).handoff === true
    );
    expect(handoffEntry).toBeDefined();
    expect((handoffEntry?.metadata as Record<string, unknown>).toProvider).toBe("claude");
    expect((handoffEntry?.metadata as Record<string, unknown>).mode).toBe("to");

    // Stdout includes brief path + token estimate.
    expect(stdoutBuf.toString()).toMatch(/Wrote brief: /);
    expect(stdoutBuf.toString()).toMatch(/Token estimate: \d+/);
  });

  it("--to codex argv via buildCodexChatArgv drops --output-schema / -o / --ask-for-approval (M6)", () => {
    const argv = buildCodexChatArgv(
      {
        id: "x",
        displayName: "x",
        adapter: "codex",
        envOverrides: {},
        createdAt: "",
        updatedAt: "",
      },
      {
        channelId: "c",
        name: "n",
        description: "",
        status: "active",
        workspaceIds: [],
        members: [],
        pinnedRefs: [],
        createdAt: "2026-05-01T00:00:00.000Z",
        updatedAt: "2026-05-01T00:00:00.000Z",
      },
      "BRIEF",
      "/tmp/cwd"
    );
    expect(argv).not.toContain("--output-schema");
    expect(argv).not.toContain("-o");
    expect(argv).not.toContain("--ask-for-approval");
    // Sandbox is read-only by default.
    expect(argv).toContain("--sandbox");
    expect(argv[argv.indexOf("--sandbox") + 1]).toBe("read-only");
    // Brief is the trailing positional.
    expect(argv[argv.length - 1]).toBe("BRIEF");
  });

  it("--to codex respects channel.fullAccess by switching to workspace-write sandbox", () => {
    const argv = buildCodexChatArgv(
      null,
      {
        channelId: "c",
        name: "n",
        description: "",
        status: "active",
        workspaceIds: [],
        members: [],
        pinnedRefs: [],
        fullAccess: true,
        createdAt: "2026-05-01T00:00:00.000Z",
        updatedAt: "2026-05-01T00:00:00.000Z",
      },
      "BRIEF",
      "/tmp/cwd"
    );
    expect(argv[argv.indexOf("--sandbox") + 1]).toBe("workspace-write");
  });

  it("buildClaudeChatArgv produces a chat-seed argv with --output-format stream-json", () => {
    const argv = buildClaudeChatArgv(null, "BRIEF", null);
    expect(argv).toContain("-p");
    expect(argv).toContain("--output-format");
    expect(argv).toContain("stream-json");
    expect(argv).toContain("--verbose");
    expect(argv[argv.length - 1]).toBe("BRIEF");
  });

  it("--to <unknown> exits non-zero with the D-03 layered fallback error string", async () => {
    const { spawner, calls } = makeStubSpawner();

    const result = await handleHandoffCommand({
      argv: [FIXTURE_CHANNEL_ID, "--to", "no-such-thing", "--wait-gap", "0"],
      stdout: stdoutBuf,
      stderr: stderrBuf,
      env: process.env,
      channelStore,
      providerProfileStore,
      spawner,
      now: () => fixedNow,
    });

    expect(result.exitCode).toBe(1);
    expect(stderrBuf.toString()).toMatch(/Unknown --to value/);
    expect(stderrBuf.toString()).toMatch(/provider profile id/);
    expect(calls).toHaveLength(0);
  });

  it("secret-pattern in a decision exits non-zero in BOTH STRICT and PERMISSIVE; --force does NOT bypass", async () => {
    // Plant a decision that contains an AWS-shaped secret in its
    // description so the validator's secret-pattern check fires.
    await channelStore.recordDecision(FIXTURE_CHANNEL_ID, {
      title: "Ops note",
      description: "Rotate exposed key AKIA0123456789ABCDEF before commit.",
      rationale: "CI surfaced the leak.",
      alternatives: [],
      decidedBy: "ops",
      decidedByName: "ops",
      runId: null,
      ticketId: null,
      linkedArtifacts: [],
    });

    const { spawner, calls } = makeStubSpawner();

    // STRICT — --to with --force must NOT bypass the secret error.
    const strict = await handleHandoffCommand({
      argv: [FIXTURE_CHANNEL_ID, "--to", "claude", "--force", "--wait-gap", "0"],
      stdout: stdoutBuf,
      stderr: stderrBuf,
      env: process.env,
      channelStore,
      providerProfileStore,
      spawner,
      now: () => fixedNow,
    });
    expect(strict.exitCode).toBe(1);
    expect(stderrBuf.toString()).toMatch(/secret/i);
    expect(calls).toHaveLength(0);

    // PERMISSIVE — --save with a secret-pattern body must also exit 1.
    stdoutBuf = new WriteBuffer();
    stderrBuf = new WriteBuffer();
    const permissive = await handleHandoffCommand({
      argv: [FIXTURE_CHANNEL_ID, "--save", "--wait-gap", "0"],
      stdout: stdoutBuf,
      stderr: stderrBuf,
      env: process.env,
      channelStore,
      providerProfileStore,
      spawner,
      now: () => fixedNow,
    });
    expect(permissive.exitCode).toBe(1);
    expect(stderrBuf.toString()).toMatch(/secret/i);
  });

  it("--json mode emits a single-line JSON envelope with ok:true on success", async () => {
    const { spawner } = makeStubSpawner();

    const result = await handleHandoffCommand({
      argv: [FIXTURE_CHANNEL_ID, "--to", "claude", "--json", "--wait-gap", "0"],
      stdout: stdoutBuf,
      stderr: stderrBuf,
      env: process.env,
      channelStore,
      providerProfileStore,
      spawner,
      now: () => fixedNow,
    });
    expect(result.exitCode).toBe(0);

    const lines = stdoutBuf
      .toString()
      .trim()
      .split("\n")
      .filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    const envelope = JSON.parse(lines[0]);
    expect(envelope.ok).toBe(true);
    expect(envelope.channelId).toBe(FIXTURE_CHANNEL_ID);
    expect(envelope.briefId).toMatch(/^brief-[0-9]+-[a-z0-9]+$/);
    expect(envelope.briefPath).toBeTruthy();
    expect(envelope.toProvider).toBe("claude");
    expect(typeof envelope.tokenEstimate).toBe("number");
  });

  it("--wait-gap 0 with no gap-fill renders the [gap-fill not provided] placeholder (D-06)", async () => {
    const { spawner, calls } = makeStubSpawner();

    const result = await handleHandoffCommand({
      argv: [FIXTURE_CHANNEL_ID, "--to", "claude", "--wait-gap", "0"],
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
    const briefMd = calls[0].input.briefMarkdown;
    expect(briefMd).toContain("[gap-fill not provided]");
  });

  it("recordDecision throws → handoff still succeeds (L4 best-effort)", async () => {
    const { spawner, calls } = makeStubSpawner();

    // Wrap the channel store with a failing recordDecision. We use a
    // Proxy to delegate every other method through unchanged.
    const failing = new Proxy(channelStore, {
      get(target, prop, receiver) {
        if (prop === "recordDecision") {
          return async () => {
            throw new Error("simulated mirror failure");
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as ChannelStore;

    const result = await handleHandoffCommand({
      argv: [FIXTURE_CHANNEL_ID, "--to", "claude", "--wait-gap", "0"],
      stdout: stdoutBuf,
      stderr: stderrBuf,
      env: process.env,
      channelStore: failing,
      providerProfileStore,
      spawner,
      now: () => fixedNow,
    });

    expect(result.exitCode).toBe(0);
    expect(stderrBuf.toString()).toMatch(/recordDecision failed.*continuing/i);
    expect(calls).toHaveLength(1); // brief still dispatched

    // Re-read the on-disk brief to confirm artifacts landed.
    const handoffsDir = join(env.channelsDir, FIXTURE_CHANNEL_ID, "handoffs");
    const files = await readdir(handoffsDir);
    expect(files.some((n) => n.endsWith(".md"))).toBe(true);
    const md = await readFile(join(handoffsDir, files.find((n) => n.endsWith(".md"))!), "utf8");
    expect(md).toContain("# Handoff brief: fixture-min");
  });
});
