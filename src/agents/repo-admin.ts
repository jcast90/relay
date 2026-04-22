/**
 * Repo-admin role definition (AL-11).
 *
 * Repo-admin is the per-repo long-lived foreman in the autonomous-loop
 * design. It tracks what's happening in its repo, coordinates worktrees,
 * and sequences PR merges — but it does NOT implement code, run tests, or
 * merge PRs itself. Those are the worker tier's job (AL-14 spawns workers
 * on demand into ephemeral worktrees).
 *
 * AL-11 defines the *role* only:
 *   - the specialty tag (`repo_admin`, added to `AgentSpecialtySchema`)
 *   - the system prompt
 *   - the MCP tool allowlist and its denial enforcement shape
 *
 * Explicitly out of scope for AL-11 (each lives in a later ticket):
 *   - lifecycle (spawning a long-lived session)         -> AL-12
 *   - routing (deciding which repo-admin gets a ticket) -> AL-13
 *   - worker spawning (the `spawn_worker` MCP tool body)-> AL-14
 *   - memory-shed (bounded working set across sessions) -> AL-15
 *   - inter-admin coordination                          -> AL-16
 *
 * Source of truth for repo-admin state is the channel board + decisions +
 * git log. Repo-admin is a caching / coordination layer on top of those,
 * not an authoritative memory. The system prompt makes that explicit.
 */

import type { AgentSpecialty } from "../domain/specialty.js";
import {
  REPO_ADMIN_ALLOWED_TOOLS,
  REPO_ADMIN_TOOL_STUBS,
  denyToolEnvelope,
  isToolAllowedForRole,
  type ToolDenialEnvelope,
} from "../mcp/role-allowlist.js";

/** Specialty tag for repo-admin work. Matches the `repo_admin` enum member. */
export const REPO_ADMIN_SPECIALTY: AgentSpecialty = "repo_admin";

/** Role name used by the MCP layer when enforcing the allowlist. */
export const REPO_ADMIN_ROLE = "repo-admin";

/**
 * Canonical substring the system prompt MUST contain. Tests assert on this
 * so a future edit that silently drops the memory-policy guidance trips CI
 * rather than the live loop. Keep the phrasing short so the assertion stays
 * robust to minor copy changes elsewhere in the prompt.
 */
export const REPO_ADMIN_MEMORY_POLICY_MARKER =
  "source of truth is the board and the decisions file";

export interface RepoAdminRoleInput {
  /** Absolute path to the repo the admin is foremanning. */
  repoPath: string;
  /**
   * Optional channel id this admin is bound to. When known, the system
   * prompt name-drops it so the agent re-reads the right board without
   * guessing. Lifecycle wiring (AL-12) supplies this; AL-11 just accepts it.
   */
  channelId?: string;
}

/**
 * Build the repo-admin system prompt for a concrete repo.
 *
 * The prompt emphasizes four things:
 *   1. Role framing — "coordination, not implementation".
 *   2. Memory policy — "caches only the working set; re-read the board on
 *      demand". Board + decisions are authoritative; chat history is not.
 *   3. Tool policy — absent tools are intentional; propose a worker instead.
 *   4. Worker-spawn guidance — pick specialty from ticket scope, justify.
 *
 * Kept verbose but scannable — repo-admin re-reads the prompt implicitly on
 * every turn, and ambiguity at the top of the loop compounds quickly.
 */
export function buildRepoAdminSystemPrompt(input: RepoAdminRoleInput): string {
  const channelLine = input.channelId
    ? `You are bound to channel \`${input.channelId}\`. Re-read THIS channel's board.`
    : "When you need the board, first discover your bound channel via `channel_get`.";

  return [
    `You are the repo-admin for \`${input.repoPath}\`.`,
    "Your job is coordination, not implementation.",
    "",
    "## Role",
    "You are a long-lived foreman. Workers are ephemeral per-ticket agents",
    "spawned into isolated worktrees; they do the code changes, run the",
    "tests, and open the PRs. You do not edit files, you do not run tests,",
    "and you do not merge PRs. You observe state, decide what work to",
    "dispatch, and sequence PR merges when multiple workers converge.",
    "",
    "## Memory policy",
    `Memory: you cache only the active working set — in-flight tickets, ` +
      `open PRs, current worktrees. When you need fuller history, re-read ` +
      `the board (\`channel_task_board\` / \`channel_get\`) or decisions ` +
      `(\`channel_get\` returns recent decisions). Don't rely on chat ` +
      `history or summaries — the ${REPO_ADMIN_MEMORY_POLICY_MARKER}, ` +
      `backed by the git log. ${channelLine}`,
    "",
    "## Tool policy",
    "Your MCP tool allowlist is narrow on purpose. If a tool you think you",
    "need isn't in your allowlist, it's intentional — propose the work to",
    "the channel scheduler instead (the scheduler can spawn a worker for",
    "it). Allowed tools:",
    ...[...REPO_ADMIN_ALLOWED_TOOLS].sort().map((name) => `  - \`${name}\``),
    "",
    "Denied by design: file edits, test runners, `gh pr merge`, and any",
    "MCP tool that mutates state beyond `spawn_worker`. The MCP server",
    "returns a structured `tool-not-allowed` error with a reason if you",
    "try — that's a signal to propose a worker, not to retry.",
    "",
    "## Worker-spawn guidance",
    "When proposing a worker spawn (via the AL-14 `spawn_worker` tool once",
    "it lands), pick the specialty from the ticket's scope:",
    "  - `atlas` (planner) for architecture / design work",
    "  - `pixel` (UI engineer) for frontend work",
    "  - `forge` (backend engineer) for backend / API / business logic",
    "  - `lens` (reviewer) for focused review passes",
    "  - `probe` (tester) for test-only work",
    "  - an eng-manager worker for multi-component coordination under a",
    "    single ticket.",
    "Justify the choice in one sentence so the decision is auditable on",
    "the channel feed.",
    "",
    "## Recording decisions",
    "When you commit to a course of action (spawn a worker, sequence a",
    "merge, defer a ticket), post the decision to the channel feed via",
    "`channel_post` — a single append-only entry with the rationale. That",
    "entry is what future repo-admin sessions re-read via `channel_get` to",
    "reconstruct state; if it isn't on the feed, it didn't happen.",
  ].join("\n");
}

/**
 * Convenience re-exports so callers only need `agents/repo-admin.js`.
 * Enforcement primitives live in `mcp/role-allowlist.ts` because the MCP
 * server layer owns tool-call interception.
 */
export { REPO_ADMIN_ALLOWED_TOOLS, REPO_ADMIN_TOOL_STUBS, denyToolEnvelope, isToolAllowedForRole };
export type { ToolDenialEnvelope };

/**
 * Handler for the stubbed `spawn_worker` tool (AL-14 replaces this).
 * Throwing rather than silently succeeding means repo-admin immediately
 * sees that the capability is pending, and test assertions can pin the
 * exact AL-14 handoff point.
 */
export function spawnWorkerStub(_args: Record<string, unknown>): never {
  throw new Error(REPO_ADMIN_TOOL_STUBS.spawn_worker);
}
