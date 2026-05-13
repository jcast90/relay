---
phase: 04-project-readiness-surface
plan: 04
subsystem: surfaces
tags: [tui, gui, tauri, state-derivation, surface-03, surface-04, worker-06]

requirements:
  - SURFACE-03
  - SURFACE-04
  - SURFACE-06
  - SURFACE-07
  - WORKER-06

dependency-graph:
  requires:
    - "crates/harness-data: CrosslinkSession + load_crosslink_sessions (Phase 3)"
    - "Channel.repoAssignments[] (existing — alias + repo_path are the join keys)"
  provides:
    - "harness_data::derive_state(&CrosslinkSession, now_ms) -> RepoAdminState — single source of truth for state derivation across all surfaces"
    - "harness_data::group_by_admin(&[CrosslinkSession]) -> Vec<AdminWithWorkers> — forward-compat grouping for Phase 5 / WORKER-06"
    - "harness_data::is_pid_alive(u32) -> bool — pid-alive check via libc::kill(pid, 0) on Unix"
    - "Tauri commands load_repo_admin_states + load_channel_admins_grouped — surface the same Rust derivation to the GUI frontend"
    - "TUI sidebar state column — admin → workers nested rendering"
    - "GUI ChannelHeader repo-state-stack — one badge per repo with D-07 color mapping"
  affects:
    - "Plan 04-02 (hook) will consume harness_data::derive_state — primitives now exist"
    - "Plan 04-03 (CLI rly status) will consume harness_data::derive_state — same path"
    - "Phase 5 (WORKER-06) renders workers under their spawning admin with zero rendering-layer code change in TUI + GUI"

tech-stack:
  added:
    - "libc 0.2 (target.'cfg(unix)' dep on harness-data) — kill(pid, 0) syscall"
  patterns:
    - "Pure state-derivation function in harness-data (single source of truth — Pattern 1 from 04-RESEARCH.md)"
    - "Cache SESSIONS, not pre-computed states (SURFACE-07 — disk re-read every tick; state computed at render time)"
    - "Forward-compat grouping (Phase 5 worker rendering becomes free)"

key-files:
  created:
    - ".planning/phases/04-project-readiness-surface/04-04-SUMMARY.md (this file)"
    - "gui/src/components/ChannelHeader.test.tsx (3 vitest cases)"
  modified:
    - "crates/harness-data/Cargo.toml (libc target dep)"
    - "crates/harness-data/src/lib.rs (RepoAdminState, derive_state, is_pid_alive, group_by_admin, AdminWithWorkers, STALE_HEARTBEAT_MS + 9 tests)"
    - "tui/src/main.rs (App.admins_by_channel cache + refresh wiring)"
    - "tui/src/ui.rs (state_visual pure helper + sidebar render iterating admin→workers)"
    - "gui/src-tauri/src/lib.rs (load_repo_admin_states + load_channel_admins_grouped Tauri commands)"
    - "gui/src/api.ts (loadRepoAdminStates + loadChannelAdminsGrouped shims)"
    - "gui/src/types.ts (RepoAdminState, CrosslinkSession, AdminWithWorkers)"
    - "gui/src/components/ChannelHeader.tsx (repo-state-stack row + 5s polling effect)"
    - "gui/src/styles.css (.repo-state-stack + .state-{ready,booting,stale,disconnected})"

decisions:
  - "Land plan 01 primitives as a Rule 3 blocking fix (RepoAdminState / derive_state / group_by_admin / AdminWithWorkers / is_pid_alive / STALE_HEARTBEAT_MS in crates/harness-data). The plan-04 dispatch brief assumed Wave 1 had shipped; it had not. Plan 04 strictly consumes these symbols. TS-side mirror (Plan 01 Tasks 1 & 3 — TS schema + _processState rename) deliberately left out of scope for this plan."
  - "libc 0.2 added as a target.'cfg(unix)' dep instead of nix — libc was already transitively in Cargo.lock, so adding it as a direct dep cost zero new crates. Non-Unix returns false defensively so derive_state maps to Stale (no Windows TUI ships today)."
  - "state_visual lives in tui/src/ui.rs as a pub(crate) free function, NOT in harness-data. Visual mapping is presentation-layer per surface (ratatui Color is a TUI concept; GUI uses CSS classes); only the state→word mapping is canonical and that's covered by RepoAdminState's serde kebab-case derive."
  - "Cache shape is HashMap<ChannelId, Vec<AdminWithWorkers>> (NOT a flat Vec<(Alias, RepoAdminState)>). Phase 5 WORKER-06 forward-compat is structural — when worker sessions appear on disk, group_by_admin nests them under the matching admin automatically and the renderer iterates them with no code change."
  - "GUI ChannelHeader polls every 5000ms to match App.tsx's refresh interval — all surfaces tick in lockstep. State is re-derived backend-side every call (SURFACE-07: no frontend cache)."
  - "RepoChipRow.tsx (option a in plan) deferred: kept the diff minimal by adding badges only to ChannelHeader. Plan called this acceptable — RepoChipRow integration is a nice-to-have visual flourish that can land separately if the user requests it."

metrics:
  duration_minutes: 35
  tasks_completed: 4   # Task 0 (Rule 3) + Task 1 (TUI) + Task 2 (Tauri) + Task 3 (frontend)
  files_created: 2
  files_modified: 9
  tests_added:
    - "harness-data: 9 new Rust tests (derive_state 4-way truth table + serde round-trip + group_by_admin 3 cases + is_pid_alive 2 sanity checks)"
    - "relay-tui: 1 new Rust test (state_visual all-4-variants)"
    - "GUI: 3 new vitest cases (ChannelHeader badge rendering)"
  total_tests_added: 13
  completed_date: "2026-05-13"
---

# Phase 4 Plan 04: TUI + GUI state rendering Summary

Surfaces the canonical four-state repo-admin vocabulary (`disconnected | booting | ready | stale`) into the TUI sidebar and the GUI ChannelHeader. Both render via the same Rust `harness_data::derive_state` — single source of truth across surfaces (D-06). Forward-compat grouping ships for Phase 5 / WORKER-06: workers nest under their spawning admin without any renderer change when worker sessions start appearing on disk.

## What Shipped

### Task 0 — Rule 3 blocking fix: land plan-01 primitives in harness-data

The dispatch brief assumed Wave 1 (plan 04-01) had landed and that `harness_data::derive_state`, `group_by_admin`, `AdminWithWorkers`, `is_pid_alive`, and `RepoAdminState` already existed. They did not. Plan 04 strictly consumes them, so they were added as a Rule 3 blocking fix:

- `pub enum RepoAdminState { Disconnected, Booting, Ready, Stale }` with `#[serde(rename_all = "kebab-case")]`.
- `pub const STALE_HEARTBEAT_MS: i64 = 120_000` (mirrors TS).
- `pub fn is_pid_alive(pid: u32) -> bool` — Unix-only `libc::kill(pid, 0)` with EPERM-means-alive semantics; defensive `false` on non-Unix.
- `pub fn derive_state(&CrosslinkSession, now_ms: i64) -> RepoAdminState` — pure function. Branch order: not-alive OR aged-heartbeat → Stale; `ready_at.is_some()` → Ready; else Booting. Disconnected is decided at the channel layer (no matching session).
- `pub struct AdminWithWorkers { admin, workers }` + `pub fn group_by_admin(&[CrosslinkSession]) -> Vec<AdminWithWorkers>` — sessions with `ready_kind == "worker"` nest under the admin sharing the same `channel_id`; pre-Phase-3 sessions (no `ready_kind`) default to admin.

**9 Rust tests** added: 4 `derive_state` truth-table cases, kebab-case serde round-trip, 3 grouping cases, 2 `is_pid_alive` sanity checks. **All passing.** `libc 0.2` added as a target.'cfg(unix)' dep on harness-data (already transitively in `Cargo.lock`, zero new crates fetched).

**Commit:** `f632c7e`

### Task 1 — TUI sidebar state column (SURFACE-03)

- New `App.admins_by_channel: HashMap<String, Vec<AdminWithWorkers>>` field, populated in `refresh()` by calling `harness_data::load_crosslink_sessions` once per tick, filtering per channel, and calling `group_by_admin`. Cache stores SESSIONS (not pre-computed states) so state is fresh at render time — SURFACE-07 satisfied.
- New `pub(crate) fn state_visual(state) -> (char, Color, &'static str)` pure helper in `ui.rs` extracting the D-07 visual mapping: `ready=DarkGray ●` (muted), `booting=Yellow ○`, `stale=Red ×`, `disconnected=DarkGray ·` (dim). Word component matches kebab-case wire format byte-for-byte.
- New `state_visual_covers_all_four_variants` unit test asserts the mapping for all 4 variants (REQUIRED acceptance criterion).
- `draw_sidebar` extended: after each repo agent line, render an indented state line sourced from `derive_state`. Workers nest under each admin (further indent); today's workers Vec is always empty, but the iteration is in place — when Phase 5 emits `ready_kind: "worker"` sessions they render automatically. Repo assignments with no matching admin session → Disconnected.

**Commit:** `e83a506`

### Task 2 — GUI Tauri commands (SURFACE-04 backend)

- `load_repo_admin_states(channel_id) -> Vec<(String, RepoAdminState)>` — iterates `channel.repo_assignments`, matches each to a non-worker CrosslinkSession by `repo_path`, calls `derive_state` per match (Disconnected on miss).
- `load_channel_admins_grouped(channel_id) -> Vec<AdminWithWorkers>` — forward-compat: frontends can render the nested structure now; Phase 5 fills the workers list.
- Both registered in `tauri::generate_handler!`. Code comment near both commands flags the legacy `~/.relay/crosslink/sessions/` SIGTERM-matching bug as out-of-scope (Phase 3 SUMMARY follow-up #2).

**Commit:** `04a38dc`

### Task 3 — GUI frontend state-badge row (SURFACE-04 frontend)

- `types.ts`: `RepoAdminState` string union, `CrosslinkSession` interface, `AdminWithWorkers` interface — all mirroring Rust kebab-case serde output byte-for-byte.
- `api.ts`: `api.loadRepoAdminStates` + `api.loadChannelAdminsGrouped` invoke shims.
- `ChannelHeader.tsx`: new `repo-state-stack` row beneath the existing `agent-stack`. One `.repo-state-badge.state-<state>` span per repo, sourced from a 5000ms-interval `useEffect` that polls `loadRepoAdminStates`. Empty list hides the entire stack (no empty flex container). Polling matches App.tsx's interval so all surfaces tick in lockstep.
- `styles.css`: four state classes wired to Tidewater design tokens:
  - `.state-ready` → muted (`--color-text-on-dark-muted`)
  - `.state-booting` → amber background + border (`--color-accent-amber`)
  - `.state-stale` → red background + border (`--color-status-failed`)
  - `.state-disconnected` → dim (`--color-text-on-dark-muted` at 55% opacity)
- 3 new vitest cases in `ChannelHeader.test.tsx`: one badge per repo with correct `state-*` class; hidden stack on `[]`; all four state classes rendered for the four wire-format strings.

**Commit:** `fc7ca8f`

## Architectural Invariants Preserved

| Invariant | Verification |
|-----------|--------------|
| Single source of truth for state derivation | `derive_state` is the only place state is computed. TUI + GUI both call into it. |
| Three dashboards never talk to each other | Each surface reads `~/.relay/` independently. TUI polls disk every 3s; GUI polls every 5s via Tauri command that reads disk. No IPC. |
| No in-process cache of derived state (SURFACE-07) | TUI caches sessions (not states); state computed in renderer per tick. GUI backend re-reads disk per Tauri call. |
| WORKER-06 forward-compat | Cache shape is `HashMap<ChannelId, Vec<AdminWithWorkers>>`. Renderer iterates `admin → workers`. Phase 5 fills workers list with zero code change here. |
| No `discoverSessions` import (Pitfall #3) | `grep -rn "discover_sessions\|discoverSessions" tui/ gui/src-tauri/` returns 0 matches. |

## Verification Gates

| Gate | Result |
|------|--------|
| `cargo test -p harness-data --lib` | 88 passed (was 79; +9 new) |
| `cargo test -p relay-tui` | 2 passed (was 1; +1 new — state_visual) |
| `cargo test --workspace --locked` | 147 passed, 0 failed across all crates |
| `cargo check --workspace --locked` | GREEN |
| `cd gui && pnpm test` | 53 passed (was 50; +3 new — ChannelHeader) |
| `cd gui && pnpm build` (tsc + vite) | GREEN |
| `grep -rn "discover_sessions\|discoverSessions" tui/ gui/src-tauri/` | 0 matches |
| TUI cache shape `HashMap<.*Vec<.*AdminWithWorkers>>` | 1 match in `tui/src/main.rs` |
| `state_visual` pure free function | 1 declaration in `tui/src/ui.rs`, signature `(RepoAdminState) -> (char, Color, &'static str)` |
| GUI command count delta | +2 `#[tauri::command]` registrations |
| CSS state classes | 4 `.state-{ready,booting,stale,disconnected}` rules |

## Deviations from Plan

### Rule 3 — Blocking issue (auto-fixed)

**1. [Rule 3 - Blocking] Plan 04-01 primitives missing — landed inline**
- **Found during:** Initial context load — the plan brief said "Wave 1 already exists" but `grep -n "fn derive_state\|fn group_by_admin\|pub enum RepoAdminState" crates/harness-data/src/lib.rs` returned zero matches.
- **Issue:** Plan 04-04 strictly consumes `harness_data::derive_state`, `group_by_admin`, `AdminWithWorkers`, `is_pid_alive`, `RepoAdminState`, `STALE_HEARTBEAT_MS`. Without them, Tasks 1-3 cannot compile.
- **Fix:** Added all six primitives + 9 unit tests as Task 0, committed before Task 1. TS-side parity (Plan 01 Tasks 1 & 3 — TS schema + `_processState` rename) deliberately left out of scope; that is a separate executor's responsibility and not on plan 04-04's dependency chain.
- **Files modified:** `crates/harness-data/Cargo.toml`, `crates/harness-data/src/lib.rs`, `Cargo.lock`
- **Commit:** `f632c7e`

### Scope adjustments (within plan)

**2. [Plan choice - documented] RepoChipRow.tsx integration deferred (option b)**
- **Plan instruction:** "Recommend (a) — minimal change, visually integrated. If the prop drilling becomes ugly, fall back to (b) and document the choice in the SUMMARY."
- **Choice:** (b) — kept the diff bounded to ChannelHeader. RepoChipRow already shows alias chips for the same repos; adding parallel state-fetch there would duplicate the polling loop and require prop-drilling `repoStates` through component boundaries that are otherwise stable. The ChannelHeader badge row carries the visual signal alongside the chips visually adjacent in the header row.
- **Impact:** None — the plan explicitly allowed this choice.

### Authentication gates encountered

None. No subprocess auth or external service calls during execution.

## Known Stubs

None. The implementation is end-to-end live: refresh-tick → disk read → `group_by_admin` → `derive_state` → rendered badge. No mock data sources, no `=[]` placeholders flowing to UI.

## Phase 4 Open Items After This Plan

| Item | Owner |
|------|-------|
| Plan 04-01 TS parity (`src/domain/repo-admin-state.ts` zod schema, `STALE_HEARTBEAT_MS` dedup, `_state → _processState` rename) | Separate executor — plan 04-01 still needs to land for hook (plan 04-02) consumption |
| Plan 04-02: SessionStart hook generator | Wave 3 |
| Plan 04-03: `rly status` channel block + `rly channel show <id>` | Wave 4 |
| Plan 04-05: manual smoke + Phase SUMMARY | Wave 5 |
| Legacy `~/.relay/crosslink/sessions/` SIGTERM path bug | Phase 3 SUMMARY follow-up #2 — separate plan |

## Self-Check: PASSED

**Files verified to exist:**
- `crates/harness-data/src/lib.rs` (modified) — FOUND
- `crates/harness-data/Cargo.toml` (modified) — FOUND
- `tui/src/main.rs` (modified) — FOUND
- `tui/src/ui.rs` (modified) — FOUND
- `gui/src-tauri/src/lib.rs` (modified) — FOUND
- `gui/src/api.ts` (modified) — FOUND
- `gui/src/types.ts` (modified) — FOUND
- `gui/src/components/ChannelHeader.tsx` (modified) — FOUND
- `gui/src/components/ChannelHeader.test.tsx` (created) — FOUND
- `gui/src/styles.css` (modified) — FOUND
- `.planning/phases/04-project-readiness-surface/04-04-SUMMARY.md` (this file) — FOUND

**Commits verified to exist:**
- `f632c7e` (Task 0 — harness-data primitives) — FOUND
- `e83a506` (Task 1 — TUI sidebar) — FOUND
- `04a38dc` (Task 2 — Tauri commands) — FOUND
- `fc7ca8f` (Task 3 — GUI frontend) — FOUND

All claims verified against disk and git log.
