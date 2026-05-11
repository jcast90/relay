# Phase 4: Project readiness surface - Context

**Gathered:** 2026-05-11
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 4 delivers a single, honest view per channel of: which repos are connected, which repo-admin sessions are alive vs ready (per Phase 3), and what's flowing on the channel feed. Visible at four surfaces the user already touches: (1) in-session, via a `SessionStart` hook for Claude (and a Codex equivalent — see Deferred), (2) TUI (`tui/`), (3) GUI (`gui/`), and (4) CLI (`rly status` and possibly a new `rly project show <name>` — planner's call). All four surfaces read the same state from `~/.relay/` — no separate APIs, no drift.

Phase 4 is the consumer half of Phase 3's readiness primitive. Without it, the readiness signal exists but is invisible.

</domain>

<decisions>
## Implementation Decisions

### Top-level entity model
- **D-01:** **Channel IS the project.** Phase 4 introduces no new entity. TUI/GUI top-level lists channels (filtered by `status === "active"` or similar); drilling into a channel shows repos × admin states × recent feed events. Matches today's mental model — `Channel.repoAssignments[]` and `workspaceIds[]` already define the cross-repo unit. A new top-level `Project` entity was explicitly rejected as a future concern, not Phase 4 scope.
- **D-02:** **Active-channel resolution for the hook:** the SessionStart hook resolves the active channel by (a) reading `RELAY_CHANNEL_ID` env if set (the spawner already threads this for repo-admin sessions per Phase 3), else (b) deriving from the session's `cwd` via `Channel.repoAssignments[]` reverse lookup. Hook degrades gracefully (no injection) if neither path resolves — this is the same degradation shape as `agent_ready` when no channel context exists (Phase 3 D-03).

### Hook content shape
- **D-03:** **Density: terse one-liner per repo.** Target ~5-15 lines total for a typical 3-repo channel. Hook output is a fenced text block that the agent's first turn can scan in a single glance. Sample shape:
  ```
  [Relay] Channel: oauth-rollout (3 repos)
    ● ui-repo       ready (admin: atlas-7f2)
    ● backend-repo  ready (admin: atlas-3a1)
    ○ sdk-repo      booting (since 2m ago)
  Feed: 4 new entries since you were last here. Use rly status for detail.
  ```
  The `● / ○` glyphs are presentation; the canonical state string (`ready` / `booting`) is what the agent or a downstream parser reads.
- **D-04:** **Snapshot only — no diff machinery.** Hook injects current state every time. Phase 4 ships with zero "last seen" / "diff since last turn" bookkeeping. The only "since-last-time" signal is the `Feed: N new entries` count tail, which is a single integer the hook computes from `feed.jsonl` length minus a per-session `lastSeenFeedIdx` watermark (cheap to add to the existing session.json; if too complex, drop it entirely — still acceptable).
- **D-05:** **No structured diff section.** If the agent wants to know what changed, it can call MCP (`rly status --json` or equivalent) or read the feed via existing tools. Diff complexity (transition detection, double-counting risk, stale-data semantics) is explicitly out of scope. Reconsider only if Phase 4 ships and the diffless first-turn proves confusing in practice.

### State representation
- **D-06:** **Single canonical state enum, used identically across all surfaces.** The TS / Rust shared scheme:
  ```
  type RepoAdminState = "disconnected" | "booting" | "ready" | "stale"
  ```
  Mapping rules (encoded in `harness-data` as the single source of truth):
  - `disconnected` — repo is not in the channel's `repoAssignments[]`.
  - `booting` — `CrosslinkSession` exists, `pid` alive, `lastHeartbeat` fresh, **`readyAt` absent** (Phase 3's "alive but not ready" window).
  - `ready` — `CrosslinkSession.readyAt` set (Phase 3 primitive).
  - `stale` — `pid` dead OR `heartbeatAge > STALE_HEARTBEAT_MS`.
  Same word in hook output (`booting`), `rly status` (`state=booting`), TUI column (`[BOOTING]`), GUI badge (`🟡 booting`). Agents and humans learn the vocabulary once.
- **D-07:** **Muted ready, emphasized exceptions.** `ready` is the expected baseline — plain text, no color, no badge. `booting` gets a warning color/symbol (yellow ○). `stale` gets an error color/symbol (red ×). `disconnected` is dimmed/grayed. Eye is drawn to attention-needed states, not to "normal." Applies to TUI + GUI; CLI uses plain text by default and may add ANSI color via a `RLY_COLOR` env (planner's call).

### Claude's Discretion
- **Codex hook surface.** Researcher to investigate Codex's hook mechanism (the project's existing `src/crosslink/hook.ts` targets `~/.claude/settings.json` only). Decide between (a) Codex-equivalent SessionStart wrapper, (b) per-launch context injection through `rly codex` shim, or (c) ship Claude-only and document the gap. See Deferred Ideas — explicitly deferred from the user's gray-area selection.
- **`rly project show <name>` shape.** ROADMAP suggested this as a new subcommand. Given D-01 (channel IS the project), planner decides whether to (a) extend `rly status` only, (b) add `rly channel show <channelId>`, or (c) introduce `rly project show <channelId|name>` as an alias. No user preference locked.
- **`lastSeenFeedIdx` persistence shape.** D-04's "Feed: N new entries" count requires a per-session watermark. Planner decides whether this lives on the existing `CrosslinkSession` record, in a sibling file, or is dropped entirely if the cost outweighs the value.
- **State enum naming.** The four-string enum could equally be named `disconnected | starting | ready | stale` or `unlinked | onboarding | ready | dead`. Planner picks the final wording in coordination with existing convention in `src/lifecycle/session-lifecycle.ts` to avoid lexical drift.
- **TUI/GUI navigation depth + cmux pane references.** ROADMAP mentioned cmux integration so the user can jump from "agent X" → its running pane. Out of D-01's locked decision; planner decides whether cmux refs land in Phase 4 or follow-up.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase 3 readiness primitive (the contract Phase 4 consumes)
- `.planning/phases/03-repo-admin-readiness-handshake/03-SUMMARY.md` — wave-by-wave summary, phase handoff contract section. Confirms disk shape, Rust read path, channel-feed event shape.
- `.planning/phases/03-repo-admin-readiness-handshake/03-PLAN.md` — full implementation plan; cite for `CrosslinkSession.readyAt` / `readyKind` schema and `agent_ready` MCP tool semantics.
- `crates/harness-data/src/lib.rs` — `CrosslinkSession` Rust mirror + `load_crosslink_sessions()` reader. This is the single Rust read path for TUI + GUI.

### Hook infrastructure precedent
- `src/crosslink/hook.ts` — existing hook generator (`generateHookScripts()` + `buildShellScript` + `buildNodeScript`). Phase 4 should follow this pattern: emit a sibling SessionStart variant rather than build a new generator from scratch. Note: hooks live under `~/.relay/crosslink/hooks/` (legacy path retained for back-compat).
- `~/.claude/settings.json` — target file for Claude's SessionStart hook entry. The `rly install` command (`src/cli/install.ts`) is the natural place to wire the hook entry.

### Phase 1 telemetry contract (informs feed-event consumption)
- `docs/design/context-threshold-events.md` — Phase 1's threshold-event contract on `feed.jsonl`. Phase 4 reads `feed.jsonl` for the "N new entries since" count; the schemaVersion conventions there apply.

### Phase 2 handoff brief (peripheral but relevant)
- `docs/design/handoff-brief.md` — Phase 2's brief artifact layout under `~/.relay/<channelId>/handoffs/`. If Phase 4 wants to surface "unread handoff prompts" as a per-channel signal, the data source is `approvalsQueue.list()` filtered by `kind === "handoff-prompt"`.

### Project-level
- `.planning/PROJECT.md` — north star, Core Value, M01 milestone outcome.
- `.planning/REQUIREMENTS.md` — SURFACE-01 through SURFACE-07 are this phase's active REQ-IDs.
- `ROADMAP.md` § Phase 4 — original goal + open questions; some are now answered here, others still deferred.

### Codebase maps
- `.planning/codebase/ARCHITECTURE.md` — component boundaries, three-dashboard pattern.
- `.planning/codebase/INTEGRATIONS.md` — Claude/Codex adapter surfaces.
- `.planning/codebase/STRUCTURE.md` — file layout for src/, tui/, gui/, crates/.

### Channel domain
- `src/domain/channel.ts` — `Channel` interface, `repoAssignments`, `workspaceIds`, `primaryWorkspaceId`. D-01 anchors on these fields.
- `src/channels/channel-store.ts` — `ChannelStore` read/write API.
- `crates/harness-data/src/lib.rs::Channel*` — Rust mirror types.

### Session lifecycle
- `src/crosslink/store.ts` — `CrosslinkStore.discoverSessions`, `updateHeartbeat`, `updateReadiness` (Phase 3). State-derivation logic for `stale` lives here today.
- `src/lifecycle/session-lifecycle.ts` — existing session lifecycle states. Check for lexical collisions with the new four-string enum (D-06).

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`src/crosslink/hook.ts::generateHookScripts()`** — emits a shell + node hook script pair under `~/.relay/crosslink/hooks/`. Phase 4 should add a sibling generator for the SessionStart hook (e.g., `generateSessionStartHook()`) following the same shape. The existing hook is UserPromptSubmit-style (reads pending mailbox); the SessionStart hook reads current channel state + feed digest.
- **`crates/harness-data::load_crosslink_sessions()`** — Phase 3's read path. Phase 4 TUI + GUI consume through this; the `state` derivation (D-06) is the natural addition.
- **`crates/relay-paths`** — `cli_bin()` + `augmented_child_path()` hoisted in Phase 1 PR-3. Reusable when the hook shells out to `rly status --json` (if planner picks that integration path).
- **`src/cli/install.ts`** — `rly install` already writes a manifest of installed bits. Phase 4 extends it to wire the SessionStart hook entry into `~/.claude/settings.json` (idempotent, with drift detection).
- **`ChannelStore.readFeed`** — reads `feed.jsonl`. Phase 4 uses this for the "N new entries" count (D-04).

### Established Patterns
- **Three dashboards never talk to each other** — TUI, GUI, CLI all read `~/.relay/`. Phase 4 must preserve this. No in-process cache; no IPC between surfaces. The SessionStart hook is the only exception in that it writes a string into the agent's first turn — but it still reads from `~/.relay/`, not from an in-memory state.
- **Canonical disk shape with TS/Rust mirrors** — Phase 1 (`SessionBudget`), Phase 3 (`CrosslinkSession.readyAt`) both ship the TS shape with a Rust mirror. Phase 4's four-state enum (D-06) follows the pattern: define in TS (`src/domain/`), mirror in `crates/harness-data`.
- **Schema versioning + back-compat** — Phase 1's `schemaVersion: "1"` invariants and Phase 3's monotonic-once-set readiness give the precedent. The "Feed: N new entries" watermark (D-04) should be similarly back-compat — missing field treated as "first time" (N = total feed length).
- **Hook degradation** — when essential env (`RELAY_CHANNEL_ID`) is missing, hooks no-op gracefully. Phase 4 SessionStart hook must follow the same shape: if no active channel resolves (D-02), inject nothing rather than fail.

### Integration Points
- **`SessionStart` registration in `~/.claude/settings.json`** — owned by `rly install`. The drift manifest already exists (#208/#209/#210); add the SessionStart hook entry to the manifest so `rly install --check` reports drift if the user removed it manually.
- **State derivation in `harness-data`** — `load_crosslink_sessions()` returns the raw record today. Phase 4 either (a) exposes a higher-level helper `derive_state(session, now) -> RepoAdminState` in the same crate, or (b) leaves derivation to each consumer with shared constants. Planner picks; (a) is the do-the-work-once principle.
- **GUI channel-rooted view** — `gui/src/` already has channel components. Phase 4's drill-in adds a repos-and-states section under each channel card. Reuse existing channel-row primitives.
- **TUI top-level navigation** — `tui/src/main.rs` already lists channels in the sidebar. Phase 4 enriches the rendering with repo + state columns; no new top-level pane needed.
- **CLI integration via `rly status`** — `print-status-context.ts` (Phase 1 PR-4) is the model for adding channel + repo + state info to `rly status` output.

</code_context>

<specifics>
## Specific Ideas

- **Hook output sample shape** captured under D-03 — agents/planners should produce something visually close to that when the hook fires. The `●` (ready) / `○` (booting) glyph contrast is the user's chosen presentation.
- **The "stale" state** must be visibly distinct from `disconnected`. Both look "absent" but mean different things: disconnected = not configured for this channel; stale = configured + was working + now unreachable (almost certainly worth attention).
- **No "skip" option** in the gray-area selection during this discuss-phase — the user picked 3 of 4 gray areas (project entity, hook shape, state representation) and explicitly deferred Codex hook parity to the researcher. The fourth roadmap question (rly project show shape) was left to the planner.

</specifics>

<deferred>
## Deferred Ideas

These came up but belong in other phases or in the researcher/planner's discretion. Don't lose them.

- **Codex hook parity** — deferred to Phase 4 research (gsd-phase-researcher). The researcher should: (a) inspect Codex CLI's hook mechanism (if any), (b) compare to Claude's `SessionStart`, (c) propose either a Codex-equivalent wrapper or a documented gap with a follow-up phase recommendation. Block planning ONLY if Codex hooks differ so radically that the four-surface promise can't be honored without an architecture change.
- **`rly project show <name>` subcommand** — planner picks the shape. Channel-rooted view (D-01) means `<name>` is probably `<channelId>` or a channel name resolver; "project" terminology may or may not appear in the CLI surface.
- **Top-level Relay Project entity** — explicitly rejected for Phase 4 (D-01). Reconsider if/when a user holds 10+ channels that share a stable umbrella ("auth refactor Q3" containing 5 channels). Until then, channels are the unit.
- **Structured diff in hook output** — explicitly rejected for Phase 4 (D-05). The "what changed" surface lives in MCP / CLI / TUI for now. Reconsider only with shipped-product evidence.
- **cmux pane integration** — ROADMAP mentioned jumping from "agent X" → its running pane. Out of D-01's locked scope; planner decides whether cmux refs land in Phase 4 or follow-up.
- **Multi-channel hook output** — if a single cwd resolves to >1 channel (a repo in 5 channels), the hook today picks one. Multi-channel rendering is a Phase 5+ concern.
- **Worker state (Phase 5 / AL-14)** — `CrosslinkSession.readyKind: "worker"` is reserved in Phase 3's enum but no code path emits it yet. Phase 4 should be designed so adding worker rendering later is a presentation change, not a schema change.

</deferred>

---

*Phase: 4-project-readiness-surface*
*Context gathered: 2026-05-11*
