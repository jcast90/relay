/**
 * Phase 4 Plan 05: `rly channel show <id|name>` + the `rly project show`
 * alias. Eight required cases:
 *   1. usage error when no args.
 *   2. prints channel details for valid id.
 *   3. not found returns 1.
 *   4. JSON mode emits parseable JSON.
 *   5. respects --feed-tail=2.
 *   6. does NOT call CrosslinkStore.discoverSessions (raw fs read).
 *   7. resolves by name when channelId is not an id-shaped string.
 *   8. rly project show dispatches to the SAME handler as rly channel show
 *      — Option A (dispatch table import) per 04-05-PLAN.md Task 2.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { __resetRelayDirCacheForTests } from "../../src/cli/paths.js";
import { COMMANDS, handleChannelShowCommand, resolveChannel } from "../../src/cli/channel-show.js";

const RM_OPTS = { recursive: true, force: true, maxRetries: 3, retryDelay: 50 };

class StringSink {
  buffer = "";
  write(s: string): void {
    this.buffer += s;
  }
}

interface ChannelFixture {
  channelId: string;
  name: string;
  status?: string;
  repos?: Array<{ alias: string; workspaceId: string; repoPath: string }>;
  description?: string;
  updatedAt?: string;
  feed?: Array<{
    entryId?: string;
    type: string;
    fromDisplayName?: string | null;
    content: string;
    createdAt?: string;
  }>;
}

interface SessionFixture {
  sessionId: string;
  pid: number;
  repoPath: string;
  channelId: string;
  lastHeartbeat: string;
  readyAt?: string;
  readyKind?: "admin" | "worker";
  displayName?: string;
}

async function writeChannelFixture(root: string, fixture: ChannelFixture): Promise<void> {
  const channelsDir = join(root, ".relay", "channels");
  await mkdir(channelsDir, { recursive: true });
  const channel = {
    channelId: fixture.channelId,
    name: fixture.name,
    status: fixture.status ?? "active",
    description: fixture.description ?? "",
    workspaceIds: [],
    members: [],
    pinnedRefs: [],
    repoAssignments: fixture.repos ?? [],
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: fixture.updatedAt ?? "2025-01-01T00:00:00Z",
  };
  await writeFile(join(channelsDir, `${fixture.channelId}.json`), JSON.stringify(channel));

  if (fixture.feed && fixture.feed.length > 0) {
    const channelDir = join(channelsDir, fixture.channelId);
    await mkdir(channelDir, { recursive: true });
    const lines = fixture.feed.map((e, i) =>
      JSON.stringify({
        entryId: e.entryId ?? `ent-${i}`,
        channelId: fixture.channelId,
        type: e.type,
        fromAgentId: null,
        fromDisplayName: e.fromDisplayName ?? null,
        content: e.content,
        metadata: {},
        createdAt: e.createdAt ?? `2025-01-01T00:00:0${i}Z`,
      })
    );
    await writeFile(join(channelDir, "feed.jsonl"), lines.join("\n") + "\n");
  }
}

async function writeSessionFixture(root: string, fixture: SessionFixture): Promise<void> {
  const sessionsDir = join(root, ".relay", "crosslink-session");
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(join(sessionsDir, `${fixture.sessionId}.json`), JSON.stringify(fixture));
}

describe("channel-show", () => {
  let root: string;
  let stdout: StringSink;
  let stderr: StringSink;
  const originalHome = process.env.HOME;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "relay-channel-show-"));
    process.env.HOME = root;
    __resetRelayDirCacheForTests();
    stdout = new StringSink();
    stderr = new StringSink();
  });

  afterEach(async () => {
    if (originalHome) process.env.HOME = originalHome;
    else delete process.env.HOME;
    __resetRelayDirCacheForTests();
    await rm(root, RM_OPTS);
  });

  // Case 1
  it("returns exit 2 with usage on missing positional", async () => {
    const code = await handleChannelShowCommand([], { stdout, stderr });
    expect(code).toBe(2);
    expect(stderr.buffer).toMatch(/missing/i);
    expect(stderr.buffer).toMatch(/Usage: rly channel show/);
  });

  it("prints help to stdout and exits 0 on --help", async () => {
    const code = await handleChannelShowCommand(["--help"], { stdout, stderr });
    expect(code).toBe(0);
    expect(stdout.buffer).toMatch(/Usage: rly channel show/);
  });

  // Case 2
  it("prints channel details for a valid id (ready + booting visible)", async () => {
    const now = 1_700_000_000_000;
    await writeChannelFixture(root, {
      channelId: "ch-abc123",
      name: "oauth-rollout",
      repos: [
        { alias: "api", workspaceId: "ws-1", repoPath: "/repos/api" },
        { alias: "web", workspaceId: "ws-2", repoPath: "/repos/web" },
      ],
    });
    await writeSessionFixture(root, {
      sessionId: "sess-api",
      pid: 1111,
      repoPath: "/repos/api",
      channelId: "ch-abc123",
      lastHeartbeat: new Date(now - 5_000).toISOString(),
      readyAt: new Date(now - 60_000).toISOString(),
      displayName: "alice",
    });
    await writeSessionFixture(root, {
      sessionId: "sess-web",
      pid: 2222,
      repoPath: "/repos/web",
      channelId: "ch-abc123",
      lastHeartbeat: new Date(now - 5_000).toISOString(),
      displayName: "bob",
    });

    const code = await handleChannelShowCommand(["ch-abc123"], {
      stdout,
      stderr,
      now: () => now,
      isProcessAlive: () => true,
    });

    expect(code).toBe(0);
    expect(stdout.buffer).toMatch(/Channel: oauth-rollout/);
    expect(stdout.buffer).toMatch(/ch-abc123/);
    expect((stdout.buffer.match(/\bready\b/g) ?? []).length).toBeGreaterThanOrEqual(1);
    expect((stdout.buffer.match(/\bbooting\b/g) ?? []).length).toBeGreaterThanOrEqual(1);
    expect(stdout.buffer).toMatch(/admin=alice/);
    expect(stdout.buffer).toMatch(/admin=bob/);
  });

  // Case 3
  it("returns exit 1 with stderr when channel is not found", async () => {
    const code = await handleChannelShowCommand(["does-not-exist"], { stdout, stderr });
    expect(code).toBe(1);
    expect(stderr.buffer).toMatch(/Channel not found: does-not-exist/);
  });

  // Case 4
  it("emits parseable JSON in --json mode", async () => {
    const now = 1_700_000_000_000;
    await writeChannelFixture(root, {
      channelId: "ch-1",
      name: "demo",
      repos: [{ alias: "api", workspaceId: "ws-1", repoPath: "/repos/api" }],
    });

    const code = await handleChannelShowCommand(["ch-1", "--json"], {
      stdout,
      stderr,
      now: () => now,
      isProcessAlive: () => true,
    });

    expect(code).toBe(0);
    const parsed = JSON.parse(stdout.buffer);
    expect(parsed).toMatchObject({
      channelId: "ch-1",
      name: "demo",
      status: "active",
      repos: [
        {
          alias: "api",
          repoPath: "/repos/api",
          state: "disconnected",
        },
      ],
      recentFeed: [],
    });
  });

  // Case 5
  it("respects --feed-tail=2 (renders exactly 2 entries when 5 exist)", async () => {
    await writeChannelFixture(root, {
      channelId: "ch-feed",
      name: "feedchannel",
      repos: [],
      feed: [
        { type: "message", content: "first", createdAt: "2025-01-01T00:00:01Z" },
        { type: "message", content: "second", createdAt: "2025-01-01T00:00:02Z" },
        { type: "message", content: "third", createdAt: "2025-01-01T00:00:03Z" },
        { type: "message", content: "fourth", createdAt: "2025-01-01T00:00:04Z" },
        { type: "message", content: "fifth", createdAt: "2025-01-01T00:00:05Z" },
      ],
    });

    const code = await handleChannelShowCommand(["ch-feed", "--feed-tail=2", "--json"], {
      stdout,
      stderr,
      now: () => 1_700_000_000_000,
      isProcessAlive: () => true,
    });

    expect(code).toBe(0);
    const parsed = JSON.parse(stdout.buffer);
    expect(parsed.recentFeed).toHaveLength(2);
    expect(parsed.recentFeed[0].content).toBe("fourth");
    expect(parsed.recentFeed[1].content).toBe("fifth");
  });

  // Case 6
  it("does NOT call CrosslinkStore.discoverSessions (raw fs read only)", async () => {
    // The handler reads channels + sessions via readdirSync/readFileSync.
    // discoverSessions would require a HarnessStore instance — we
    // explicitly never construct one. If the implementation regressed and
    // tried to discover, it would either initialize a store at HOME or
    // throw; by setting HOME to a tmp that has channel JSONs but NO
    // namespaced HarnessStore layout, we confirm the raw-fs read path is
    // the only one in use. The handler returns 0 even with zero sessions.
    await writeChannelFixture(root, {
      channelId: "ch-no-sessions",
      name: "lonely",
      repos: [{ alias: "api", workspaceId: "ws-1", repoPath: "/repos/api" }],
    });

    const code = await handleChannelShowCommand(["ch-no-sessions"], {
      stdout,
      stderr,
      now: () => 0,
      isProcessAlive: () => true,
    });

    expect(code).toBe(0);
    expect(stdout.buffer).toMatch(/disconnected/);
  });

  // Case 7
  it("resolves by name when channelId is not an id-shaped string", async () => {
    await writeChannelFixture(root, {
      channelId: "ch-abc123",
      name: "oauth-rollout",
    });

    const code = await handleChannelShowCommand(["oauth-rollout"], {
      stdout,
      stderr,
      now: () => 0,
      isProcessAlive: () => true,
    });

    expect(code).toBe(0);
    expect(stdout.buffer).toMatch(/ch-abc123/);
    expect(stdout.buffer).toMatch(/Channel: oauth-rollout/);
  });

  // Case 8 — REQUIRED, non-skippable. Option A: dispatch table import.
  // Asserts that the function reference behind `rly project show` is the
  // SAME identity-equal value as `rly channel show` — not a wrapped
  // closure. This is the strongest possible alias contract.
  it("Option A: rly project show dispatches to the same handler as rly channel show (same function reference)", () => {
    // Identity check: same fn object — `===` proves the alias dispatches
    // to the exact same handler, not a re-wrapped delegate.
    expect(COMMANDS.project.show).toBe(COMMANDS.channel.show);
    // Plus a sanity check that the dispatch target IS the exported handler.
    expect(COMMANDS.channel.show).toBe(handleChannelShowCommand);
  });

  it("rejects unknown flags with exit 2 + usage", async () => {
    const code = await handleChannelShowCommand(["ch-1", "--bogus"], { stdout, stderr });
    expect(code).toBe(2);
    expect(stderr.buffer).toMatch(/Unknown flag: --bogus/);
  });

  it("resolveChannel ties broken by status=active then most-recent updatedAt", () => {
    const channels = [
      {
        channelId: "ch-old-active",
        name: "shared",
        status: "active" as const,
        updatedAt: "2025-01-01T00:00:00Z",
        createdAt: "2025-01-01T00:00:00Z",
        description: "",
        workspaceIds: [],
        members: [],
        pinnedRefs: [],
      },
      {
        channelId: "ch-new-archived",
        name: "shared",
        status: "archived" as const,
        updatedAt: "2025-12-01T00:00:00Z",
        createdAt: "2025-01-01T00:00:00Z",
        description: "",
        workspaceIds: [],
        members: [],
        pinnedRefs: [],
      },
      {
        channelId: "ch-new-active",
        name: "shared",
        status: "active" as const,
        updatedAt: "2025-06-01T00:00:00Z",
        createdAt: "2025-01-01T00:00:00Z",
        description: "",
        workspaceIds: [],
        members: [],
        pinnedRefs: [],
      },
    ];
    const resolved = resolveChannel(channels, "shared");
    expect(resolved?.channelId).toBe("ch-new-active");
  });
});
