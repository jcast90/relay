/**
 * Phase 3 — `agent_ready` MCP tool.
 *
 * The repo-admin agent calls this exactly once at the end of its
 * onboarding turn to announce that it has finished orienting itself
 * (read the channel board, indexed the repo) and is ready to receive
 * tasks. Heartbeat already tells observers the process is alive — this
 * tool is the agent-asserted "I am ready" signal that disambiguates.
 *
 * Behaviour:
 *  - First call sets `readyAt` on the crosslink session record AND
 *    posts a `status_update` channel-feed entry with
 *    `metadata.kind: "agent_ready"` (when `state.channelId` is set).
 *  - Subsequent calls are no-ops: same `readyAt` returned, no second
 *    feed entry posted, no second disk write.
 *  - When `state.channelId` is null (ad-hoc `rly claude` sessions
 *    without a bound channel), the disk flag is still flipped — the
 *    feed entry is the audit trail, not the source of truth.
 *  - When `state.crosslinkSessionId` is null (the MCP server hasn't
 *    auto-registered a session yet), returns `{ ok: false,
 *    reason: "session-not-registered" }`.
 *
 * Dispatch is wired in `src/mcp/server.ts`; the tool name is added to
 * `REPO_ADMIN_ALLOWED_TOOLS` in `src/mcp/role-allowlist.ts`. Workers
 * (Phase 5 / AL-14) will reuse this primitive with `kind: "worker"`;
 * today only `"admin"` is accepted by the input schema.
 */

import type { ChannelStore } from "../channels/channel-store.js";
import type { CrosslinkStore } from "../crosslink/store.js";
import type { ReadyKind } from "../crosslink/types.js";

export interface ReadinessToolState {
  crosslinkSessionId: string | null;
  channelId: string | null;
  alias: string | null;
  crosslinkStore: CrosslinkStore;
  channelStore: ChannelStore;
}

export function isReadinessTool(name: string): boolean {
  return name === "agent_ready";
}

export function getReadinessToolDefinitions(): object[] {
  return [
    {
      name: "agent_ready",
      description:
        "Assert that this agent has finished onboarding and is ready to receive tasks. " +
        "Call this exactly once per session, at the end of your onboarding turn (after " +
        "you have read the channel board and oriented yourself). Subsequent calls are " +
        "no-ops. Observers (TUI, GUI, other agents) will then see `readyAt` populated " +
        "on your crosslink record, distinguishing 'process is alive' from 'agent is " +
        "ready to be addressed.'",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          // `worker` is reserved for Phase 5 / AL-14; today only admin asserts.
          kind: { type: "string", enum: ["admin"] },
          summary: {
            type: "string",
            maxLength: 280,
            description: "Optional one-line summary surfaced on the channel-feed audit entry.",
          },
        },
      },
    },
  ];
}

export async function callReadinessTool(
  args: Record<string, unknown>,
  state: ReadinessToolState
): Promise<unknown> {
  if (!state.crosslinkSessionId) {
    return { ok: false, reason: "session-not-registered" };
  }

  const kind: ReadyKind = (args.kind as ReadyKind | undefined) ?? "admin";
  const summary = typeof args.summary === "string" ? args.summary : null;

  const updated = await state.crosslinkStore.updateReadiness(state.crosslinkSessionId, kind);
  if (!updated) {
    return { ok: false, reason: "session-not-found" };
  }

  if (updated.alreadyReady) {
    return {
      ok: true,
      readyAt: updated.readyAt,
      idempotent: true,
    };
  }

  if (state.channelId) {
    await state.channelStore.postEntry(state.channelId, {
      type: "status_update",
      fromAgentId: state.crosslinkSessionId,
      fromDisplayName: state.alias ?? "repo-admin",
      content: summary ?? `${state.alias ?? "agent"} is ready.`,
      metadata: {
        kind: "agent_ready",
        readyKind: kind,
        sessionId: state.crosslinkSessionId,
        alias: state.alias,
        readyAt: updated.readyAt,
      },
    });
  }

  return { ok: true, readyAt: updated.readyAt, idempotent: false };
}
