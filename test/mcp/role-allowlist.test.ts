import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { JsonRpcMessage } from "../../src/mcp/server.js";

/**
 * AL-11 enforcement tests at the MCP server boundary.
 *
 * These tests drive the real JSON-RPC message handler with
 * `RELAY_AGENT_ROLE=repo-admin` and assert that:
 *   1. `tools/list` only advertises the allowlisted tool set.
 *   2. `tools/call` on a denied tool returns a STRUCTURED denial envelope
 *      with `isError: true` — not a silent pass, not a generic crash.
 *   3. `tools/call` on the stubbed `spawn_worker` tool returns a structured
 *      "tool-stubbed" envelope that points at AL-14.
 *   4. Clearing `RELAY_AGENT_ROLE` restores the pre-AL-11 tool surface.
 *
 * Storage is pinned to a tmp-backed FileHarnessStore via vi.mock so the
 * handler doesn't reach into real ~/.relay (mirrors the pattern in
 * test/orchestrator/dispatch-error-surface.test.ts).
 */

// Pin storage to a per-test tmp FileHarnessStore — handler calls
// getHarnessStore() during session registration and we must not touch
// real ~/.relay.
const storeRoots: string[] = [];
vi.mock("../../src/storage/factory.js", async () => {
  const { FileHarnessStore } = await import("../../src/storage/file-store.js");
  const root = await mkdtemp(join(tmpdir(), "al11-hs-"));
  storeRoots.push(root);
  const store = new FileHarnessStore(root);
  return {
    getHarnessStore: () => store,
    buildHarnessStore: () => store,
  };
});

interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: unknown;
}

interface ToolsListResult {
  tools: ToolDescriptor[];
}

interface ToolsCallResult {
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
}

async function buildHandler(workspaceRoot: string) {
  const { buildMcpMessageHandler } = await import("../../src/mcp/server.js");
  return buildMcpMessageHandler(workspaceRoot);
}

describe("MCP per-role allowlist (AL-11)", () => {
  let tmpHome: string;
  let workspaceRoot: string;
  const ORIGINAL_HOME = process.env.HOME;
  const ORIGINAL_ROLE = process.env.RELAY_AGENT_ROLE;

  beforeEach(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), "al11-home-"));
    workspaceRoot = await mkdtemp(join(tmpdir(), "al11-ws-"));
    process.env.HOME = tmpHome;
    delete process.env.RELAY_AGENT_ROLE;
    const { __resetRelayDirCacheForTests } = await import("../../src/cli/paths.js");
    __resetRelayDirCacheForTests();
  });

  afterEach(async () => {
    await rm(tmpHome, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
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

  it("without a role, advertises the full tool surface (regression guard)", async () => {
    const { handler, context } = await buildHandler(workspaceRoot);
    try {
      const resp = await handler({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      });
      const tools = (resp?.result as ToolsListResult).tools;
      const names = tools.map((t) => t.name);
      // Sanity: the unrestricted path must still include tools repo-admin would be denied.
      expect(names).toContain("harness_dispatch");
      expect(names).toContain("harness_approve_plan");
      expect(names).toContain("project_create");
      // And tools repo-admin can use.
      expect(names).toContain("channel_task_board");
      expect(names).toContain("spawn_worker");
    } finally {
      context.cleanup();
    }
  });

  it("under RELAY_AGENT_ROLE=repo-admin, tools/list matches the repo-admin allowlist EXACTLY", async () => {
    process.env.RELAY_AGENT_ROLE = "repo-admin";
    const { handler, context } = await buildHandler(workspaceRoot);
    try {
      const resp = await handler({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      });
      const { REPO_ADMIN_ALLOWED_TOOLS } = await import("../../src/agents/repo-admin.js");
      const tools = (resp?.result as ToolsListResult).tools;
      const names = new Set(tools.map((t) => t.name));

      // Every advertised tool is on the allowlist.
      for (const name of names) {
        expect(REPO_ADMIN_ALLOWED_TOOLS.has(name)).toBe(true);
      }
      // Every allowlisted tool is advertised.
      for (const allowed of REPO_ADMIN_ALLOWED_TOOLS) {
        expect(names.has(allowed)).toBe(true);
      }
      // Exact-match check as belt-and-suspenders against drift.
      expect([...names].sort()).toEqual([...REPO_ADMIN_ALLOWED_TOOLS].sort());
    } finally {
      context.cleanup();
    }
  });

  it("under RELAY_AGENT_ROLE=repo-admin, calling a DENIED tool returns a structured envelope (not silent, not crash)", async () => {
    process.env.RELAY_AGENT_ROLE = "repo-admin";
    const { handler, context } = await buildHandler(workspaceRoot);
    try {
      // harness_dispatch is a mutating tool explicitly denied to repo-admin.
      const resp = await handler({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: {
          name: "harness_dispatch",
          arguments: { featureRequest: "should never run" },
        },
      });

      const result = resp?.result as ToolsCallResult;
      // Must be marked as an error — NOT silent success.
      expect(result.isError).toBe(true);
      // Must be structured — parse the envelope the handler embedded in the
      // text block.
      const payload = JSON.parse(result.content[0].text) as {
        error?: string;
        tool?: string;
        role?: string;
        reason?: string;
      };
      expect(payload.error).toBe("tool-not-allowed");
      expect(payload.tool).toBe("harness_dispatch");
      expect(payload.role).toBe("repo-admin");
      expect(payload.reason).toBeTypeOf("string");
      expect((payload.reason ?? "").length).toBeGreaterThan(0);
    } finally {
      context.cleanup();
    }
  });

  it("the `Edit` editor tool is denied for repo-admin with a role-specific reason", async () => {
    process.env.RELAY_AGENT_ROLE = "repo-admin";
    const { handler, context } = await buildHandler(workspaceRoot);
    try {
      const resp = await handler({
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: {
          name: "Edit",
          arguments: {},
        },
      });
      const result = resp?.result as ToolsCallResult;
      expect(result.isError).toBe(true);
      const payload = JSON.parse(result.content[0].text) as {
        error?: string;
        reason?: string;
      };
      expect(payload.error).toBe("tool-not-allowed");
      // Reason must explain the "propose a worker" guidance so the agent
      // can pivot instead of retrying.
      expect(payload.reason?.toLowerCase()).toContain("worker");
    } finally {
      context.cleanup();
    }
  });

  it("calling the stubbed spawn_worker returns a structured `tool-stubbed` envelope pointing at AL-14", async () => {
    process.env.RELAY_AGENT_ROLE = "repo-admin";
    const { handler, context } = await buildHandler(workspaceRoot);
    try {
      const resp = await handler({
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: {
          name: "spawn_worker",
          arguments: { ticketId: "T-123", specialty: "forge" },
        },
      });
      const result = resp?.result as ToolsCallResult;
      expect(result.isError).toBe(true);
      const payload = JSON.parse(result.content[0].text) as {
        error?: string;
        tool?: string;
        landsIn?: string;
      };
      expect(payload.error).toBe("tool-stubbed");
      expect(payload.tool).toBe("spawn_worker");
      expect(payload.landsIn).toBe("AL-14");
    } finally {
      context.cleanup();
    }
  });

  it("allowed tools still function under repo-admin (no false positives)", async () => {
    process.env.RELAY_AGENT_ROLE = "repo-admin";
    const { handler, context } = await buildHandler(workspaceRoot);
    try {
      // harness_list_runs is on the allowlist and reads from the artifact
      // store — no index file yet, expect an empty runs list.
      const resp = await handler({
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: {
          name: "harness_list_runs",
          arguments: {},
        },
      });
      const result = resp?.result as ToolsCallResult;
      expect(result.isError).toBe(false);
      const payload = JSON.parse(result.content[0].text) as {
        workspaceRoot: string;
        runs: unknown[];
      };
      expect(payload.workspaceRoot).toBe(workspaceRoot);
      expect(Array.isArray(payload.runs)).toBe(true);
    } finally {
      context.cleanup();
    }
  });

  it("an unknown role passes through (no silent denial during AL-12..16 rollout)", async () => {
    process.env.RELAY_AGENT_ROLE = "eng-manager"; // future role, not yet enforced
    const { handler, context } = await buildHandler(workspaceRoot);
    try {
      const listResp = await handler({
        jsonrpc: "2.0",
        id: 11,
        method: "tools/list",
        params: {},
      });
      const tools = (listResp?.result as ToolsListResult).tools;
      // Unknown role -> full surface, same as no role.
      expect(tools.map((t) => t.name)).toContain("harness_dispatch");
    } finally {
      context.cleanup();
    }
  });

  it("unused imports on the response are well-typed (spot check)", () => {
    // Pure compile-time guard: `JsonRpcMessage` should be importable from the
    // server barrel. If this import breaks, the real test files fail loudly
    // — this line exists so an IDE's auto-cleanup doesn't strip the type.
    const sample: JsonRpcMessage = { jsonrpc: "2.0", id: 1 };
    expect(sample.jsonrpc).toBe("2.0");
  });
});
