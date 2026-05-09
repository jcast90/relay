/**
 * Phase 3 — agent_ready MCP tool surface.
 *
 * Wave 1 lands stub exports so the test scaffolds in
 * `test/mcp/readiness-tools.test.ts` import successfully and TypeScript
 * compiles. The real bodies land in Wave 2 Task 3, alongside the dispatch
 * wiring in `src/mcp/server.ts` and the role-allowlist update.
 *
 * Contract (lands in Wave 2):
 * - `getReadinessToolDefinitions()` returns the `agent_ready` tool spec
 *   for advertisement via `tools/list`.
 * - `callReadinessTool(args, state)` flips the readiness flag on the
 *   crosslink-session record (idempotent, monotonic-once-set) AND posts
 *   a `status_update` channel-feed entry with `metadata.kind: "agent_ready"`
 *   when `state.channelId` is non-null. Without `channelId`, the disk
 *   write still happens (degraded mode); the audit feed entry is skipped.
 *
 * See `.planning/phases/03-repo-admin-readiness-handshake/03-PLAN.md`
 * Task 3 for the full spec; `03-RESEARCH.md` Pattern 1 for the body.
 */

import type { ChannelStore } from "../channels/channel-store.js";
import type { CrosslinkStore } from "../crosslink/store.js";

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
  throw new Error("getReadinessToolDefinitions — Wave 2 Task 3 lands the body");
}

export async function callReadinessTool(
  _args: Record<string, unknown>,
  _state: ReadinessToolState
): Promise<unknown> {
  throw new Error("callReadinessTool — Wave 2 Task 3 lands the body");
}
