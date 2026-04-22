/**
 * Per-role MCP tool allowlists (AL-11).
 *
 * The autonomous-loop design splits responsibility into two tiers:
 *
 *   1. `repo-admin` — long-lived per-repo foreman. Coordinates worktrees,
 *      ticket routing, and PR merge sequencing. Does NOT edit files, run
 *      tests, or merge PRs.
 *   2. worker — ephemeral per-ticket agent, spawned by repo-admin into a
 *      worktree. Full tool access (the default, implicit role).
 *
 * Repo-admin is the only role AL-11 pins down. Every other role is
 * `unrestricted` until a later ticket (AL-12..AL-16) introduces its
 * allowlist. Unknown roles fall through to the unrestricted path so nothing
 * regresses during the rollout.
 *
 * Enforcement is data-driven: one map from role -> Set<allowed tool name>.
 * {@link isToolAllowedForRole} is the single consult point, and
 * {@link denyToolEnvelope} produces the structured error the MCP server
 * returns when a tool is blocked. No silent failure — the agent sees the
 * reason and can adjust.
 *
 * Lifecycle (AL-12), spawn-worker wiring (AL-14), and inter-admin
 * coordination (AL-16) are explicitly OUT of scope here.
 */

export type AgentRoleName = "repo-admin" | string;

/**
 * Role name this process is operating under. Read from `RELAY_AGENT_ROLE`;
 * `null` when unset, which opts the session into the unrestricted path.
 *
 * Uses the `RELAY_*` prefix so it flows through the child-env sanitizer in
 * `src/agents/command-invoker.ts` without needing a `passEnv` opt-in.
 */
export function resolveCurrentRole(env: NodeJS.ProcessEnv = process.env): AgentRoleName | null {
  const raw = env.RELAY_AGENT_ROLE;
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Repo-admin tool whitelist. Kept as data so AL-12..AL-16 can extend it
 * without editing enforcement logic.
 *
 * Rationale per tool:
 *  - `channel_task_board`   — read the ticket board (AL-11 brief's
 *    `listChannelTickets` equivalent on the MCP surface).
 *  - `channel_get`          — pulls feed, tickets, decisions, run links in
 *    one call; repo-admin's primary "re-read the board" entry point.
 *  - `channel_post`         — status updates to the channel feed (propose a
 *    spawn, announce a PR merge decision). Strictly additive to the feed.
 *  - `harness_running_tasks`— cross-workspace running-task view.
 *  - `harness_list_runs` / `harness_get_run_detail` — read-only run state.
 *  - `spawn_worker`         — NAME ONLY. Declared so the role surface is
 *    stable for AL-14; the tool itself is stubbed and throws until AL-14
 *    wires worker spawning. See {@link REPO_ADMIN_TOOL_STUBS}.
 */
export const REPO_ADMIN_ALLOWED_TOOLS: ReadonlySet<string> = new Set<string>([
  // Read ticket board
  "channel_task_board",
  // Read decisions + feed + run links in a single call
  "channel_get",
  // Read-only channel message stream (feed append — additive, not a state mutation)
  "channel_post",
  // Cross-workspace running-task view
  "harness_running_tasks",
  // Read-only run-level views
  "harness_list_runs",
  "harness_get_run_detail",
  // Spawn ephemeral workers — declared here; implementation lands in AL-14.
  "spawn_worker",
]);

/**
 * Tool names that repo-admin is allowed to REFERENCE but whose handlers are
 * stubbed for later tickets. Calling a stubbed tool returns a structured
 * "stubbed; lands in AL-<N>" error so the agent sees the reason and the
 * capability report still lists the tool (i.e. AL-11 pins the surface; AL-14
 * fills in behaviour).
 */
export const REPO_ADMIN_TOOL_STUBS: Readonly<Record<string, string>> = {
  spawn_worker:
    "spawn_worker is declared in the repo-admin allowlist but its handler is " +
    "stubbed; worker spawning is implemented in AL-14. Propose the work on " +
    "the channel feed instead until then.",
};

/** Internal: role -> allowlist map. Additions land here, not in branching code. */
const ROLE_ALLOWLISTS: Readonly<Record<string, ReadonlySet<string>>> = {
  "repo-admin": REPO_ADMIN_ALLOWED_TOOLS,
};

/**
 * Decide whether `toolName` is callable under `role`.
 *
 * Semantics:
 *   - `null` role (RELAY_AGENT_ROLE unset): always allowed — unrestricted
 *     path, matches today's behaviour.
 *   - Role with an allowlist: membership check against the Set.
 *   - Unknown role (no entry in {@link ROLE_ALLOWLISTS}): unrestricted. A
 *     future ticket adding a new role opts into enforcement by adding an
 *     entry here; no silent denial by default.
 */
export function isToolAllowedForRole(role: AgentRoleName | null, toolName: string): boolean {
  if (!role) return true;
  const allowlist = ROLE_ALLOWLISTS[role];
  if (!allowlist) return true;
  return allowlist.has(toolName);
}

/**
 * Build the structured denial envelope returned to the caller when a tool
 * call is blocked by the per-role allowlist. Shape is intentionally stable
 * so agents can pattern-match on `error === "tool-not-allowed"` and choose
 * a different path (e.g. propose a worker spawn on the channel feed).
 */
export interface ToolDenialEnvelope {
  error: "tool-not-allowed";
  tool: string;
  role: string;
  reason: string;
}

/**
 * Produce the denial envelope for a role/tool pairing. Always called AFTER
 * {@link isToolAllowedForRole} has rejected the pair — the reason string is
 * role-specific so the agent gets actionable guidance rather than a generic
 * "denied".
 */
export function denyToolEnvelope(role: AgentRoleName, toolName: string): ToolDenialEnvelope {
  return {
    error: "tool-not-allowed",
    tool: toolName,
    role,
    reason: reasonFor(role, toolName),
  };
}

function reasonFor(role: AgentRoleName, toolName: string): string {
  if (role === "repo-admin") {
    return (
      `repo-admin does not call ${toolName}; this role coordinates workers ` +
      `but does not implement code, run tests, or merge PRs. Propose the ` +
      `work on the channel feed — a worker can pick it up.`
    );
  }
  return `${role} is not permitted to call ${toolName}.`;
}

/**
 * Enumerate the allowlist for a role. Used by the MCP capability report so
 * `tools/list` only advertises tools the current session can actually call.
 * Returns `null` for unrestricted (current behaviour: advertise everything).
 */
export function allowlistForRole(role: AgentRoleName | null): ReadonlySet<string> | null {
  if (!role) return null;
  return ROLE_ALLOWLISTS[role] ?? null;
}
