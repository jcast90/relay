# Requirements

Requirements for Relay's current milestone (M01 — Trust-stack + cross-repo delegation). Derived from `PROJECT.md` (north star, validated set, active set) and `ROADMAP.md` (Phases 1-5).

> Quality bar: each requirement is specific, testable, user-centric, atomic, and independent.
>
> Validated (`[x]`) means shipped and observable on `main`. Active (`[ ]`) means scoped for a roadmap phase. Out-of-scope items live in PROJECT.md.

---

## Validated Requirements

Inferred from shipped behaviour. Sources: `git log`, README, AGENTS.md, Phase 1-3 SUMMARYs, v0.2/v0.7.0 releases.

### Cross-repo delegation (DELEG)

- [x] **DELEG-01**: Sessions running in different repos discover each other through MCP crosslink tools and exchange typed messages directly. — pre-GSD-init (`src/crosslink/*`)
- [x] **DELEG-02**: A ticket DAG carries `assignedAlias` routing so a feature touching N repos is one plan with N ticket streams scheduled in dependency order. — pre-GSD-init (`src/orchestrator/decomposer.ts`)
- [x] **DELEG-03**: Two-tier architecture exists in the codebase: persistent repo-admin sessions + (currently stubbed) ephemeral workers. Admins talk via typed coordination messages (AL-16). — pre-GSD-init (`src/agents/repo-admin.ts`)
- [x] **DELEG-04**: Session lifecycle heartbeat (`CrosslinkSession.lastHeartbeat` + pid liveness) lets observers detect stale sessions. — pre-GSD-init (`src/crosslink/store.ts`)

### Audit trail (AUDIT)

- [x] **AUDIT-01**: Every cross-repo decision routed through Relay produces an append-only record with rationale + alternatives. — pre-GSD-init (`src/channels/channel-store.ts`)
- [x] **AUDIT-02**: Channel feed is Slack-shaped (typed entries: status_update, decision, ticket-event) and queryable after the fact. — pre-GSD-init
- [x] **AUDIT-03**: All state (channels, tickets, decisions, crosslink messages) lands in `~/.relay/` as JSON/JSONL files. — pre-GSD-init

### Three dashboards (DASH)

- [x] **DASH-01**: CLI (`rly`), ratatui TUI (`tui/`), and Tauri desktop GUI (`gui/`) all render the same state by reading `~/.relay/` files directly. No sync layer, no shared in-process cache. — pre-GSD-init
- [x] **DASH-02**: Shared Rust crate `crates/harness-data/` is the single read path for TUI + GUI. — pre-GSD-init
- [x] **DASH-03**: Shared Rust crate `crates/relay-paths/` provides `cli_bin()` + `augmented_child_path()` for spawning subprocesses consistently from TUI and GUI. — Phase 1 PR-3 (#225)

### Multi-provider (PROV)

- [x] **PROV-01**: Claude CLI adapter dispatches work end-to-end (orchestrator + chat). — pre-GSD-init (`src/agents/claude-cli-agent.ts`)
- [x] **PROV-02**: Codex CLI adapter dispatches work end-to-end (orchestrator). — pre-GSD-init (`src/agents/codex-cli-agent.ts`)

### GitHub Projects v2 (TRACK)

- [x] **TRACK-01**: Channels project to GH Projects v2 boards; channel = epic, ticket = draft item with `Type` / `Status` / `Priority` custom fields kept in sync. — v0.7.0 (#199)
- [x] **TRACK-02**: Drift detected on GitHub is logged to the channel feed and overwritten (Relay stays authoritative). — v0.7.0
- [x] **TRACK-03**: URL-paste classifier resolves a pasted GH Projects item URL to project + epic + ticket. — v0.7.0

### Autonomous mode (AUTO)

- [x] **AUTO-01**: `rly run --autonomous <channelId> --budget-tokens <N> --max-hours <H>` runs unattended bounded by wall-clock + token budget. — pre-GSD-init
- [x] **AUTO-02**: STOP-file kill switch (`~/.relay/STOP`) aborts an autonomous run before the next agent dispatch. — pre-GSD-init

### Install + drift (INSTALL)

- [x] **INSTALL-01**: `rly install` writes a manifest of installed bits; `rly install --check` reports drift between installed and running versions. — #208
- [x] **INSTALL-02**: TUI footer reads the install manifest at startup and surfaces a drift nudge. — #210
- [x] **INSTALL-03**: GUI in-app update banner reads `rly install --check`. — #209

### Token-usage telemetry (TELEM) — Phase 1

- [x] **TELEM-01**: Per-session token-usage signal extracted from Claude + Codex adapter output. — Phase 1 PR-2 (#223)
- [x] **TELEM-02**: Usage snapshots persisted to `~/.relay/sessions/<sessId>/budget.jsonl` so dashboards read from disk, not memory. — Phase 1 PR-1+PR-2 (#218, #223)
- [x] **TELEM-03**: Threshold events at 75 / 90 / 95 % land on the channel feed as `type: status_update` entries with `metadata.kind: "context_threshold"` and `metadata.schemaVersion: "1"`. — Phase 1 PR-2 (#223)
- [x] **TELEM-04**: TUI renders a `% of context window consumed` bar per session, live-updating for both orchestrator and TUI chat-launched sessions. — Phase 1 PR-3 (#225)
- [x] **TELEM-05**: GUI renders a per-session bar + a worst-session chip (filtered to `kind: "chat"` entries). — Phase 1 PR-3 (#225)
- [x] **TELEM-06**: `rly status` includes context-window usage in session listings. — Phase 1 PR-4 (#227)
- [x] **TELEM-07**: TS `SessionBudget` schema has a Rust mirror in `crates/harness-data`; `kind` discriminator distinguishes `chat` vs `admin` budgets. — Phase 1 PR-1 (#218)
- [x] **TELEM-08**: Threshold-event contract published as a design doc and consumed bidirectionally by Phase 2. — Phase 1 PR-5 (#228) ↔ Phase 2 PR-3 (#222)

### Handoff command (HANDOFF) — Phase 2

- [x] **HANDOFF-01**: `rly handoff <channelId> --to <alias>` (and `--provider <name>`) produces a structured markdown brief from `~/.relay/` artifacts. — Phase 2 PR-4 (#224)
- [x] **HANDOFF-02**: Departing agent is prompted to author a gap-fill section (current line of attack, hypothesis, abandoned approaches, open questions) before the session ends; gap-fill persists via `channel_handoff_finalize` MCP tool. — Phase 2 PR-2 (#220)
- [x] **HANDOFF-03**: When Phase 1's 90 % threshold event fires, the user sees a prompt — "you're at 90 % — want to hand off?" — routed through the standard approval kind. Never auto-triggered. — Phase 2 PR-3 (#222)
- [x] **HANDOFF-04**: Brief synthesizer covers status snapshot, ticket DAG state, recent decisions (with rationale + alternatives), files touched, and gap-fill slots. — Phase 2 PR-1 (#219)
- [x] **HANDOFF-05**: New aliased session is seeded with the brief as its first turn; brief is also writable to disk for the "resume after a week" case. — Phase 2 PR-4 (#224)

### Readiness handshake (READY) — Phase 3

- [x] **READY-01**: `CrosslinkSession.readyAt` + `readyKind` (TS + Rust mirror in `harness-data`) — the first crosslink type with a readiness signal. — Phase 3 (#216)
- [x] **READY-02**: `agent_ready` MCP tool in `src/mcp/readiness-tools.ts`, allowlisted to repo-admin only. — Phase 3 (#216)
- [x] **READY-03**: `CrosslinkStore.updateReadiness` is monotonic-once-set + idempotent on re-call. — Phase 3 (#216)
- [x] **READY-04**: Repo-admin system prompt includes a boot-readiness assertion (pinned by `REPO_ADMIN_READINESS_MARKER`) that obliges the agent to call `agent_ready` when onboarding completes. — Phase 3 (#216)
- [x] **READY-05**: `harness-data::load_crosslink_sessions()` exposes readiness state to TUI / GUI / CLI consumers. — Phase 3 (#216)
- [x] **READY-06**: Heartbeat behaviour is unchanged; readiness is additive — alive ≠ ready. A test asserts the "alive but not ready" window exists during onboarding. — Phase 3 (#216)

---

## Active Requirements

Scoped for the current milestone (M01). Hypotheses until shipped and validated.

### Project readiness surface (SURFACE) — Phase 4

- [ ] **SURFACE-01**: `SessionStart` hook for Claude (`~/.claude/settings.json`) injects current project state into the session's first turn — connected repos, admin alive/ready states (from READY-*), unread channel events. Dropped by `rly install`.
- [ ] **SURFACE-02**: Codex `SessionStart` equivalent ships parity (or documents the gap explicitly if Codex's hook surface differs).
- [ ] **SURFACE-03**: TUI shows a project-rooted view — top-level list of projects, drilling in shows repos × admin state × recent feed events. Reads via `harness-data`.
- [ ] **SURFACE-04**: GUI ships a matching project-rooted view, with optional cmux pane references so the user can jump from "agent X" to its running pane.
- [ ] **SURFACE-05**: `rly status` and `rly project show <name>` print terse project state for terminal-only consumers.
- [ ] **SURFACE-06**: A repo not yet connected to the active project is visibly distinct from a repo whose admin is still booting (i.e., the four states — not-connected / alive-not-ready / ready / stale — are unambiguous in all surfaces).
- [ ] **SURFACE-07**: Closing and reopening any surface shows the same state — no in-process cache, all reads land on `~/.relay/`.

### Per-task worker tier (WORKER) — Phase 5 / AL-14

- [ ] **WORKER-01**: `src/agents/repo-admin.ts:229` `spawnWorkerStub` is replaced by a real `spawnWorker` handler in `src/mcp/server.ts`.
- [ ] **WORKER-02**: Worker lifecycle reuses the READY-* primitive — workers transition spawning → onboarding → ready, with the same channel event shape.
- [ ] **WORKER-03**: Each worker boots into an isolated git worktree (uses existing git-worktree-sandbox machinery).
- [ ] **WORKER-04**: Worker progress (planning → build → review → PR) is observable on the channel feed; admin re-reads the board per existing memory policy.
- [ ] **WORKER-05**: Specialty routing exists per the existing role guidance (`atlas` / `pixel` / `forge` / `lens` / `probe` / `eng-manager`).
- [ ] **WORKER-06**: Phase 4 surfaces (SURFACE-*) render workers under their spawning admin without code changes.
- [ ] **WORKER-07**: Decision logged in plan-phase: whether AL-12 (lifecycle), AL-13 (routing), AL-15 (memory-shed) bundle with AL-14 or land as follow-up tickets.

---

## Out of Scope (this milestone)

See PROJECT.md "Out of Scope" for project-wide exclusions. Milestone-specific deferrals:

- **Chat-first workflow surface (CHAT-*)** — strategic direction, not yet a roadmap phase. Phases 1-5 are plumbing underneath; the chat-first UX itself is a future-milestone candidate. Tracked in PROJECT.md "Strategic Directions."
- **L0-L6 learning layer** — strategic direction. Design implication for L0 (`trajectories.jsonl` federation field from day one) is on PROJECT.md so it doesn't get retrofit-only. No active requirements yet.
- **Cost guardrails (dollar-based budget caps)** — Phase 1 ships *context-window* telemetry only. Token-count-to-dollar conversion + per-run/ticket/channel cost caps deferred to a future phase.
- **Brief auto-archive** — `~/.relay/sessions/<id>/budget.jsonl` files accumulate. Retention policy (last N sessions, last 30 days) is future scope.
- **Codex Branch A vs Branch B usage extraction** — INCONCLUSIVE per Phase 1 A1 spike (`codex` CLI not installed in CI). Today Codex chat sessions silently no-op the budget tracker. Re-run spike when `codex` lands in CI.

---

## Traceability

Every Active requirement maps to exactly one phase. Validated requirements include the originating phase or release for forensic backtracking.

| Phase | Requirements |
|-------|--------------|
| Phase 1 — Token-usage telemetry | TELEM-01 → TELEM-08 (8 validated) |
| Phase 2 — Handoff command | HANDOFF-01 → HANDOFF-05 (5 validated) |
| Phase 3 — Readiness handshake | READY-01 → READY-06 (6 validated) |
| Phase 4 — Project readiness surface | SURFACE-01 → SURFACE-07 (7 active) |
| Phase 5 — Per-task worker tier | WORKER-01 → WORKER-07 (7 active) |
| Pre-GSD-init / earlier releases | DELEG-01..04, AUDIT-01..03, DASH-01..02, PROV-01..02, AUTO-01..02 |
| v0.7.0 — Tracker integration | TRACK-01 → TRACK-03 |
| `rly install` work (#208, #209, #210) | INSTALL-01 → INSTALL-03 |
| Phase 1 PR-3 (#225) | DASH-03 |

**Coverage:** All 5 phases mapped. 14 of 14 Active requirements scoped to a phase. 39 Validated requirements with provenance.
