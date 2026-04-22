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
 * True iff the given role name is a key in {@link ROLE_ALLOWLISTS}. Unknown
 * roles flow through to the unrestricted path today (see
 * {@link isToolAllowedForRole}) — callers that need to distinguish "unknown"
 * from "unrestricted" should use this directly.
 */
export function isKnownRole(role: AgentRoleName | null): boolean {
  if (!role) return false;
  return Object.prototype.hasOwnProperty.call(ROLE_ALLOWLISTS, role);
}

/**
 * One-shot stderr warning for an unknown `RELAY_AGENT_ROLE` value. The same
 * role name is only warned about once per process so a chatty MCP loop
 * doesn't flood stderr — the warning is a startup signal ("typo in your role
 * name, security layer is not enforcing") not a per-call diagnostic.
 *
 * Split out from the server so unit tests can observe the behaviour directly
 * without booting a JSON-RPC handler. Exported only for the tests.
 *
 * I1 fix: previously a typo like `repoadmin` silently bypassed enforcement
 * because `isToolAllowedForRole` falls through to "allow" on unknown roles.
 * The fall-through itself is still the documented policy for the AL-12..16
 * rollout (new roles opt in by adding a map entry, not by editing branches),
 * but an unrecognised value should SHOUT so it can be noticed in logs rather
 * than ship as cosmetic enforcement.
 */
const warnedUnknownRoles = new Set<string>();
export function warnIfUnknownRole(role: AgentRoleName | null): void {
  if (!role) return;
  if (isKnownRole(role)) return;
  if (warnedUnknownRoles.has(role)) return;
  warnedUnknownRoles.add(role);
  // Use stderr directly: MCP stdout carries JSON-RPC framing and must stay
  // clean. Leading `[relay]` tag matches the rest of the codebase.
  process.stderr.write(
    `[relay] unknown RELAY_AGENT_ROLE=${role}, running unrestricted — check spelling\n`
  );
}

/** Test-only: reset the one-shot warn memo so each test observes a fresh warn. */
export function __resetUnknownRoleWarningsForTests(): void {
  warnedUnknownRoles.clear();
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
  // Append-only channel feed writer — additive status updates (propose a
  // spawn, announce a merge decision). This IS a write; "append-only" means
  // it cannot retract or edit prior entries, not that it's read-only.
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

/**
 * Built-in Claude CLI tools that bypass MCP entirely and therefore cannot be
 * gated by `isToolAllowedForRole`. The Claude CLI runs Edit/Write/Bash/…
 * in-process — those calls never round-trip through the MCP server, so the
 * allowlist in this module is **cosmetic** for that attack surface. To
 * actually enforce the deny, the CLI adapter passes
 * `--disallowed-tools <names,…>` to the `claude` binary when spawning.
 *
 * Kept as a map from role -> string[] so new roles adding their own lockdown
 * (AL-12..AL-16) don't have to touch adapter code — just add an entry.
 *
 * Rationale for repo-admin's list:
 *  - `Edit`, `Write`, `NotebookEdit` — repo-admin does not edit files.
 *  - `Bash` — the `gh pr merge` escape hatch AND the "run tests" escape
 *    hatch both go through Bash. Dropping Bash closes both without needing
 *    a fine-grained command-level allowlist (which Claude CLI doesn't
 *    expose today).
 *
 * Not denied here (left to MCP-layer enforcement, which IS effective for
 * MCP-routed tools): `harness_dispatch`, `harness_approve_plan`,
 * `project_create`, etc. Those ARE JSON-RPC calls so the MCP allowlist does
 * its job.
 *
 * Read tools (`Read`, `Glob`, `Grep`) are intentionally NOT on the deny list:
 * repo-admin needs to look at the board, decisions, and occasionally source
 * files to reason about what to dispatch.
 */
const DISALLOWED_BUILTINS_BY_ROLE: Readonly<Record<string, readonly string[]>> = {
  "repo-admin": ["Edit", "Write", "NotebookEdit", "Bash"],
};

/**
 * Return the list of Claude built-in tool names that must be passed to the
 * `claude` CLI via `--disallowed-tools` for the given role. Empty array when
 * the role has no built-in lockdown (or is `null` / unknown). Callers that
 * want to know "is this role a restricted session at all?" should check for
 * a non-empty return.
 */
export function getDisallowedBuiltinsForRole(role: AgentRoleName | null): readonly string[] {
  if (!role) return [];
  return DISALLOWED_BUILTINS_BY_ROLE[role] ?? [];
}
