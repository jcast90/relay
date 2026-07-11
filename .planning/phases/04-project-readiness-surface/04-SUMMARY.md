---
phase: 04-project-readiness-surface
status: shipped (manual smoke pending user verification)
shipped: 2026-05-13
plans: 5
commits: 36
loc: +6230 / -58 across 42 files
requirements_covered: [SURFACE-01, SURFACE-02, SURFACE-03, SURFACE-04, SURFACE-05, SURFACE-06, SURFACE-07, WORKER-06]
---

# Phase 4 Summary — Project Readiness Surface

**Phase goal (from ROADMAP).** Give the user a single, honest view per channel of which repos are connected, which repo-admin sessions are alive vs ready (per Phase 3), and what's flowing on the channel feed — visible at four surfaces the user already touches: in-session hook (Claude + Codex), TUI, GUI, and CLI. All four read the same state from `~/.relay/`, no separate APIs, no drift.

**Status.** All 5 plans executed; all 8 phase REQ-IDs covered; automated test suite GREEN (TS 1188 pass / 28 skipped / 0 failed; Rust 150+ pass / 0 failed). The Plan 05 manual smoke checkpoint (live TUI + GUI + Claude session end-to-end) is deferred to user verification against the PR branch — automated tests prove correctness of every individual surface, but visual confirmation of glyphs/colors and the live hook injection are owner-verified.

---

## Wave-by-wave PR boundaries

| Wave | Plan | What it built | Commits |
|------|------|---------------|---------|
| 1 | 04-01 (state contract) | `RepoAdminState` TS+Rust mirror (`disconnected \| booting \| ready \| stale`), `derive_state(&CrosslinkSession, now) -> RepoAdminState` in `harness-data`, `group_by_admin` + `AdminWithWorkers` (WORKER-06 forward-compat), bundled `_state → _processState` rename closing Phase 3 follow-up #1. | 9 |
| 2 | 04-02 (hook + watermark) | `formatSessionStartContext` pure formatter, `generateSessionStartHookScripts` (sibling to `generateHookScripts`), `lastSeenFeedIdx` optional watermark on `CrosslinkSession` (TS + Rust mirror), `CrosslinkStore.advanceFeedWatermark` (atomic, monotonic), `Feed:` tail gated on real session record. | 8 |
| 2 | 04-04 (TUI + GUI) | TUI per-repo state column via `HashMap<ChannelId, Vec<AdminWithWorkers>>` cache (WORKER-06 forward-compat — workers nest under admin), `state_visual()` pure helper with all-4-variants unit test, GUI Tauri commands `load_repo_admin_states` + `load_channel_admins_grouped`, React state-badge row in `ChannelHeader.tsx` + D-07 CSS classes. | 7 |
| 3 | 04-03 (install integration) | `rly install` writes SessionStart hooks into BOTH `~/.claude/settings.json` AND `~/.codex/hooks.json` (idempotent JSON merge, atomic rename), `ensureCodexFeatureFlag` for `[features].hooks = true` in `~/.codex/config.toml` (comment-preserving via `@iarna/toml`), manifest extended with optional `hooks` block + drift detection; Codex version probe fail-soft. | 7 |
| 4 | 04-05 (CLI + SUMMARY) | `rly status` Channels block via `formatChannelStatesBlock` + `loadChannelStates`, new `rly channel show <id\|name>` subcommand, `rly project show <id\|name>` alias dispatch-equivalence (unit-level assertion, no `.skip`/`.todo` allowed). | 5 |

Plus one post-merge integration fix (`fix(04): derive Serialize/Deserialize on AdminWithWorkers for Tauri IPC`) — exactly the kind of cross-plan bug the post-merge gate catches.

---

## Verification gates (all GREEN)

| Gate | Result |
|------|--------|
| `pnpm typecheck` | GREEN |
| `pnpm test` | 1188 passed / 28 skipped / 0 failed (Phase 3 baseline 1109 → +79 new) |
| `pnpm format:check` | GREEN |
| `pnpm build` | GREEN |
| `cargo check --workspace` | GREEN |
| `cargo test --workspace` | 91 (harness-data) + 53 + ... = 150+ passed / 0 failed |
| `grep -rn "discoverSessions\|discover_sessions" src/cli/ tui/ gui/src-tauri/ src/crosslink/hook.ts` (excluding comments) | 0 — Pitfall #3 holds system-wide |
| `grep -E "(it\|test)\.(skip\|todo)" test/cli/channel-show.test.ts` | 0 — alias-equivalence assertion non-skippable |
| Behavioral equivalence: generated `.mjs` formatter vs TS `deriveRepoAdminState` (4-state truth-table) | Equal across all variants |
| Hook end-to-end render budget | 32ms (Pitfall #6 target < 100ms) |
| `Feed:` tail OMITTED when `RELAY_SESSION_ID` unset | Verified by test |

---

## Decisions made (planner-discretion items, RESOLVED in `04-RESEARCH.md`)

1. **Codex install version probe** — Fail-soft: probe via `spawnSync("codex", ["--version"], { timeout: 2000 })`; on `<v0.130` or `ENOENT`, log one-line friendly note and write the hook config anyway. Activates automatically on user upgrade.
2. **`rly project show` shape** — Shipped BOTH `rly channel show <id|name>` (canonical per D-01) AND `rly project show <id|name>` as alias dispatching to the same handler. `rly status` also gets a channel-roll-up block.
3. **`_state → _processState` rename** — Bundled into Wave 1 / Plan 01 Task 3. Mechanical (~50 LOC). Resolves Phase 3 follow-up #1 and removes lexical collision with `RepoAdminState.ready`.
4. **`lastSeenFeedIdx` watermark** — IN. Optional field on `CrosslinkSession` with `#[serde(default, skip_serializing_if = "Option::is_none")]` + `.optional()` zod. `Feed:` tail gated on real session record (omitted for user-launched non-Relay sessions).
5. **cmux pane integration** — Deferred (see follow-ups).

---

## Phase 5 handoff contract

Phase 4 keeps the four surfaces honest for **today's** session model (admins only). Phase 5 introduces worker sessions (`AL-14 — spawn_worker`, `CrosslinkSession.readyKind: "worker"`). The forward-compat hooks Phase 4 ships:

- **`group_by_admin` and `AdminWithWorkers`** already group sessions by `parentAdminId` (today: workers Vec is empty, admins surface alone). When Phase 5 writes a session with `readyKind: "worker"` and a `parentAdminId` pointing to an admin, the function nests it without any code change.
- **TUI cache** is `HashMap<ChannelId, Vec<AdminWithWorkers>>`. The sidebar renderer iterates `admin → admin.workers`. Empty Vec today.
- **GUI `load_channel_admins_grouped`** Tauri command returns the same shape. The React side iterates the same way.
- **Hook output** lists per-repo state (one line per repo). When workers exist, the renderer can decide to indent or list them under the admin — this is a presentation-layer change, not a schema change.

**Phase 5 should NOT need to touch** any Phase 4 file to render workers. If it does, the WORKER-06 forward-compat contract failed and we should investigate.

---

## Known follow-ups

1. **Manual smoke checkpoint (Plan 05 Task 3)** — Deferred to user verification on the PR branch. Run the 7-step smoke checklist (CLI roll-up → TUI render → GUI badge → hook injection with Claude → cwd-fallback path → state transitions → stale flip). Captured in `04-05-PLAN.md` Task 3.
2. **cmux pane integration (Claude's Discretion #6)** — Deferred. The "jump from agent X to its running pane" feature requires a single-line "open external app" call that can land in a follow-up PR without touching any Phase 4 contract.
3. **TOML comment loss in `[features]`** (info-level checker finding #9 from plan review) — `@iarna/toml` round-trip silently drops in-block comments. Risk is small (most users don't comment `[features]`). Investigate `toml-edit` Rust subprocess or skip-write-when-flag-matches as a follow-up.
4. **Legacy GUI reader bug from Phase 3 SUMMARY #2** — Carried forward; not addressed in Phase 4.
5. **04-04 worktree-base mismatch retro** — During execution, the Wave 2 04-04 worktree forked from `origin/main` rather than the post-Wave-1 phase branch HEAD. The executor re-implemented Wave 1's harness-data primitives in commit `f632c7e` and the orchestrator resolved by cherry-picking the 4 non-duplicate commits onto phase branch. Wave 3 + Wave 4 used a strengthened `<wave_base_sync>` prompt that explicitly instructs the executor to `git merge feat/phase-04-project-readiness-surface` first — both subsequent waves landed cleanly without re-implementation. Future phase-execute runs should bake `<wave_base_sync>` into the default prompt or fix the worktree forking strategy upstream.
6. **`AdminWithWorkers` Serialize/Deserialize** — Was needed for Tauri IPC but plan 04-01 only declared `Debug, Clone`. Caught by post-merge gate, fixed by single-line commit `2f6d6fc`. Document the cross-plan IPC requirement in the planner's deep-work rules.

---

## Requirements coverage (REQUIREMENTS.md)

| REQ-ID | Title | Plan(s) | Status |
|--------|-------|---------|--------|
| SURFACE-01 | Claude SessionStart hook injects current project state | 04-02, 04-03 | Shipped (smoke deferred) |
| SURFACE-02 | Codex SessionStart parity or documented gap | 04-03 | Shipped — parity achieved (Codex CLI ≥ v0.130) |
| SURFACE-03 | TUI project-rooted view | 04-04 | Shipped |
| SURFACE-04 | GUI matching project-rooted view (with optional cmux refs) | 04-04 | Shipped (cmux refs deferred) |
| SURFACE-05 | `rly status` + `rly project show <name>` | 04-05 | Shipped (canonical = `rly channel show`, alias = `rly project show`) |
| SURFACE-06 | Four states unambiguous across surfaces | 04-01, 04-04, 04-05 | Shipped (truth-table tests + state vocabulary parity + D-07 visuals) |
| SURFACE-07 | No in-process cache; reopening shows same state | 04-03, 04-04, 04-05 | Shipped (per-tick reload; grep-test asserts `discoverSessions` absence) |
| WORKER-06 | Phase 4 surfaces render workers under spawning admin without code changes | 04-01, 04-04 | Shipped (forward-compat — `group_by_admin` + `AdminWithWorkers`) |

---

## Files created / modified

### New files (37)
- `src/domain/repo-admin-state.ts` (+86)
- `src/crosslink/session-start-hook-content.ts` (+168)
- `src/install/codex-toml.ts` (+148)
- `src/cli/channel-show.ts` (+434)
- `gui/src-tauri/src/lib.rs` (+70 lines added — Tauri commands)
- `gui/src/api.ts`, `gui/src/types.ts`, `gui/src/components/ChannelHeader.tsx` (+ test), `gui/src/styles.css` — GUI surface
- `crates/harness-data/src/lib.rs` (+436 — derive_state, group_by_admin, AdminWithWorkers, watermark mirror)
- `tui/src/main.rs` (+31), `tui/src/ui.rs` (+114)
- Tests: `test/domain/repo-admin-state.test.ts`, `test/crosslink/*` (3 files), `test/install/*` (3 files), `test/cli/*` (2 files)
- `.planning/phases/04-project-readiness-surface/04-*-SUMMARY.md` (5 plan summaries + this phase summary)

### Modified files (5)
- `src/crosslink/hook.ts` (+`generateSessionStartHookScripts`)
- `src/crosslink/store.ts` (+`advanceFeedWatermark`; imports `STALE_HEARTBEAT_MS` from `repo-admin-state.ts`)
- `src/crosslink/types.ts` (+`lastSeenFeedIdx`)
- `src/install/manifest.ts` (+`hooks` block + helpers)
- `src/install/installer.ts` (+`installSessionStartHooks`)
- `src/cli/install.ts` (wire hook install + `--check` drift)
- `src/cli/print-status-context.ts` (+`formatChannelStatesBlock` + `loadChannelStates`)
- `src/index.ts` (+`channel show` + `project show` alias dispatch)
- `src/orchestrator/repo-admin-session.ts` (`_state → _processState` rename)
- `package.json` + `pnpm-lock.yaml` (+`@iarna/toml` runtime dep)

---

*Phase 4 closes M01's "make the delegation tree observable" thread for the read-side. The remaining M01 phase (Phase 5 — `spawn_worker`) lands the dispatch-side missing depth tier; Phase 4's surfaces are designed to render Phase 5's output without code changes.*

*Phase: 04-project-readiness-surface*
*Shipped: 2026-05-13*
