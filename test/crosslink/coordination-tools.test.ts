/**
 * AL-16 MCP tool (`coordination_send`) contract tests.
 *
 * Focuses on the thin dispatcher surface: it delegates to the
 * Coordinator, but the tool owns the "session is not repo-admin" /
 * "coordinator not wired" / "malformed args" envelopes. AC4 requires a
 * malformed payload to surface a structured error, never silently drop.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ChannelStore } from "../../src/channels/channel-store.js";
import { Coordinator } from "../../src/crosslink/coordinator.js";
import {
  COORDINATION_SEND_TOOL,
  callCoordinationTool,
  getCoordinationToolDefinitions,
  isCoordinationTool,
  type CoordinationToolState,
} from "../../src/mcp/coordination-tools.js";

function makeFakePool(aliases: string[]) {
  const sessions = new Map<string, { alias: string }>();
  for (const alias of aliases) sessions.set(alias, { alias });
  return {
    getSession(alias: string) {
      return (
        (sessions.get(alias) as unknown as ReturnType<
          InstanceType<
            typeof import("../../src/orchestrator/repo-admin-pool.js").RepoAdminPool
          >["getSession"]
        >) ?? null
      );
    },
    listSessions() {
      return Array.from(sessions.values()) as unknown as ReturnType<
        InstanceType<
          typeof import("../../src/orchestrator/repo-admin-pool.js").RepoAdminPool
        >["listSessions"]
      >;
    },
  };
}

async function withToolState(
  aliases: string[],
  body: (state: CoordinationToolState, ctx: { dir: string; channelId: string }) => Promise<void>
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "al-16-tool-"));
  const channelStore = new ChannelStore(dir);
  try {
    const channel = await channelStore.createChannel({
      name: "#al-16-tool",
      description: "al-16 tool tests",
    });
    const coordinator = new Coordinator({
      pool: makeFakePool(aliases),
      channelStore,
      channelId: channel.channelId,
    });
    try {
      await body({ alias: aliases[0] ?? null, coordinator }, { dir, channelId: channel.channelId });
    } finally {
      await coordinator.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("coordination_send MCP tool", () => {
  it("identifies itself via isCoordinationTool", () => {
    expect(isCoordinationTool(COORDINATION_SEND_TOOL)).toBe(true);
    expect(isCoordinationTool("coordination_send")).toBe(true);
    expect(isCoordinationTool("crosslink_send")).toBe(false);
    expect(isCoordinationTool("harness_status")).toBe(false);
  });

  it("exposes a tool definition with the expected name + schema basics", () => {
    const defs = getCoordinationToolDefinitions() as Array<{
      name: string;
      description: string;
      inputSchema: { required: string[]; properties: { to: unknown; payload: unknown } };
    }>;
    expect(defs).toHaveLength(1);
    expect(defs[0].name).toBe("coordination_send");
    expect(defs[0].inputSchema.required).toEqual(["to", "payload"]);
  });

  it("returns session-not-repo-admin when alias is null", async () => {
    const state: CoordinationToolState = { alias: null, coordinator: null };
    const result = (await callCoordinationTool(
      "coordination_send",
      { to: "frontend", payload: { kind: "repo-ready" } },
      state
    )) as { ok: false; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toBe("session-not-repo-admin");
  });

  it("returns coordinator-not-configured when the coordinator is absent", async () => {
    const state: CoordinationToolState = { alias: "backend", coordinator: null };
    const result = (await callCoordinationTool(
      "coordination_send",
      { to: "frontend", payload: { kind: "repo-ready" } },
      state
    )) as { ok: false; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toBe("coordinator-not-configured");
  });

  it("returns malformed when the payload fails validation (AC4)", async () => {
    await withToolState(["backend", "frontend"], async (state) => {
      const result = (await callCoordinationTool(
        "coordination_send",
        {
          to: "frontend",
          payload: {
            kind: "blocked-on-repo",
            // missing every field beyond `kind`
          },
        },
        state
      )) as { ok: false; reason: string };
      expect(result.ok).toBe(false);
      // The tool delegates to Coordinator.send; the `reason` from the
      // SendErr envelope is what the repo-admin system prompt pattern-
      // matches on. AC4: structured, never a silent drop.
      expect(result.reason).toBe("malformed");
    });
  });

  it("returns malformed when `to` is missing", async () => {
    await withToolState(["backend", "frontend"], async (state) => {
      const result = (await callCoordinationTool(
        "coordination_send",
        { payload: { kind: "repo-ready" } },
        state
      )) as { ok: false; error: string };
      expect(result.ok).toBe(false);
      expect(result.error).toBe("malformed");
    });
  });

  it("returns malformed when `payload` is not an object", async () => {
    await withToolState(["backend", "frontend"], async (state) => {
      const result = (await callCoordinationTool(
        "coordination_send",
        { to: "frontend", payload: "blocked-on-repo" },
        state
      )) as { ok: false; error: string };
      expect(result.ok).toBe(false);
      expect(result.error).toBe("malformed");
    });
  });

  it("routes a valid payload successfully and returns an SendOk envelope", async () => {
    await withToolState(["backend", "frontend"], async (state) => {
      // Our helper sets alias = aliases[0] = "backend", so send
      // FROM backend TO frontend.
      const result = (await callCoordinationTool(
        "coordination_send",
        {
          to: "frontend",
          payload: {
            kind: "blocked-on-repo",
            requester: "backend",
            blocker: "frontend",
            ticketId: "AL-X",
            dependsOnTicketId: "AL-Y",
            reason: "consumer update first",
            requestedAt: "2026-04-21T12:00:00.000Z",
          },
        },
        state
      )) as { ok: true; kind: string; from: string; to: string };
      expect(result.ok).toBe(true);
      expect(result.kind).toBe("blocked-on-repo");
      expect(result.from).toBe("backend");
      expect(result.to).toBe("frontend");
    });
  });

  it("returns an unknown-tool envelope for wrong tool names", async () => {
    await withToolState(["backend"], async (state) => {
      const result = (await callCoordinationTool("coordination_discover", {}, state)) as {
        ok: false;
        error: string;
      };
      expect(result.ok).toBe(false);
      expect(result.error).toBe("unknown-tool");
    });
  });
});
