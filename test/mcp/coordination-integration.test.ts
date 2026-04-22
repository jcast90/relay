/**
 * AL-16 full-MCP-path integration test for `coordination_send`.
 *
 * Unit tests in `test/crosslink/coordination-tools.test.ts` exercise the
 * dispatcher in isolation — they build a `CoordinationToolState` by
 * hand and call `callCoordinationTool` directly. That path validates
 * the dispatcher's contract, but it skips the thing a real repo-admin
 * session exercises: the JSON-RPC message handler returned by
 * `buildMcpMessageHandler`, including the `tools/call` routing, the
 * per-role allowlist check, and the envelope shape the Claude CLI
 * sees on the wire.
 *
 * This test drives that full path:
 *   1. Construct a Coordinator wired to a fake pool ({A, B}).
 *   2. Build TWO MCP handlers — one representing admin A's session
 *      (alias="backend") and one representing admin B's (alias=
 *      "frontend"), both pointing at the same Coordinator.
 *   3. Subscribe directly to the coordinator's `onMessage("frontend")`
 *      stream to observe the fan-out (the real B session would have
 *      its own listener wired up the same way).
 *   4. Issue a `tools/call coordination_send` JSON-RPC request against
 *      handler A.
 *   5. Assert: the response envelope is `{ok: true, ...}`, the
 *      coordinator fanned the message out to B's subscriber, and the
 *      decisions board has a `coordination_message` audit entry.
 *
 * This is the regression guard for B2 (PR #110 review): before the
 * fix, every MCP server constructed its `coordinationState` with
 * `coordinator: null` and `alias: null`, so `coordination_send`
 * always returned `coordinator-not-configured`. The tool was
 * unreachable end-to-end. Adding an assertion on the
 * `{ok: true, kind: "repo-ready", ...}` envelope locks in the wiring.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CoordinationMessage } from "../../src/crosslink/messages.js";
import type { RepoAdminPool } from "../../src/orchestrator/repo-admin-pool.js";

// Pin storage to a per-test tmp FileHarnessStore — the MCP handler
// auto-registers a crosslink session during construction and must not
// touch real ~/.relay. Mirrors the pattern in role-allowlist.test.ts.
// NB: top-level value imports from `src/` are deferred to after this
// mock registration because `vi.mock` is hoisted and any module that
// transitively imports `storage/factory.js` must see the mocked
// version (the real `ChannelStore`, `Coordinator`, etc. all do).
const storeRoots: string[] = [];
vi.mock("../../src/storage/factory.js", async () => {
  const { FileHarnessStore } = await import("../../src/storage/file-store.js");
  const root = await mkdtemp(join(tmpdir(), "al16-mcp-integ-hs-"));
  storeRoots.push(root);
  const store = new FileHarnessStore(root);
  return {
    getHarnessStore: () => store,
    buildHarnessStore: () => store,
  };
});

interface ToolsCallResult {
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
}

/**
 * Tiny pool-shaped stand-in. The Coordinator only calls `getSession` /
 * `listSessions` on its pool reference, so a Map<alias, {}> is enough.
 * We cast through `unknown` to satisfy the coordinator's
 * `Pick<RepoAdminPool, ...>` type without depending on the real pool
 * machinery (which requires a lifecycle + spawner).
 */
function makeFakePool(aliases: string[]): Pick<RepoAdminPool, "getSession" | "listSessions"> {
  const sessions = new Map<string, { alias: string }>();
  for (const alias of aliases) sessions.set(alias, { alias });
  return {
    getSession(alias: string) {
      return (sessions.get(alias) as unknown as ReturnType<RepoAdminPool["getSession"]>) ?? null;
    },
    listSessions() {
      return Array.from(sessions.values()) as unknown as ReturnType<RepoAdminPool["listSessions"]>;
    },
  };
}

describe("MCP `coordination_send` full-path integration (AL-16 B2 guard)", () => {
  let tmpHome: string;
  let workspaceA: string;
  let workspaceB: string;
  const ORIGINAL_HOME = process.env.HOME;
  const ORIGINAL_ROLE = process.env.RELAY_AGENT_ROLE;

  beforeEach(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), "al16-home-"));
    workspaceA = await mkdtemp(join(tmpdir(), "al16-ws-a-"));
    workspaceB = await mkdtemp(join(tmpdir(), "al16-ws-b-"));
    process.env.HOME = tmpHome;
    // Repo-admin role so the tool surface + allowlist exercise the
    // same code path a real session would.
    process.env.RELAY_AGENT_ROLE = "repo-admin";
    const { __resetRelayDirCacheForTests } = await import("../../src/cli/paths.js");
    __resetRelayDirCacheForTests();
  });

  afterEach(async () => {
    await rm(tmpHome, { recursive: true, force: true });
    await rm(workspaceA, { recursive: true, force: true });
    await rm(workspaceB, { recursive: true, force: true });
    if (ORIGINAL_HOME === undefined) delete process.env.HOME;
    else process.env.HOME = ORIGINAL_HOME;
    if (ORIGINAL_ROLE === undefined) delete process.env.RELAY_AGENT_ROLE;
    else process.env.RELAY_AGENT_ROLE = ORIGINAL_ROLE;
    const { __resetRelayDirCacheForTests } = await import("../../src/cli/paths.js");
    __resetRelayDirCacheForTests();
    while (storeRoots.length > 0) {
      const r = storeRoots.pop();
      if (r) await rm(r, { recursive: true, force: true });
    }
  });

  it("routes a valid send through the JSON-RPC handler to the target admin's listener", async () => {
    const coordDir = await mkdtemp(join(tmpdir(), "al16-coord-"));
    try {
      const { ChannelStore } = await import("../../src/channels/channel-store.js");
      const { Coordinator } = await import("../../src/crosslink/coordinator.js");
      const channelStore = new ChannelStore(coordDir);
      const channel = await channelStore.createChannel({
        name: "#al-16-integ",
        description: "al-16 full MCP path",
      });
      const coordinator = new Coordinator({
        pool: makeFakePool(["backend", "frontend"]),
        channelStore,
        channelId: channel.channelId,
      });

      try {
        const { buildMcpMessageHandler } = await import("../../src/mcp/server.js");
        // Admin A's handler — alias "backend". Injecting the shared
        // coordinator + its own alias is what B2 fixes: before the
        // wiring, this state was { alias: null, coordinator: null }.
        const handlerA = await buildMcpMessageHandler(workspaceA, {
          coordinator,
          alias: "backend",
        });

        // Subscribe to the frontend mailbox the same way admin B's
        // session wiring will — the coordinator fans out to every
        // listener for that alias, so a simple in-process listener
        // proves the routing path. A real B session would wire this
        // up inside its own repo-admin-session / MCP handler.
        const seen: CoordinationMessage[] = [];
        const unsubscribe = coordinator.onMessage("frontend", (msg) => {
          seen.push(msg);
        });

        try {
          // Drive `tools/call coordination_send` through the JSON-RPC
          // surface — same entrypoint the Claude CLI's MCP client uses.
          const response = await handlerA.handler({
            jsonrpc: "2.0",
            id: 42,
            method: "tools/call",
            params: {
              name: "coordination_send",
              arguments: {
                to: "frontend",
                payload: {
                  kind: "repo-ready",
                  alias: "backend",
                  ticketId: "AL-42",
                  prUrl: "https://github.com/o/r/pull/42",
                  announcedAt: "2026-04-21T12:00:00.000Z",
                },
              },
            },
          });

          const result = response?.result as ToolsCallResult;
          expect(result.isError).toBe(false);
          const envelope = JSON.parse(result.content[0].text) as {
            ok: boolean;
            kind?: string;
            from?: string;
            to?: string;
            error?: string;
            reason?: string;
          };
          // BEFORE THE FIX this was
          // `{ ok: false, error: "coordinator-not-configured" }`.
          expect(envelope.ok).toBe(true);
          expect(envelope.kind).toBe("repo-ready");
          expect(envelope.from).toBe("backend");
          expect(envelope.to).toBe("frontend");

          // Fan-out: the target admin's listener fired. Not just a
          // dispatcher return — a real cross-admin delivery.
          expect(seen).toHaveLength(1);
          expect(seen[0].kind).toBe("repo-ready");
          if (seen[0].kind === "repo-ready") {
            expect(seen[0].ticketId).toBe("AL-42");
          }

          // Audit: the routed message is mirrored to the decisions
          // board so a post-mortem can reconstruct the handoff.
          const decisions = await channelStore.listDecisions(channel.channelId);
          const coord = decisions.filter((d) => d.type === "coordination_message");
          expect(coord).toHaveLength(1);
          expect(coord[0].metadata?.from).toBe("backend");
          expect(coord[0].metadata?.to).toBe("frontend");
        } finally {
          unsubscribe();
          handlerA.context.cleanup();
        }
      } finally {
        await coordinator.close();
      }
    } finally {
      await rm(coordDir, { recursive: true, force: true });
    }
  });

  it("returns `coordinator-not-configured` when options omit the coordinator (regression guard)", async () => {
    // Without options, the handler's coordination state stays null —
    // matching the subprocess MCP path that has no in-process
    // coordinator reference. The tool must surface a structured error
    // envelope, not a silent success.
    const { buildMcpMessageHandler } = await import("../../src/mcp/server.js");
    const built = await buildMcpMessageHandler(workspaceA);
    try {
      const response = await built.handler({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "coordination_send",
          arguments: {
            to: "frontend",
            payload: { kind: "repo-ready" },
          },
        },
      });

      const result = response?.result as ToolsCallResult;
      // Dispatcher returns `{ok:false}`; the MCP server wraps the
      // result with `isError: false` (tool-call succeeded, just the
      // business logic rejected) — we only care about the payload.
      const envelope = JSON.parse(result.content[0].text) as {
        ok: boolean;
        error?: string;
      };
      expect(envelope.ok).toBe(false);
      // Either "session-not-repo-admin" (alias=null in options)
      // or "coordinator-not-configured" (alias passed but no
      // coordinator) is acceptable — both are structured errors, and
      // which one fires first is a dispatcher-ordering detail. The
      // key assertion is "structured error, not silent success".
      expect(["session-not-repo-admin", "coordinator-not-configured"]).toContain(envelope.error);
    } finally {
      built.context.cleanup();
    }
  });
});
