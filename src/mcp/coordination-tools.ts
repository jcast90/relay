/**
 * AL-16 MCP surface: `coordination_send`.
 *
 * Exposes {@link Coordinator.send} to repo-admin sessions as a tool call.
 * The tool is narrow on purpose:
 *
 *   - Only callable by repo-admin (added to the role allowlist so a
 *     worker can't spoof cross-repo coordination).
 *   - Input must validate against one of the AL-16 message schemas or
 *     the tool returns a structured `malformed` error (AC4). The
 *     server never drops a malformed call silently.
 *   - The Coordinator is optional state: when the MCP server is spun
 *     up outside an autonomous run (the common developer path), the
 *     coordination state is absent and the tool returns a clear
 *     "coordinator not configured" error rather than throwing.
 *
 * The tool is modelled on `crosslink/tools.ts` so the shape is
 * familiar — a pair of (definitions, dispatcher) functions plus a
 * lightweight state interface the MCP server threads through.
 */

import type { Coordinator, SendResult } from "../crosslink/coordinator.js";
import { COORDINATION_MESSAGE_KINDS } from "../crosslink/messages.js";

/**
 * MCP tool name. Exported so the role allowlist and tests can pattern-
 * match without re-declaring the string.
 */
export const COORDINATION_SEND_TOOL = "coordination_send";

/**
 * State the MCP server owns and threads into each tool dispatch. A
 * missing `coordinator` is the dev-mode fallback — the tool returns a
 * structured error instead of throwing so a misconfigured session sees
 * an actionable reason, not a 500.
 */
export interface CoordinationToolState {
  /** Admin alias this session represents. Set when the MCP server is
   * running inside a repo-admin context (RELAY_AGENT_ROLE=repo-admin).
   * Absent otherwise. */
  alias: string | null;
  /** Per-run coordinator instance. Wired by the autonomous-loop driver
   * (AL-16 follow-up). When null, the tool surfaces a clear error. */
  coordinator: Coordinator | null;
}

/** True iff the tool name belongs to the AL-16 surface. */
export function isCoordinationTool(name: string): boolean {
  return name === COORDINATION_SEND_TOOL;
}

/**
 * MCP tool definitions for `tools/list`. Kept as a function (not a
 * constant) to match the sibling pattern in `channel-tools.ts` /
 * `crosslink/tools.ts`.
 */
export function getCoordinationToolDefinitions(): object[] {
  return [
    {
      name: COORDINATION_SEND_TOOL,
      description:
        "Send a typed cross-repo coordination message to another repo-admin. " +
        "Use 'blocked-on-repo' when a ticket cannot proceed until another repo's " +
        "ticket completes; 'repo-ready' to announce that a PR you own is open or " +
        "merged and downstream repos may be waiting on it; 'merge-order-proposal' " +
        "to record an ordering rationale across multiple open PRs. DO NOT free-text " +
        "these coordination handoffs in the channel feed — use this tool so the " +
        "scheduler and other admins can parse them programmatically.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["to", "payload"],
        properties: {
          to: {
            type: "string",
            description: "Receiving admin alias (e.g. 'frontend', 'backend').",
          },
          payload: {
            type: "object",
            description:
              "One of the typed AL-16 coordination shapes. The `kind` field is the " +
              "discriminator; see each shape's required fields in the relay docs.",
            properties: {
              kind: {
                type: "string",
                enum: [...COORDINATION_MESSAGE_KINDS],
              },
            },
            required: ["kind"],
          },
        },
      },
    },
  ];
}

/**
 * Dispatch a single `coordination_send` call. Returns a plain JSON-
 * serializable object the MCP server wraps in the usual `content[]`
 * envelope; see `src/mcp/server.ts` for the outer framing.
 */
export async function callCoordinationTool(
  name: string,
  args: Record<string, unknown>,
  state: CoordinationToolState
): Promise<unknown> {
  if (name !== COORDINATION_SEND_TOOL) {
    return {
      ok: false,
      error: "unknown-tool",
      detail: `coordination_send dispatcher received unexpected tool name: ${name}`,
    };
  }

  if (!state.alias) {
    return {
      ok: false,
      error: "session-not-repo-admin",
      detail:
        "coordination_send is only callable from a repo-admin session. Set " +
        "RELAY_AGENT_ROLE=repo-admin and bind the session to a repo alias.",
    };
  }

  if (!state.coordinator) {
    return {
      ok: false,
      error: "coordinator-not-configured",
      detail:
        "No coordinator is wired into this MCP server instance. Coordination " +
        "messaging requires running inside an autonomous-loop session where " +
        "the Coordinator is constructed alongside the RepoAdminPool.",
    };
  }

  const to = typeof args.to === "string" ? args.to : "";
  if (!to) {
    return {
      ok: false,
      error: "malformed",
      detail: "`to` is required and must be a non-empty string.",
    };
  }
  const payload = args.payload;
  if (payload === null || typeof payload !== "object") {
    return {
      ok: false,
      error: "malformed",
      detail: "`payload` is required and must be an object matching one of the AL-16 shapes.",
    };
  }

  const result: SendResult = await state.coordinator.send(
    state.alias,
    to,
    payload as Record<string, unknown>
  );
  return result;
}
