# Repo-admin (foreman) vs. workers (crew)

Landed in **AL-11**. Lifecycle, routing, spawn-worker wiring, memory-shed,
and inter-admin coordination land in **AL-12..AL-16** — this doc covers the
role definition only.

## The split

Relay's autonomous loop has two tiers of agent sessions:

| Tier       | Lifetime                 | Scope       | Does                                                           | Does NOT                         |
| ---------- | ------------------------ | ----------- | -------------------------------------------------------------- | -------------------------------- |
| repo-admin | long-lived, one per repo | single repo | coordinates worktrees, dispatches workers, sequences PR merges | edit files, run tests, merge PRs |
| worker     | ephemeral, per ticket    | one ticket  | writes code, runs tests, opens PRs                             | carries state across tickets     |

The split exists to keep cognitive load bounded. Repo-admin is a
**coordination layer**, not a memory authority. Workers are the crew: they
execute a single ticket inside an isolated worktree and terminate. When
repo-admin needs to reconsult history, it re-reads the channel board + the
`channels/<id>/decisions/` directory — not chat summaries.

## Memory policy

Repo-admin caches only the **active working set**:

- in-flight tickets (by id)
- open PRs (by number)
- current worktrees (by path)

Anything beyond that is re-read on demand from disk. The source of truth is:

1. The **ticket board** — `channel_task_board` MCP tool, or the
   `tickets.json` file under `channels/<id>/`.
2. The **decisions** — `channels/<id>/decisions/<decisionId>.json`, surfaced
   via `channel_get`.
3. The **git log** — for each repo, the canonical record of what shipped.

Chat history and scratch summaries are intentionally not load-bearing. If a
repo-admin session restarts, re-reading the three sources above must be
sufficient to pick the loop back up. AL-15 will formalize this into a
bounded memory-shed; AL-11 establishes the discipline in the system prompt.

## MCP tool allowlist

Data-driven in `src/mcp/role-allowlist.ts`. Repo-admin can call:

- `channel_task_board` — read the ticket board
- `channel_get` — read decisions + feed + run links in one call
- `channel_post` — append-only status updates on the channel feed
- `harness_running_tasks` — cross-workspace running-task view
- `harness_list_runs` / `harness_get_run_detail` — read-only run state
- `spawn_worker` — **declared, stubbed** until AL-14 fills in the handler

Denied by design: file edits (`Edit`, `Write`, `NotebookEdit`), test runners
(any `Bash`-backed test invocation), PR merges (`gh pr merge`), and any MCP
tool that mutates state outside `spawn_worker` (e.g. `harness_dispatch`,
`harness_approve_plan`, `project_create`).

## Enforcement

Role is read from the `RELAY_AGENT_ROLE` env var at the MCP server layer.
Two consult points inside `src/mcp/server.ts`:

- **`tools/list`** filters the advertised tool set to the role's allowlist.
  A repo-admin session sees only what it can call; the capability report
  matches the allowlist one-for-one (tested via `test/mcp/role-allowlist.test.ts`).
- **`tools/call`** consults `isToolAllowedForRole(role, toolName)` before
  dispatch. On deny, the server returns a **structured envelope**
  (`{error: "tool-not-allowed", tool, role, reason}`) with `isError: true`
  — not a silent failure. The agent sees the reason (role-specific: repo-admin
  gets "propose a worker spawn instead") and adjusts.

Unknown roles (i.e. any `RELAY_AGENT_ROLE` value that isn't mapped in
`ROLE_ALLOWLISTS`) fall through to the unrestricted path. That's deliberate
for the AL-12..AL-16 rollout — a new role opts into enforcement by adding
an entry to the map, not by editing switch statements.

## Files of record

- `src/agents/repo-admin.ts` — role identity, system prompt, stub handlers.
- `src/mcp/role-allowlist.ts` — per-role tool whitelist + denial envelope.
- `src/mcp/server.ts` — integration into `tools/list` and `tools/call`.
- `test/agents/repo-admin.test.ts` — allowlist exactness, system-prompt
  substrings, stub behaviour.
- `test/mcp/role-allowlist.test.ts` — end-to-end handler behaviour under
  `RELAY_AGENT_ROLE=repo-admin`.
