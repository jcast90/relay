import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { __resetRelayDirCacheForTests } from "../../src/cli/paths.js";
import {
  generateSessionStartHookScripts,
  getClaudeSessionStartHookConfig,
} from "../../src/crosslink/hook.js";
import { deriveRepoAdminState } from "../../src/domain/repo-admin-state.js";

/**
 * Phase 4 Plan 02 Task 2 — SessionStart hook generator + script body tests.
 *
 * The generated `.mjs` script is a standalone string-template. If its body
 * drifts (typo in a path segment, wrong glyph, missing branch in the
 * inlined deriveRepoAdminState) the runtime impact is silent — the agent's
 * first turn quietly stops showing repo context, and nothing else catches
 * it. These tests pin the template shape, prove the chmod + dir layout,
 * and execute the script against a tmpdir-rooted relay fixture to verify
 * end-to-end resolution, formatting, and graceful no-op behavior.
 *
 * The behavioral-equivalence test (`generated_mjs_formatter_matches_TS_…`)
 * closes the inlined-duplication gap: any future drift in the inlined
 * branch order, STALE_HEARTBEAT_MS constant, or the isProcessAlive shim is
 * caught against the TS reference, not at runtime.
 */
describe("generateSessionStartHookScripts (Phase 4 Plan 02 Task 2)", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "session-start-hook-"));
    prevHome = process.env.HOME;
    process.env.HOME = home;
    __resetRelayDirCacheForTests();
  });

  afterEach(async () => {
    if (prevHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = prevHome;
    }
    __resetRelayDirCacheForTests();
    await rm(home, { recursive: true, force: true });
  });

  it("writes both files under ~/.relay/crosslink/hooks/ with chmod 755 on the shell wrapper", async () => {
    const { shellScriptPath, nodeScriptPath } = await generateSessionStartHookScripts();

    // Layout invariant — same dir as the existing UserPromptSubmit hook so a
    // single `rly install` can scan one directory.
    expect(shellScriptPath).toContain("/.relay/crosslink/hooks/session-start.sh");
    expect(nodeScriptPath).toContain("/.relay/crosslink/hooks/session-start.mjs");

    const shellStat = await stat(shellScriptPath);
    // 0o111 = "any execute bit set". Don't pin owner/group/other modes —
    // the umask of the test process may strip group/other bits.
    expect(shellStat.mode & 0o111).toBeGreaterThan(0);

    // Node script doesn't need exec bit (shell wrapper invokes node directly)
    // but must exist and be readable.
    const nodeStat = await stat(nodeScriptPath);
    expect(nodeStat.isFile()).toBe(true);
  });

  it("emits a node script containing all four state strings (inlined derivation)", async () => {
    const { nodeScriptPath } = await generateSessionStartHookScripts();
    const script = await readFile(nodeScriptPath, "utf8");

    // Closed-enum vocabulary must appear literally in the script template —
    // the inlined deriveRepoAdminState branches on these.
    expect(script).toMatch(/"disconnected"/);
    expect(script).toMatch(/"booting"/);
    expect(script).toMatch(/"ready"/);
    expect(script).toMatch(/"stale"/);
  });

  it("emits STALE_HEARTBEAT_MS = 120_000 literally — guardrail against drift from src/domain/repo-admin-state.ts", async () => {
    const { nodeScriptPath } = await generateSessionStartHookScripts();
    const script = await readFile(nodeScriptPath, "utf8");
    expect(script).toContain("STALE_HEARTBEAT_MS = 120_000");
  });

  it("does NOT reference discoverSessions — Pitfall #3 enforcement at the script-template level", async () => {
    const { nodeScriptPath } = await generateSessionStartHookScripts();
    const script = await readFile(nodeScriptPath, "utf8");
    expect(script).not.toContain("discoverSessions");
  });

  it("shell wrapper invokes the node script and exits 0 explicitly", async () => {
    const { shellScriptPath, nodeScriptPath } = await generateSessionStartHookScripts();
    const shell = await readFile(shellScriptPath, "utf8");
    expect(shell).toContain(nodeScriptPath);
    // Belt-and-suspenders: hooks must never block session start. The wrapper
    // has an explicit `exit 0` after the node call so a non-zero exit from
    // node still produces a clean shell exit.
    expect(shell).toContain("exit 0");
  });

  it("getClaudeSessionStartHookConfig returns a SessionStart hook config (not UserPromptSubmit)", () => {
    const cfg = getClaudeSessionStartHookConfig("/some/path/session-start.sh") as {
      hooks: { SessionStart: Array<{ type: string; command: string }> };
    };
    expect(cfg.hooks.SessionStart).toBeDefined();
    expect(cfg.hooks.SessionStart[0]).toEqual({
      type: "command",
      command: "/some/path/session-start.sh",
    });
  });

  // ----- End-to-end execution tests against a tmpdir-rooted fixture -----

  /**
   * Seed a relay dir with a single active channel plus per-repo
   * crosslink-session records. Returns the relay dir path so the test can
   * pass it as RELAY_DIR.
   */
  async function seedRelayDir(opts: {
    channelId: string;
    channelName: string;
    repoAssignments: Array<{ alias: string; workspaceId: string; repoPath: string }>;
    sessions: Array<Record<string, unknown>>;
    feedEntries?: number;
  }): Promise<string> {
    const relayDir = join(home, ".relay");
    await mkdir(join(relayDir, "channels"), { recursive: true });
    await mkdir(join(relayDir, "channels", opts.channelId), { recursive: true });
    await mkdir(join(relayDir, "crosslink-session"), { recursive: true });

    await writeFile(
      join(relayDir, "channels", `${opts.channelId}.json`),
      JSON.stringify({
        channelId: opts.channelId,
        name: opts.channelName,
        description: "test channel",
        status: "active",
        workspaceIds: [],
        members: [],
        pinnedRefs: [],
        repoAssignments: opts.repoAssignments,
        createdAt: "2026-05-13T00:00:00Z",
        updatedAt: "2026-05-13T00:00:00Z",
      })
    );

    for (const sess of opts.sessions) {
      await writeFile(
        join(relayDir, "crosslink-session", `${sess.sessionId}.json`),
        JSON.stringify(sess)
      );
    }

    if (opts.feedEntries && opts.feedEntries > 0) {
      const lines: string[] = [];
      for (let i = 0; i < opts.feedEntries; i++) {
        lines.push(
          JSON.stringify({
            entryId: `entry-${i}`,
            channelId: opts.channelId,
            type: "message",
            fromAgentId: null,
            fromDisplayName: "system",
            content: `entry ${i}`,
            metadata: {},
            createdAt: new Date(Date.now() - (opts.feedEntries! - i) * 1000).toISOString(),
          })
        );
      }
      await writeFile(join(relayDir, "channels", opts.channelId, "feed.jsonl"), lines.join("\n") + "\n");
    }

    return relayDir;
  }

  function runHook(
    scriptPath: string,
    env: Record<string, string | undefined>
  ): { stdout: string; exitCode: number } {
    try {
      const stdout = execFileSync(process.execPath, [scriptPath], {
        env: { ...process.env, ...env },
        encoding: "utf8",
        input: "{}",
      });
      return { stdout, exitCode: 0 };
    } catch (err) {
      const e = err as { stdout?: string; status?: number };
      return { stdout: e.stdout ?? "", exitCode: e.status ?? 1 };
    }
  }

  it("end-to-end: RELAY_CHANNEL_ID set → resolves channel, renders ready + booting rows", async () => {
    const { nodeScriptPath } = await generateSessionStartHookScripts();
    const relayDir = await seedRelayDir({
      channelId: "oauth",
      channelName: "oauth",
      repoAssignments: [
        { alias: "ui-repo", workspaceId: "ws-ui", repoPath: "/tmp/ui-repo" },
        { alias: "backend-repo", workspaceId: "ws-be", repoPath: "/tmp/backend-repo" },
      ],
      sessions: [
        {
          sessionId: "sid1",
          pid: process.pid, // alive
          repoPath: "/tmp/ui-repo",
          channelId: "oauth",
          description: "ui admin",
          capabilities: [],
          agentProvider: "claude",
          status: "active",
          displayName: "atlas-7f2",
          registeredAt: new Date(Date.now() - 30_000).toISOString(),
          lastHeartbeat: new Date().toISOString(),
          readyAt: new Date().toISOString(), // ready
          readyKind: "admin",
        },
        {
          sessionId: "sid2",
          pid: process.pid, // alive
          repoPath: "/tmp/backend-repo",
          channelId: "oauth",
          description: "be admin",
          capabilities: [],
          agentProvider: "claude",
          status: "active",
          registeredAt: new Date(Date.now() - 30_000).toISOString(),
          lastHeartbeat: new Date().toISOString(),
          // no readyAt — booting
        },
      ],
    });

    const t0 = Date.now();
    const { stdout, exitCode } = runHook(nodeScriptPath, {
      RELAY_DIR: relayDir,
      RELAY_CHANNEL_ID: "oauth",
      RELAY_SESSION_ID: undefined,
    });
    const elapsed = Date.now() - t0;

    expect(exitCode).toBe(0);
    expect(stdout).toContain("[Relay] Channel: oauth");

    // "ready" appears exactly once (the first repo row)
    const readyMatches = stdout.match(/\bready\b/g) ?? [];
    expect(readyMatches.length).toBe(1);

    // "booting" appears exactly once (the second repo row)
    const bootingMatches = stdout.match(/\bbooting\b/g) ?? [];
    expect(bootingMatches.length).toBe(1);

    // Informational timing log — Pitfall #6 budget is < 100ms, but we don't
    // gate on it in CI (test infrastructure noise can spike).
    // eslint-disable-next-line no-console
    console.log(`[session-start-hook] e2e render duration: ${elapsed}ms`);
  });

  it("end-to-end: RELAY_CHANNEL_ID UNSET, cwd matches a repo → still resolves channel via cwd reverse lookup", async () => {
    const { nodeScriptPath } = await generateSessionStartHookScripts();
    const relayDir = await seedRelayDir({
      channelId: "oauth2",
      channelName: "oauth2",
      repoAssignments: [{ alias: "sdk-repo", workspaceId: "ws-sdk", repoPath: "/tmp/sdk-repo-fixture" }],
      sessions: [
        {
          sessionId: "sid-sdk",
          pid: process.pid,
          repoPath: "/tmp/sdk-repo-fixture",
          channelId: "oauth2",
          description: "sdk",
          capabilities: [],
          agentProvider: "claude",
          status: "active",
          registeredAt: new Date(Date.now() - 30_000).toISOString(),
          lastHeartbeat: new Date().toISOString(),
          readyAt: new Date().toISOString(),
        },
      ],
    });

    // Pipe cwd via stdin (Claude's SessionStart payload format).
    const stdinPayload = JSON.stringify({ cwd: "/tmp/sdk-repo-fixture" });
    let stdout = "";
    let exitCode = 0;
    try {
      stdout = execFileSync(process.execPath, [nodeScriptPath], {
        env: {
          ...process.env,
          RELAY_DIR: relayDir,
          RELAY_CHANNEL_ID: "",
          RELAY_SESSION_ID: "",
        },
        encoding: "utf8",
        input: stdinPayload,
      });
    } catch (err) {
      const e = err as { stdout?: string; status?: number };
      stdout = e.stdout ?? "";
      exitCode = e.status ?? 1;
    }

    expect(exitCode).toBe(0);
    expect(stdout).toContain("[Relay] Channel: oauth2");
    expect(stdout).toContain("sdk-repo");
  });

  it("end-to-end: RELAY_CHANNEL_ID points at a missing channel and cwd is outside any channel → graceful no-op (exit 0, empty stdout)", async () => {
    const { nodeScriptPath } = await generateSessionStartHookScripts();
    const relayDir = join(home, ".relay");
    await mkdir(join(relayDir, "channels"), { recursive: true });
    await mkdir(join(relayDir, "crosslink-session"), { recursive: true });

    const { stdout, exitCode } = runHook(nodeScriptPath, {
      RELAY_DIR: relayDir,
      RELAY_CHANNEL_ID: "does-not-exist",
      RELAY_SESSION_ID: undefined,
    });

    expect(exitCode).toBe(0);
    expect(stdout).toBe("");
  });

  it("Feed: tail is OMITTED when RELAY_SESSION_ID is unset", async () => {
    const { nodeScriptPath } = await generateSessionStartHookScripts();
    const relayDir = await seedRelayDir({
      channelId: "oauth",
      channelName: "oauth",
      repoAssignments: [{ alias: "ui", workspaceId: "w", repoPath: "/tmp/u" }],
      sessions: [],
      feedEntries: 5,
    });

    const { stdout, exitCode } = runHook(nodeScriptPath, {
      RELAY_DIR: relayDir,
      RELAY_CHANNEL_ID: "oauth",
      RELAY_SESSION_ID: undefined,
    });

    expect(exitCode).toBe(0);
    // The Feed: tail MUST be absent — user-launched sessions have no
    // watermark to subtract against, and emitting "Feed: 5 new" every
    // session start would be noisy.
    expect(stdout).not.toMatch(/^Feed:/m);
    expect(stdout).not.toMatch(/new entries since/);
    // But the header + per-repo lines still render.
    expect(stdout).toMatch(/^\[Relay\] Channel:/m);
  });

  it("Feed: tail RENDERS when RELAY_SESSION_ID matches an existing session with lastSeenFeedIdx < total", async () => {
    const { nodeScriptPath } = await generateSessionStartHookScripts();
    const relayDir = await seedRelayDir({
      channelId: "oauth",
      channelName: "oauth",
      repoAssignments: [{ alias: "ui", workspaceId: "w", repoPath: "/tmp/u" }],
      sessions: [
        {
          sessionId: "sid1",
          pid: process.pid,
          repoPath: "/tmp/u",
          channelId: "oauth",
          description: "ui",
          capabilities: [],
          agentProvider: "claude",
          status: "active",
          registeredAt: new Date().toISOString(),
          lastHeartbeat: new Date().toISOString(),
          readyAt: new Date().toISOString(),
          lastSeenFeedIdx: 2, // 5 total − 2 seen = 3 new
        },
      ],
      feedEntries: 5,
    });

    const { stdout, exitCode } = runHook(nodeScriptPath, {
      RELAY_DIR: relayDir,
      RELAY_CHANNEL_ID: "oauth",
      RELAY_SESSION_ID: "sid1",
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Feed: 3 new entries");
    expect(stdout).toContain("`rly status`");
  });

  // ----- Behavioral-equivalence: inlined .mjs ↔ TS deriveRepoAdminState -----

  it("generated_mjs_formatter_matches_TS_deriveRepoAdminState_for_all_4_states", async () => {
    // Closes the inlined-duplication gap (WARNING #3 in PLAN). Build the
    // same 4-state truth-table the TS test in
    // `test/domain/repo-admin-state.test.ts` exercises, then run the
    // inlined `.mjs` derivation against each entry and compare the emitted
    // state word against the TS reference.
    const { nodeScriptPath } = await generateSessionStartHookScripts();

    const now = Date.now();
    const aliveFreshReady = {
      pid: process.pid,
      lastHeartbeat: new Date(now - 1_000).toISOString(),
      readyAt: new Date(now - 500).toISOString(),
    };
    const aliveFreshNoReady = {
      pid: process.pid,
      lastHeartbeat: new Date(now - 1_000).toISOString(),
    };
    const aliveAged = {
      pid: process.pid,
      lastHeartbeat: new Date(now - 200_000).toISOString(), // > STALE_HEARTBEAT_MS
    };
    const deadPidWithReady = {
      pid: 999_999, // above macOS pid_max 99999 → kill(0) ESRCH
      lastHeartbeat: new Date(now - 1_000).toISOString(),
      readyAt: new Date(now - 500).toISOString(),
    };

    type FixtureEntry = {
      label: string;
      session: { pid: number; lastHeartbeat: string; readyAt?: string } | null;
      expectedState: "disconnected" | "booting" | "ready" | "stale";
    };

    const fixtures: FixtureEntry[] = [
      { label: "no session → disconnected", session: null, expectedState: "disconnected" },
      { label: "alive+fresh+ready → ready", session: aliveFreshReady, expectedState: "ready" },
      { label: "alive+fresh+no-ready → booting", session: aliveFreshNoReady, expectedState: "booting" },
      { label: "alive+aged-heartbeat → stale", session: aliveAged, expectedState: "stale" },
      {
        label: "dead-pid+ready → stale (stale wins over ready)",
        session: deadPidWithReady,
        expectedState: "stale",
      },
    ];

    for (const fix of fixtures) {
      // 1. TS reference
      const tsState = deriveRepoAdminState(
        fix.session,
        now,
        (pid) => {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        }
      );
      expect(tsState).toBe(fix.expectedState);

      // 2. Inlined .mjs reference — drive via the generated script.
      //    Seed a fixture channel + (optionally) a session, run the script,
      //    parse the state word out of stdout.
      const fixHome = await mkdtemp(join(tmpdir(), `equiv-${fix.label.replace(/\W+/g, "-")}-`));
      const fixRelayDir = join(fixHome, ".relay");
      await mkdir(join(fixRelayDir, "channels"), { recursive: true });
      await mkdir(join(fixRelayDir, "channels", "fix"), { recursive: true });
      await mkdir(join(fixRelayDir, "crosslink-session"), { recursive: true });

      await writeFile(
        join(fixRelayDir, "channels", "fix.json"),
        JSON.stringify({
          channelId: "fix",
          name: "fix",
          description: "",
          status: "active",
          workspaceIds: [],
          members: [],
          pinnedRefs: [],
          repoAssignments: [{ alias: "r", workspaceId: "w", repoPath: "/tmp/r" }],
          createdAt: "2026-05-13T00:00:00Z",
          updatedAt: "2026-05-13T00:00:00Z",
        })
      );

      if (fix.session) {
        await writeFile(
          join(fixRelayDir, "crosslink-session", "sx.json"),
          JSON.stringify({
            sessionId: "sx",
            pid: fix.session.pid,
            repoPath: "/tmp/r",
            channelId: "fix",
            description: "",
            capabilities: [],
            agentProvider: "claude",
            status: "active",
            registeredAt: fix.session.lastHeartbeat,
            lastHeartbeat: fix.session.lastHeartbeat,
            ...(fix.session.readyAt ? { readyAt: fix.session.readyAt, readyKind: "admin" } : {}),
          })
        );
      }

      let stdout = "";
      try {
        stdout = execFileSync(process.execPath, [nodeScriptPath], {
          env: { ...process.env, RELAY_DIR: fixRelayDir, RELAY_CHANNEL_ID: "fix" },
          encoding: "utf8",
          input: "{}",
        });
      } catch (err) {
        stdout = (err as { stdout?: string }).stdout ?? "";
      }

      // Per-repo line: `  <glyph> <alias-padded> <state>...`
      const repoLine = stdout
        .split("\n")
        .find((l) => l.trimStart().startsWith("●") || l.trimStart().startsWith("○") || l.trimStart().startsWith("×") || l.trimStart().startsWith("·"));
      expect(repoLine, `[${fix.label}] expected a repo line in stdout, got: ${JSON.stringify(stdout)}`).toBeTruthy();
      // The state word is the third whitespace-separated token after trim.
      // Example: "  ● r              ready (admin: ...)"
      //   tokens: ["●", "r", "ready", "(admin:", ...] OR with multiple spaces inside padEnd we split on /\s+/.
      const tokens = repoLine!.trim().split(/\s+/);
      const mjsState = tokens[2];

      expect(mjsState, `[${fix.label}] inlined .mjs state must match TS reference`).toBe(tsState);

      await rm(fixHome, { recursive: true, force: true });
    }
  });
});
