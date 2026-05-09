# Relay Roadmap

> Lightweight roadmap scaffolded by `/gsd-explore` on 2026-05-09. Relay predates GSD initialization; this file captures phases as they're identified. Run `/gsd-map-codebase` and `/gsd-new-milestone` to formalize a milestone container around these.

## Phases

### Phase 1: Per-session token-usage telemetry + context-window bar

**Goal.** Surface a live "% of context window consumed" indicator per session, visible in TUI, GUI, and CLI status. Foundation for the handoff feature's 90% nudge.

**Why.** Users (and the harness itself) need to know how close a session is to exhausting its context. Today this is invisible until the agent starts misbehaving or refuses. GSD's terminal display has a small percentage indicator that the user found valuable; we want that ergonomic in Relay, with the added property that the same signal feeds Phase 2's handoff trigger.

**Scope.**

- Per-session token-usage signal in the orchestrator. Read from each provider adapter (Claude / Codex) — small adapter layer because providers expose context differently.
- Persist usage snapshots to `~/.relay/` so dashboards can read them without polling the running session.
- TUI: render a percent bar in the session pane (likely under the session header in `tui/`).
- GUI: render in the session detail view in `gui/` (and possibly a global header chip showing the worst session).
- CLI: include in `rly status` / session listing output.
- Threshold events emitted on the channel feed at 75% / 90% / 95% (so Phase 2 can subscribe).

**Acceptance.**

- All three dashboards show context-window usage live.
- Telemetry survives session restart (read from disk, not in-memory only).
- Threshold events appear on the channel feed at the configured marks.
- Works for both Claude and Codex sessions.

**Dependencies.** None. Self-contained, ships independently.

**Plans:** 1 plan

- [ ] 01-01-PLAN.md — End-to-end token-usage telemetry: adapter usage extraction (Claude + Codex), tracker pool + dispatch wiring, threshold-feed bridge (75/90/95), Rust SessionBudget mirror + harness-data loader, TUI/GUI/CLI bars, chat-mode parity hook.

---

### Phase 2: Handoff command + brief synthesizer

**Goal.** `rly handoff <channelId> --to <alias|--provider>` produces a structured brief from `~/.relay/` artifacts, lets the departing agent fill in working-memory gaps, and seeds a fresh session in the new provider with the brief — instead of replaying the raw transcript.

**Why.** Users frequently exhaust credits with one provider mid-task and want to switch (Claude ↔ Codex), or pause and resume after days away. Today there's no clean way to transfer context. Relay's existing persistence (channel feed, decision log with rationale + alternatives, ticket DAG, file-touch history) is the right corpus for a handoff brief.

**Scope.**

- `rly handoff <channelId> --to <alias>` (and `--provider <name>`) CLI command.
- **Deterministic brief synthesizer.** Reads channel artifacts, joins them into a structured markdown brief with sections for: status snapshot, ticket DAG state, recent decisions (with rationale + alternatives), files touched, and slots for the agent-authored gaps.
- **Agent-authored gap hook.** Before session ends, departing agent is asked to author the gap-filling section: current line of attack, active hypothesis, abandoned approaches, open questions. Stored in the brief.
- **90% nudge.** When Phase 1's threshold event for 90% fires on a session's channel, surface a prompt to the user: "you're at 90% — want to hand off?" — yes routes to `rly handoff`, no continues. Human-in-the-loop.
- **New-session seed.** Dispatch the new aliased session with the brief as its first turn. Just the brief; not the brief plus recent feed (revisit if briefs feel thin).
- Brief is also writable to disk for the "resume after a week" case (`rly handoff --to-disk` or similar — tbd in plan).

**Acceptance.**

- Departing agent's brief covers both the artifact-derived skeleton and the working-memory gaps.
- New session starts with the brief seeded; first response demonstrates context retention (knows current line of attack, won't re-litigate decisions already made).
- 90% nudge fires and routes correctly when accepted; declining continues without disruption.
- No auto-trigger ever.

**Dependencies.** Phase 1 (telemetry + threshold events).

**Open questions for plan-phase.**

- Exact brief markdown shape and section ordering.
- Whether `--to` accepts both alias and provider, or whether they're separate flags.
- LLM polish pass on the deterministic skeleton — deferred. Start without it; add only if briefs feel rough in practice.

---

### Phase 3: Repo-admin readiness handshake

**Goal.** Add an explicit `agent-ready` state (and channel event) that fires when a repo-admin finishes its onboarding turn — distinct from heartbeat liveness, so consumers can honestly distinguish "process is alive" from "agent is ready to receive tasks."

**Why.** Heartbeat today (`CrosslinkSession.lastHeartbeat` + pid liveness) tells observers a session's process is alive. It does NOT tell them the repo-admin has finished reading the board, indexing the repo, and is ready to be addressed. Users can't trust a green heartbeat indicator because it conflates "alive" with "ready," and any UI built on top of the current signal will mislead. This is the foundational primitive that Phase 4 (the project readiness surface) reads from. Without it, Phase 4 ships a dashboard that lies.

The existing `repo-ready` typed coordination message means _"my PR merged, your blocker is gone"_ — that's a workflow signal, not a boot signal. This phase introduces a separate, explicit _boot-readiness_ signal.

**Scope.**

- New session lifecycle state (or a flag on existing state) for "ready" — clearly distinct from the current `dispatching`-and-related states. Defined in `src/lifecycle/session-lifecycle.ts`.
- `agent-ready` channel-feed event (or extend the existing decision/feed types) emitted when a repo-admin completes its onboarding turn (board read, repo indexed, optional health check passed).
- Repo-admin system prompt updated so the agent emits the readiness signal explicitly when onboarding is done — gives the agent a deterministic moment to assert "I'm ready."
- Heartbeat continues unchanged; readiness is layered on top, not a replacement.
- Surface the readiness state through `harness-data` crate so TUI / GUI / CLI / hooks can all read it consistently.
- No worker readiness yet (workers don't exist as a real tier until AL-14 / `spawn_worker` lands). This phase covers admins only; the worker version mirrors this design once C lands.

**Acceptance.**

- A repo-admin session transitions from "alive" to "ready" exactly once per boot, and the transition fires a typed channel event observers can subscribe to.
- The `harness-data` crate exposes the readiness state to dashboards (matches the existing pattern used by TUI + GUI).
- Heartbeat behaviour is unchanged — readiness is additive.
- A test asserts the explicit "alive but not ready" window exists during onboarding (not just instantaneously transitioned at boot).
- Repo-admin tests pin the system-prompt language that instructs the agent to emit the signal.

**Dependencies.** None. Self-contained.

**Open questions for plan-phase.**

- Whether readiness is a session-lifecycle state, a flag on the session record, a channel-feed event, or all three.
- What constitutes "ready" precisely — agent-asserted via prompt? Coordinator-validated? Some health probe?
- Whether this design generalises cleanly to per-task workers (Phase 5 / AL-14) or whether worker readiness will need its own shape.

---

### Phase 4: Project readiness surface

**Goal.** Give the user a single, honest view per project of: which repos are connected, which repo-admin sessions are alive, which are ready (per Phase 3), and what's flowing on the channel feed. Visible in three places: in-session (Claude/Codex via SessionStart hook), TUI, and GUI — all reading the same state from `~/.relay/`.

**Why.** The user's three trust pains all collapse to "I can't see what state the system is in": _Are the right repos wired up? Have agents finished onboarding? Is anything actually working?_ Today the answer requires opening the GUI, asking the agent, or grepping `~/.relay/`. The fix is to make the system _announce_ its state at every surface the user already touches. This is what makes Relay's multi-repo value proposition feel real instead of theoretical.

This is also the surface that downstream work (slash commands, hook-based intent inference, AL-14 worker dispatch) sits on top of. Without it, every later UX improvement compounds the same trust gap.

**Scope.**

- **In-session (highest leverage):** `SessionStart` hook for Claude (`~/.claude/settings.json`) and the Codex equivalent, dropped by `rly install`. Hook injects current project state into the session's first turn: connected repos, admin alive/ready states (from Phase 3), unread channel events. Format: short, scannable, agent- and human-readable.
- **TUI (`tui/`):** project-rooted view — top-level lists projects, drilling in shows repos × admin state × recent feed events. Reads via `crates/harness-data/`.
- **GUI (`gui/`):** matching project-rooted view; integrates cmux pane references where applicable so the user can jump from "agent X" → that agent's running pane.
- **CLI (`rly status` / new `rly project show <name>`):** terse project state for terminal-only consumers.
- All four surfaces read the same state — no drift, no separate APIs.

**Acceptance.**

- A user running `rly claude` sees the project's repos + admin readiness in their first turn (via hook-injected context), without typing anything.
- TUI and GUI both render a project-rooted view that surfaces alive vs ready vs not-connected.
- A repo not yet connected to the active project is visibly distinct from a repo whose admin is still booting.
- Closing and reopening any of the surfaces shows the same state — all read from `~/.relay/`, none cache in-process.

**Dependencies.** Phase 3 (readiness handshake — without it, the surface conflates alive with ready and lies to users).

**Open questions for plan-phase.**

- Exact format of the hook-injected context (token budget vs information density).
- Whether the hook also injects a diff since last turn (unread events) or only current state.
- Whether "project" is an explicit first-class concept in `~/.relay/` already, or whether this phase needs to formalise it.
- Codex hook surface parity with Claude Code's `SessionStart` — may differ; document the gap.

---

### Phase 5: Per-task worker tier (AL-14 — `spawn_worker`)

**Goal.** Land the real `spawn_worker` handler so repo-admins can dispatch ephemeral per-task workers into isolated worktrees. Workers handle planning → build → review → PR, reporting back up to the spawning admin.

**Why.** This is the missing depth tier of Relay's stated architecture. Today `src/agents/repo-admin.ts:201` exports `spawnWorkerStub` which throws, and the MCP server returns a `tool-not-allowed`-shaped error. Repo-admins exist, can talk to each other, but cannot dispatch real work — so the value proposition ("fire-and-forget multi-repo agent teams") doesn't actually run end-to-end. Already declared as AL-14 in the existing repo-admin role definition; this phase finishes that ticket and integrates it with the readiness/surface work above.

**Scope.**

- Replace `spawnWorkerStub` with a real handler in `src/agents/repo-admin.ts` and `src/mcp/server.ts`.
- Worker lifecycle re-uses the Phase 3 readiness handshake — workers also transition spawning → onboarding → ready, with the same channel event shape.
- Worktree creation per worker (existing git-worktree-sandbox machinery — `test/execution/git-worktree-sandbox.test.ts` suggests this is wired).
- Worker → admin reporting: worker progress events flow back through the channel feed; admin re-reads the board (per existing memory policy).
- Specialty routing: `atlas` / `pixel` / `forge` / `lens` / `probe` / `eng-manager` per the existing role guidance in `repo-admin.ts:127-134`.
- Phase 4 surfaces (TUI / GUI / hook) automatically pick up worker state — no separate dashboard work.

**Acceptance.**

- A repo-admin can call `spawn_worker` and a real worker process boots into an isolated worktree.
- The worker emits the readiness signal from Phase 3 when its onboarding completes.
- Worker progress (planning → build → review → PR) is observable on the channel feed.
- Phase 4's surfaces render workers under their spawning admin without code changes.
- AL-12 (lifecycle), AL-13 (routing), AL-15 (memory-shed) — flag as either bundled or follow-up tickets in plan-phase.

**Dependencies.** Phase 3 (so workers reuse the readiness primitive). Phase 4 helpful but not strictly blocking — workers can run without surfaces, just less observable.

**Open questions for plan-phase.**

- Whether AL-12 / AL-13 / AL-15 land bundled with AL-14 or as follow-ups.
- How worker → admin reporting handles the working-set / memory-shed boundary.
- cmux pane integration: do workers run inside cmux panes by default, or is that opt-in via a launch flag?
