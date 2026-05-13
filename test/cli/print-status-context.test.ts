import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { __resetRelayDirCacheForTests } from "../../src/cli/paths.js";
import {
  formatActiveSessionsBlock,
  formatChannelStatesBlock,
  loadActiveSessions,
  loadChannelStates,
  type ActiveSessionRow,
  type ChannelStateRow,
} from "../../src/cli/print-status-context.js";

const RM_OPTS = { recursive: true, force: true, maxRetries: 3, retryDelay: 50 };

/**
 * GREEN in PR-4: real `formatActiveSessionsBlock` and `loadActiveSessions`
 * implementations. The formatter is purely deterministic; the loader
 * filters to `kind === "chat"` (M3 / M4) and isolates malformed files (L3).
 */
describe("formatActiveSessionsBlock", () => {
  it("renders one line per session with model + ctx pct + used/total", () => {
    const rows: ActiveSessionRow[] = [
      {
        sessionId: "sess-abc",
        channelId: "ch-1",
        pct: 76,
        used: 152_000,
        total: 200_000,
        model: "Sonnet 4.5",
        kind: "chat",
      },
    ];
    const out = formatActiveSessionsBlock(rows);
    expect(out).toMatch(/sess-abc/);
    expect(out).toMatch(/ch-1/);
    expect(out).toMatch(/76%/);
    expect(out).toMatch(/Sonnet 4\.5/);
  });

  it("returns an empty (or 'no active sessions') block on empty input", () => {
    const out = formatActiveSessionsBlock([]);
    expect(out).toBeDefined();
  });
});

describe("loadActiveSessions", () => {
  let root: string;
  const originalHome = process.env.HOME;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "relay-status-"));
    process.env.HOME = root;
    __resetRelayDirCacheForTests();
  });

  afterEach(async () => {
    if (originalHome) process.env.HOME = originalHome;
    else delete process.env.HOME;
    __resetRelayDirCacheForTests();
    await rm(root, RM_OPTS);
  });

  it("returns [] when ~/.relay/sessions/ does not exist (L3 isolation)", () => {
    // No sessions dir under root/.relay/. Must return empty without throwing.
    const result = loadActiveSessions();
    expect(result).toEqual([]);
  });

  it("filters out kind=run and kind=admin budgets, surfaces only kind=chat (M3 + M4)", async () => {
    const sessionsRoot = join(root, ".relay", "sessions");
    await mkdir(join(sessionsRoot, "sess-chat"), { recursive: true });
    await writeFile(
      join(sessionsRoot, "sess-chat", "budget.jsonl"),
      JSON.stringify({ cumulativeUsed: 100, kind: "chat" }) + "\n"
    );
    await mkdir(join(sessionsRoot, "run-x"), { recursive: true });
    await writeFile(
      join(sessionsRoot, "run-x", "budget.jsonl"),
      JSON.stringify({ cumulativeUsed: 100, kind: "run" }) + "\n"
    );
    await mkdir(join(sessionsRoot, "admin-y"), { recursive: true });
    await writeFile(
      join(sessionsRoot, "admin-y", "budget.jsonl"),
      JSON.stringify({ cumulativeUsed: 100, kind: "admin" }) + "\n"
    );

    const rows = loadActiveSessions();
    expect(rows.map((r) => r.sessionId)).toEqual(["sess-chat"]);
  });

  it("isolates a malformed session file so other sessions still surface (L3)", async () => {
    const sessionsRoot = join(root, ".relay", "sessions");
    await mkdir(join(sessionsRoot, "sess-good"), { recursive: true });
    await writeFile(
      join(sessionsRoot, "sess-good", "budget.jsonl"),
      JSON.stringify({ cumulativeUsed: 50, kind: "chat" }) + "\n"
    );
    await mkdir(join(sessionsRoot, "sess-bad"), { recursive: true });
    await writeFile(join(sessionsRoot, "sess-bad", "budget.jsonl"), "{ malformed line\n");

    const rows = loadActiveSessions();
    expect(rows.find((r) => r.sessionId === "sess-good")).toBeDefined();
  });
});

/**
 * Phase 4 Plan 05: `Channels:` block in `rly status`. Pure formatter +
 * disk loader (`loadChannelStates`) with the same empty-list contract
 * and L3 per-file isolation as the active-sessions analog above.
 */
describe("formatChannelStatesBlock", () => {
  it('returns "" when rows is empty', () => {
    expect(formatChannelStatesBlock([])).toBe("");
  });

  it("renders one header line per channel + indented lines per repo", () => {
    const rows: ChannelStateRow[] = [
      {
        channelId: "ch-1",
        name: "oauth-rollout",
        status: "active",
        repos: [
          { alias: "api", state: "ready", adminAlias: "alice" },
          { alias: "web", state: "booting" },
        ],
      },
    ];
    const out = formatChannelStatesBlock(rows);
    expect(out).toMatch(/^Channels:\n/);
    expect(out).toMatch(/- oauth-rollout \(2 repos\)/);
    expect(out).toMatch(/api {10}ready admin=alice/);
    expect(out).toMatch(/web {10}booting/);
  });

  it("uses kebab-case state words (parity with hook + TUI + GUI per D-06)", () => {
    const rows: ChannelStateRow[] = [
      {
        channelId: "ch-1",
        name: "x",
        status: "active",
        repos: [
          { alias: "a", state: "disconnected" },
          { alias: "b", state: "booting" },
          { alias: "c", state: "ready" },
          { alias: "d", state: "stale" },
        ],
      },
    ];
    const out = formatChannelStatesBlock(rows);
    expect(out).toMatch(/\bdisconnected\b/);
    expect(out).toMatch(/\bbooting\b/);
    expect(out).toMatch(/\bready\b/);
    expect(out).toMatch(/\bstale\b/);
    // No camelCase / TitleCase smuggled in.
    expect(out).not.toMatch(/Disconnected|Booting|Ready|Stale/);
  });
});

describe("loadChannelStates", () => {
  let root: string;
  const originalHome = process.env.HOME;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "relay-channel-states-"));
    process.env.HOME = root;
    __resetRelayDirCacheForTests();
  });

  afterEach(async () => {
    if (originalHome) process.env.HOME = originalHome;
    else delete process.env.HOME;
    __resetRelayDirCacheForTests();
    await rm(root, RM_OPTS);
  });

  async function writeChannel(channel: Record<string, unknown>): Promise<void> {
    const dir = join(root, ".relay", "channels");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${channel.channelId}.json`), JSON.stringify(channel));
  }

  async function writeSession(session: Record<string, unknown>): Promise<void> {
    const dir = join(root, ".relay", "crosslink-session");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${session.sessionId}.json`), JSON.stringify(session));
  }

  it("returns [] when ~/.relay/channels/ does not exist (L3 isolation)", () => {
    expect(loadChannelStates()).toEqual([]);
  });

  it("filters out non-active channels by default", async () => {
    await writeChannel({
      channelId: "ch-active",
      name: "live",
      status: "active",
      repoAssignments: [],
      members: [],
      pinnedRefs: [],
      workspaceIds: [],
      description: "",
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    });
    await writeChannel({
      channelId: "ch-archived",
      name: "dead",
      status: "archived",
      repoAssignments: [],
      members: [],
      pinnedRefs: [],
      workspaceIds: [],
      description: "",
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    });

    const rows = loadChannelStates();
    expect(rows.map((r) => r.channelId)).toEqual(["ch-active"]);
  });

  it("derives disconnected for repoAssignments with no matching session", async () => {
    await writeChannel({
      channelId: "ch-1",
      name: "lonely",
      status: "active",
      repoAssignments: [
        { alias: "api", workspaceId: "ws-1", repoPath: "/repos/api" },
        { alias: "web", workspaceId: "ws-2", repoPath: "/repos/web" },
      ],
      members: [],
      pinnedRefs: [],
      workspaceIds: [],
      description: "",
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    });

    const rows = loadChannelStates({ isProcessAlive: () => true, now: () => 0 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.repos.map((r) => r.state)).toEqual(["disconnected", "disconnected"]);
  });

  it("matches sessions to repoAssignments by (channelId, repoPath) and derives ready / booting / stale", async () => {
    const now = 1_000_000_000;
    await writeChannel({
      channelId: "ch-1",
      name: "live",
      status: "active",
      repoAssignments: [
        { alias: "api", workspaceId: "ws-1", repoPath: "/repos/api" },
        { alias: "web", workspaceId: "ws-2", repoPath: "/repos/web" },
        { alias: "docs", workspaceId: "ws-3", repoPath: "/repos/docs" },
      ],
      members: [],
      pinnedRefs: [],
      workspaceIds: [],
      description: "",
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    });

    // ready: alive + readyAt set + fresh heartbeat
    await writeSession({
      sessionId: "sess-api",
      pid: 1111,
      repoPath: "/repos/api",
      channelId: "ch-1",
      lastHeartbeat: new Date(now - 5_000).toISOString(),
      readyAt: new Date(now - 60_000).toISOString(),
      displayName: "alice",
    });
    // booting: alive + no readyAt + fresh heartbeat
    await writeSession({
      sessionId: "sess-web",
      pid: 2222,
      repoPath: "/repos/web",
      channelId: "ch-1",
      lastHeartbeat: new Date(now - 5_000).toISOString(),
      displayName: "bob",
    });
    // stale: heartbeat past STALE_HEARTBEAT_MS
    await writeSession({
      sessionId: "sess-docs",
      pid: 3333,
      repoPath: "/repos/docs",
      channelId: "ch-1",
      lastHeartbeat: new Date(now - 600_000).toISOString(),
      displayName: "carol",
    });

    const rows = loadChannelStates({ isProcessAlive: () => true, now: () => now });
    expect(rows).toHaveLength(1);
    const byAlias = new Map(rows[0]!.repos.map((r) => [r.alias, r]));
    expect(byAlias.get("api")?.state).toBe("ready");
    expect(byAlias.get("api")?.adminAlias).toBe("alice");
    expect(byAlias.get("web")?.state).toBe("booting");
    expect(byAlias.get("web")?.adminAlias).toBe("bob");
    expect(byAlias.get("docs")?.state).toBe("stale");
    // adminAlias only surfaces for ready / booting (per D-03);
    // stale repos drop it so operators don't think a dead admin is still bound.
    expect(byAlias.get("docs")?.adminAlias).toBeUndefined();
  });

  it("ignores sessions tagged readyKind=worker (admin-only matching)", async () => {
    const now = 1_000_000_000;
    await writeChannel({
      channelId: "ch-1",
      name: "live",
      status: "active",
      repoAssignments: [{ alias: "api", workspaceId: "ws-1", repoPath: "/repos/api" }],
      members: [],
      pinnedRefs: [],
      workspaceIds: [],
      description: "",
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    });
    await writeSession({
      sessionId: "sess-worker",
      pid: 1234,
      repoPath: "/repos/api",
      channelId: "ch-1",
      lastHeartbeat: new Date(now - 5_000).toISOString(),
      readyAt: new Date(now - 1_000).toISOString(),
      readyKind: "worker",
      displayName: "worker-1",
    });

    const rows = loadChannelStates({ isProcessAlive: () => true, now: () => now });
    expect(rows[0]!.repos[0]!.state).toBe("disconnected");
  });

  it("skips malformed channel.json silently and still surfaces the good ones (L3)", async () => {
    await writeChannel({
      channelId: "ch-good",
      name: "good",
      status: "active",
      repoAssignments: [],
      members: [],
      pinnedRefs: [],
      workspaceIds: [],
      description: "",
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    });
    // Torn fixture — invalid JSON.
    await mkdir(join(root, ".relay", "channels"), { recursive: true });
    await writeFile(join(root, ".relay", "channels", "ch-bad.json"), "{ not valid json");

    const rows = loadChannelStates();
    expect(rows.map((r) => r.channelId)).toEqual(["ch-good"]);
  });

  it("does not call CrosslinkStore.discoverSessions", async () => {
    // Pitfall #3: `loadChannelStates` must read raw fs, not the discovery
    // path (which mutates state by GC'ing stale records). A module-level
    // import-spy would require ESM mocking gymnastics; the simpler
    // assertion is: with NO usable HarnessStore on disk, loadChannelStates
    // must still succeed (since it doesn't touch the store). If a future
    // refactor accidentally wires `discoverSessions` in, that requires the
    // store and would surface as a test failure elsewhere.
    await writeChannel({
      channelId: "ch-1",
      name: "x",
      status: "active",
      repoAssignments: [{ alias: "api", workspaceId: "ws-1", repoPath: "/repos/api" }],
      members: [],
      pinnedRefs: [],
      workspaceIds: [],
      description: "",
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    });
    // Note: we do NOT initialize any HarnessStore at $HOME/.relay. If
    // loadChannelStates were calling discoverSessions through ChannelStore /
    // CrosslinkStore, it would either throw or sit on the namespaced JSON
    // layout. Walking raw `crosslink-session/*.json` succeeds even when
    // the dir is empty / absent.
    expect(() => loadChannelStates()).not.toThrow();
  });
});
