---
title: Relay multi-repo architecture — what's built vs stubbed (as of 2026-05-09)
date: 2026-05-09
context: Captured during /gsd-explore while scoping the readiness/observability work. Confirms what exists in the codebase today so we can sequence A (surface state) / B (readiness handshake) / C (AL-14 spawn_worker) without rebuilding things that are already there.
---

# Architecture status snapshot

## The intended architecture (per user)

Two-tier multi-repo system:

- **Repo-admin (persistent, one per repo):** long-lived foreman. Tracks state, coordinates worktrees, sequences PR merges, talks to other repo-admins via typed coordination messages. Does NOT edit code, run tests, or merge PRs itself.
- **Per-task team (ephemeral, spawned per ticket):** workers spawned into isolated worktrees that handle planning, build, review, PR — then report back up to the repo-admin.

User then talks to the main agent → main agent talks to repo-admins → repo-admins dispatch to workers.

## What's built today ✅

### Liveness heartbeat
- `CrosslinkSession.lastHeartbeat` ISO timestamp — `src/crosslink/types.ts:36`.
- Updated in-place on register and on subsequent activity — `src/crosslink/store.ts:185`.
- `discoverSessions` filters out stale sessions: `!isProcessAlive(pid) && heartbeatAge > STALE_HEARTBEAT_MS` — `src/crosslink/store.ts:220-227`.
- Used by the `crosslink_*` MCP tools and the auto-injected system-prompt text in `src/cli/agent-wrapper.ts:36-48`.

### Session lifecycle state machine
- `src/lifecycle/session-lifecycle.ts` — states including `dispatching`, with timeout transitions.

### Repo-admin role (AL-11 + AL-16)
- `src/agents/repo-admin.ts` — system prompt + memory policy + tool allowlist + AL-16 typed-coordination guidance.
- Allowlist enforced by `src/mcp/role-allowlist.ts`.
- `REPO_ADMIN_MEMORY_POLICY_MARKER` and `REPO_ADMIN_COORDINATION_POLICY_MARKER` are pinned by tests so prompt drift trips CI.

### Typed inter-admin coordination (AL-16)
- Three message kinds in `src/crosslink/messages.ts`: `blocked-on-repo`, `repo-ready`, `merge-order-proposal`.
- Coordinator validates shape, routes to target admin, audits as a typed decision (`type: coordination_message`) — `src/crosslink/coordinator.ts:267, 480-506`.
- Coordinator rejects sends that would form block cycles.

### MCP tool surface
- ~16 tools registered: `channel_create`, `channel_get`, `channel_post`, `channel_record_decision`, `channel_task_board`, `harness_running_tasks`, `harness_status`, `harness_list_runs`, `harness_get_run_detail`, `harness_get_artifact`, `harness_approve_plan`, `harness_reject_plan`, `project_create`, `harness_dispatch`, `pr_review_start`, `spawn_worker` (stub).
- Plus crosslink tools registered separately: `crosslink_register`, `crosslink_discover`, `crosslink_send`, `crosslink_poll`, `crosslink_reply`.

### System-prompt injection at launch
- Claude: `--append-system-prompt` with `HARNESS_SYSTEM_PROMPT` (`src/cli/agent-wrapper.ts:36-48`).
- Codex: `mcp_servers.relay` config via `-c` flags.
- The injected prompt currently documents only the `crosslink_*` surface.

## What's stubbed / missing ❌

### `spawn_worker` is a stub (AL-14 not landed)
- `src/agents/repo-admin.ts:201` exports `spawnWorkerStub` which throws.
- `src/mcp/server.ts:475-491` registers the tool but routes to the stub, returning a `tool-not-allowed`-shaped error.
- Comment chain references AL-12 (lifecycle), AL-13 (routing), AL-14 (worker spawning), AL-15 (memory-shed) as separate not-yet-landed tickets.
- Implication: the **per-task team tier of the architecture does not actually run today.** Repo-admins exist, can talk to each other, but cannot dispatch real workers.

### No boot-readiness signal
- Heartbeat = "process is alive." There is no distinct "agent has finished onboarding / is ready to be addressed" state.
- A user observing a green heartbeat indicator could be looking at an admin still mid-context-collection. No way to tell.
- `repo-ready` *exists* as a coordination message kind — but it means *"my PR merged, your blocker is gone,"* not *"my admin is ready to receive tasks."* Workflow signal, not boot signal.

### No project-rooted state aggregate
- Workspace registry exists, but nothing aggregates "for project X, here are the connected repos × admin states × recent feed events."
- The TUI and GUI both read `~/.relay/` (via the shared `crates/harness-data/` crate per `AGENTS.md`) but neither presents a project-readiness view.
- No `SessionStart` hook injects the equivalent into wrapped Claude/Codex sessions.

### Setup ergonomics for "connect a repo to a project"
- Heuristics likely exist via channels and workspace registry; not documented as a clear flow. Worth a separate audit before designing the surface.

## Implications for sequencing

- **B (readiness handshake)** can ship without C — repo-admins already exist as a role; we can fire a `agent-ready` event when their onboarding turn completes, independent of whether they can spawn workers.
- **A (surface state)** depends on B's signal shape — if A is built on heartbeat-only, the surface lies; once B exists, A renders honest state.
- **C (AL-14 `spawn_worker`)** is the largest unknown. Worth landing after A+B because once it runs, A automatically gets richer (workers also boot through spawning → onboarding → ready).
- The cmux integration plugs into A: workers run in cmux panes per worktree, and the surface should reference those panes for live tailing.
