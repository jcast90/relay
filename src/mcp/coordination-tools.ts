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

import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { Coordinator, SendResult } from "../crosslink/coordinator.js";
import { COORDINATION_MESSAGE_KINDS } from "../crosslink/messages.js";
import {
  writeOutboxRecord,
  readInboxCursor,
  writeInboxCursor,
  parseIpcRecord,
  type IpcRecord,
} from "../crosslink/ipc-bridge.js";
import { getInboxPath } from "../crosslink/ipc-paths.js";

/**
 * MCP tool name. Exported so the role allowlist and tests can pattern-
 * match without re-declaring the string.
 */
export const COORDINATION_SEND_TOOL = "coordination_send";

/**
 * MCP tool name for the child-side inbox drain. Repo-admin sessions
 * running as a spawned MCP child reach the Coordinator via files, not
 * in-memory; they call this tool at the start of each work cycle to
 * pull pending messages addressed to their alias.
 */
export const COORDINATION_RECEIVE_TOOL = "coordination_receive";

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
  /** Per-run coordinator instance. Populated when the MCP server runs
   * in-process (tests, some dev flows). Child-process MCP servers leave
   * this null and the tool falls through to the file-based IPC bridge
   * (`writeOutboxRecord` + the parent's {@link IpcBridge} tail). */
  coordinator: Coordinator | null;
  /** Session id that scopes the IPC files under
   * `~/.relay/sessions/<sessionId>/coordination/`. Read from
   * `RELAY_SESSION_ID` in the real spawner path. Required for the IPC
   * fallback; tools return a clear error when absent. */
  sessionId: string | null;
  /** Root dir override for IPC paths. Defaults to `~/.relay` via
   * {@link getCoordinationDir}. Tests inject a tmpdir. */
  rootDir?: string;
  /** Injected clock for deterministic tests. Defaults to `Date.now`. */
  clock?: () => number;
  /** Injected id factory for deterministic tests. Defaults to a
   * crypto-free counter since the id's only job is to round-trip the
   * message through the bridge for logging. */
  idFactory?: () => string;
}

/** True iff the tool name belongs to the AL-16 surface. */
export function isCoordinationTool(name: string): boolean {
  return name === COORDINATION_SEND_TOOL || name === COORDINATION_RECEIVE_TOOL;
}

let ipcRecordCounter = 0;
function defaultIpcId(): string {
  ipcRecordCounter += 1;
  return `ipc-${process.pid}-${Date.now().toString(36)}-${ipcRecordCounter.toString(36)}`;
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
        "scheduler and other admins can parse them programmatically. Works whether " +
        "the MCP server is in-process (tests) or spawned as a child process " +
        "(production) — the tool auto-falls-back to a file-based IPC bridge in the " +
        "latter case.",
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
    {
      name: COORDINATION_RECEIVE_TOOL,
      description:
        "Pull unread cross-repo coordination messages addressed to this repo-admin. " +
        "Call at the start of each work cycle. Returns an array of messages that " +
        "arrived since the last call. Cursor is persisted so messages are delivered " +
        "exactly once per session.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 100,
            description: "Maximum number of messages to return in a single call. Default 25.",
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
  if (name === COORDINATION_SEND_TOOL) {
    return await handleSend(args, state);
  }
  if (name === COORDINATION_RECEIVE_TOOL) {
    return await handleReceive(args, state);
  }
  return {
    ok: false,
    error: "unknown-tool",
    detail: `coordination dispatcher received unexpected tool name: ${name}`,
  };
}

async function handleSend(
  args: Record<string, unknown>,
  state: CoordinationToolState
): Promise<unknown> {
  if (!state.alias) {
    return {
      ok: false,
      error: "session-not-repo-admin",
      detail:
        "coordination_send is only callable from a repo-admin session. Set " +
        "RELAY_AGENT_ROLE=repo-admin and bind the session to a repo alias.",
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

  // In-process path: the parent wired a live Coordinator into state.
  // Fastest, simplest, used by tests + any future in-process admin.
  if (state.coordinator) {
    const result: SendResult = await state.coordinator.send(
      state.alias,
      to,
      payload as Record<string, unknown>
    );
    return result;
  }

  // Cross-process path: the MCP server is running as a child of Claude
  // CLI and doesn't share a heap with the parent's Coordinator. Append
  // to the outbox file; the parent's IpcBridge will tail + route it.
  if (!state.sessionId) {
    return {
      ok: false,
      error: "coordinator-not-configured",
      detail:
        "No coordinator is wired into this MCP server instance AND RELAY_SESSION_ID " +
        "is unset, so the file-based IPC fallback can't locate its outbox. This " +
        "normally indicates the session was not spawned by the autonomous-loop " +
        "driver.",
    };
  }

  const clock = state.clock ?? Date.now;
  const id = (state.idFactory ?? defaultIpcId)();
  const record: IpcRecord = {
    id,
    from: state.alias,
    to,
    payload: payload as Record<string, unknown>,
    writtenAt: new Date(clock()).toISOString(),
  };
  try {
    await writeOutboxRecord(state.sessionId, state.alias, record, state.rootDir);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: "ipc-write-failed",
      detail: `outbox append failed: ${detail}`,
    };
  }
  return {
    ok: true,
    routedVia: "ipc-file",
    messageId: id,
    kind: (payload as { kind?: unknown }).kind,
    from: state.alias,
    to,
    detail:
      "Message queued for the parent process's IpcBridge. It will appear in the " +
      "target admin's inbox after the parent routes it through the live Coordinator.",
  };
}

async function handleReceive(
  args: Record<string, unknown>,
  state: CoordinationToolState
): Promise<unknown> {
  if (!state.alias) {
    return {
      ok: false,
      error: "session-not-repo-admin",
      detail: "coordination_receive is only callable from a repo-admin session.",
    };
  }
  if (!state.sessionId) {
    return {
      ok: false,
      error: "coordinator-not-configured",
      detail:
        "RELAY_SESSION_ID is unset; the inbox path cannot be resolved. This " +
        "normally indicates the session was not spawned by the autonomous-loop " +
        "driver.",
    };
  }
  const limitArg = args.limit;
  const limit =
    typeof limitArg === "number" && Number.isFinite(limitArg) && limitArg >= 1
      ? Math.min(100, Math.floor(limitArg))
      : 25;

  const inboxPath = getInboxPath(state.sessionId, state.alias, state.rootDir);
  let raw: string;
  try {
    raw = await readFile(inboxPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: true, messages: [], cursor: 0 };
    }
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, error: "ipc-read-failed", detail };
  }

  const cursor = await readInboxCursor(state.sessionId, state.alias, state.rootDir);
  if (raw.length <= cursor.offset) {
    return { ok: true, messages: [], cursor: cursor.offset };
  }
  const chunk = raw.slice(cursor.offset);
  // Only whole lines — a torn trailing line stays in the buffer until
  // the parent's next append closes it with a newline.
  const lines = chunk.split("\n");
  const complete = raw.endsWith("\n") ? lines.filter((l) => l.length > 0) : lines.slice(0, -1);

  const messages: IpcRecord[] = [];
  for (const line of complete) {
    if (messages.length >= limit) break;
    const rec = parseIpcRecord(line);
    if (rec) messages.push(rec);
  }

  // Advance cursor only past the lines we actually returned so the next
  // call picks up where we left off if we hit the limit.
  let advanced = 0;
  for (let i = 0; i < messages.length; i += 1) {
    advanced += complete[i].length + 1; // +1 for newline
  }
  const nextOffset = cursor.offset + advanced;
  try {
    await writeInboxCursor(state.sessionId, state.alias, { offset: nextOffset }, state.rootDir);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, error: "ipc-cursor-write-failed", detail };
  }
  void mkdir(dirname(inboxPath), { recursive: true }); // idempotent ensure
  return { ok: true, messages, cursor: nextOffset };
}
