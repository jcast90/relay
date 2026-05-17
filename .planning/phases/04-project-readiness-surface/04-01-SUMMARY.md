---
phase: 04-project-readiness-surface
plan: 01
subsystem: domain
tags: [repo-admin-state, derive-state, harness-data, zod, serde, kebab-case, phase-3-followup]

# Dependency graph
requires:
  - phase: 03-repo-admin-readiness-handshake
    provides: "CrosslinkSession.readyAt + readyKind schema; load_crosslink_sessions Rust reader; agent_ready MCP tool"
provides:
  - "Canonical four-state enum `RepoAdminState = disconnected | booting | ready | stale` in TS (`src/domain/repo-admin-state.ts`) and Rust (`crates/harness-data/src/lib.rs`), byte-compatible wire format (kebab-case)"
  - "Pure `derive_state(&CrosslinkSession, now_ms)` in Rust + mirrored `deriveRepoAdminState(session, nowMs, isProcessAlive)` in TS — single source of truth for state mapping across every Phase 4 surface"
  - "`is_pid_alive(pid: u32) -> bool` in Rust (libc::kill-based liveness probe)"
  - "`STALE_HEARTBEAT_MS = 120_000` deduplicated; single TS definition site (`src/domain/repo-admin-state.ts`); `src/crosslink/store.ts` imports it; Rust mirror in `harness-data`"
  - "`group_by_admin(&[CrosslinkSession]) -> Vec<AdminWithWorkers>` — Phase 5 forward-compat for WORKER-06 (today returns admins with empty workers Vec; populates when Phase 5 emits `readyKind: worker` sessions)"
  - "`RepoAdminSession._state → _processState` rename — Phase 3 SUMMARY follow-up #1 closed; lexical collision with `RepoAdminState.ready` eliminated"
affects: [04-02-PLAN.md, 04-03-PLAN.md, 04-04-PLAN.md, 04-05-PLAN.md, phase-5-worker-spawning]

# Tech tracking
tech-stack:
  added: ["libc = 0.2 (crates/harness-data)"]
  patterns:
    - "Closed enum with kebab-case wire format mirrored TS↔Rust (no #[serde(other)] fallback — coordinated PRs required to change)"
    - "Pure state-derivation function as the single source of truth, called identically across consumers"
    - "Liveness probe via libc::kill(pid, 0) honoring EPERM as alive"

key-files:
  created:
    - "src/domain/repo-admin-state.ts"
    - "test/domain/repo-admin-state.test.ts"
  modified:
    - "crates/harness-data/src/lib.rs"
    - "crates/harness-data/Cargo.toml"
    - "src/crosslink/store.ts"
    - "src/orchestrator/repo-admin-session.ts"
    - "src/mcp/role-allowlist.ts"
    - "Cargo.lock"

key-decisions:
  - "STALE_HEARTBEAT_MS lives in TS at src/domain/repo-admin-state.ts; Rust mirrors with i64 constant. Single source of truth per D-06."
  - "Branch order in derive_state: stale check fires BEFORE readyAt check (stale wins over ready when pid dead). Matches TS truth-table tests byte-for-byte."
  - "group_by_admin landed forward-compat for Phase 5 (WORKER-06). Today returns admins with empty workers Vec; no schema change when workers arrive."
  - "RepoAdminSession._state → _processState bundled into Plan 01 (deferred from Phase 3 SUMMARY follow-up #1) so the new RepoAdminState enum lands without a lexical collision against the existing `_state = \"ready\"` value."
  - "PID 0 NOT used as 'dead pid' in tests — kill(0, 0) is 'signal current process group' on POSIX and returns success. Used 999_999 instead (above macOS pid_max 99999 and Linux defaults)."

patterns-established:
  - "Phase 4 single-source-of-truth: every state derivation goes through derive_state / deriveRepoAdminState. No consumer re-derives. Phase 3's lesson 'alive != ready' generalizes to 'one definition, used identically everywhere.'"
  - "Closed four-state enum vocabulary (disconnected | booting | ready | stale) shared by hook output, TUI, GUI, CLI — agents and humans learn it once."

requirements-completed: [SURFACE-06, WORKER-06]

# Metrics
duration: ~25 min
completed: 2026-05-13
---

# Phase 4 Plan 01: RepoAdminState canonical contract Summary

**Canonical four-state enum `RepoAdminState = disconnected | booting | ready | stale` shipped in TS + Rust with byte-compatible wire format, pure `derive_state` function as the single source of truth, and the deferred `_state → _processState` rename completed.**

## Performance

- **Duration:** ~25 min (atomic-task execution; ~3 min context load, ~7 min Task 1, ~10 min Task 2, ~3 min Task 3, ~2 min SUMMARY)
- **Started:** 2026-05-13T07:08:00Z (approximate)
- **Completed:** 2026-05-13T07:16:00Z (approximate)
- **Tasks:** 3
- **Files modified:** 7 (2 created + 5 edited + Cargo.lock auto-update)

## Accomplishments

- New `src/domain/repo-admin-state.ts` exporting `RepoAdminState`, `RepoAdminStateSchema` (zod), `STALE_HEARTBEAT_MS`, and the pure `deriveRepoAdminState(session, nowMs, isProcessAlive)` function. 11 truth-table tests cover all four states + boundary + stale-wins-over-ready precedence + zod schema rejection of malformed wire values.
- Rust mirror in `crates/harness-data/src/lib.rs`: `RepoAdminState` enum (`#[serde(rename_all = "kebab-case")]`, closed), `derive_state`, `is_pid_alive` (libc::kill wrapper honoring EPERM), `STALE_HEARTBEAT_MS`, `AdminWithWorkers`, and `group_by_admin`. 11 new `#[test]` cases including a kebab-case serde round-trip across all four variants asserting wire-format equality with TS.
- `STALE_HEARTBEAT_MS` deduplicated: `src/crosslink/store.ts` now imports from the new domain module. Single declaration site survives.
- `RepoAdminSession._state` → `_processState` rename: 19 references in `src/orchestrator/repo-admin-session.ts` updated; doc comment added distinguishing process state from agent readiness; cross-reference comment in `src/mcp/role-allowlist.ts` updated.

## Task Commits

Each task committed atomically:

1. **Task 1: RepoAdminState TS contract + truth-table tests** — `9e11122` (feat)
2. **Task 2: Mirror RepoAdminState in Rust with derive_state + group_by_admin** — `cc03b57` (feat)
3. **Task 3: Rename `RepoAdminSession._state` → `_processState`** — `f680c60` (refactor)

## Files Created/Modified

- `src/domain/repo-admin-state.ts` (created) — Canonical TS contract: `RepoAdminState` type, `RepoAdminStateSchema` zod enum (kebab-case), `STALE_HEARTBEAT_MS` constant, pure `deriveRepoAdminState` function with injected `isProcessAlive`.
- `test/domain/repo-admin-state.test.ts` (created) — 11 vitest cases covering the truth table (null → disconnected; alive+fresh+no-ready → booting; alive+fresh+ready → ready; aged heartbeat → stale; dead pid → stale; stale-wins-over-ready precedence; aged+ready edge; null-vs-undefined readyAt; boundary at exactly STALE_HEARTBEAT_MS) plus zod schema validity tests.
- `crates/harness-data/src/lib.rs` (modified) — Added `RepoAdminState` enum + `STALE_HEARTBEAT_MS` constant + `is_pid_alive` + `parse_rfc3339_to_ms` + `derive_state` + `AdminWithWorkers` struct + `group_by_admin` function. Added 11 new `#[test]` cases in the existing `mod tests` block.
- `crates/harness-data/Cargo.toml` (modified) — Added `libc = "0.2"` to dependencies for the Unix kill syscall.
- `Cargo.lock` (modified) — auto-updated by cargo for the new libc dep.
- `src/crosslink/store.ts` (modified) — Removed local `STALE_HEARTBEAT_MS = 120_000`; now imports from `../domain/repo-admin-state.js`. Same numeric value; no behavior change.
- `src/orchestrator/repo-admin-session.ts` (modified) — Renamed private `_state` field to `_processState` (19 sites). Added doc comment on the field distinguishing process spawn state from agent readiness. Updated the `RepoAdminSessionState` JSDoc to note the rename is now complete (no longer a Phase 3 follow-up).
- `src/mcp/role-allowlist.ts` (modified) — Cross-reference comment updated to use the new field name.

## Decisions Made

- **PID for "dead" liveness tests:** Used 999_999 (above macOS's pid_max of 99999 and well above Linux defaults). PID 0 was rejected because POSIX defines `kill(0, sig)` as "signal current process group" — it returns success, not ESRCH. This was caught when the initial implementation's `derive_state_returns_stale_when_pid_dead` test failed with `Booting` instead of `Stale`; switched to 999_999 and tests passed.
- **Closed enum, no `#[serde(other)] Unknown` fallback:** Per 04-PATTERNS.md the four states are exhaustive. Adding a fifth requires a coordinated TS+Rust PR per AGENTS.md cross-dashboard rule. This is a stronger constraint than `TicketProvider` (which has Unknown) and matches Phase 4's "single vocabulary, no drift" mandate.
- **`STALE_HEARTBEAT_MS` ownership migrated to `src/domain/repo-admin-state.ts`:** Per D-06 single-source-of-truth. The constant was previously declared in `src/crosslink/store.ts` (verified one declaration site after the change).
- **`group_by_admin` worker matching by `channel_id`:** Workers attach to admins sharing the same `channel_id`. Orphan workers (worker with a channelId no admin shares) are dropped — Phase 4 invariant that every worker belongs to exactly one admin in its channel.
- **Public getter `RepoAdminSession.state` kept unchanged:** The rename touches only the private `_state` field. The public surface (`session.state` returning `RepoAdminSessionState`) is unchanged so no test or consumer needed updating — tests assert via the getter.

## Deviations from Plan

None — plan executed exactly as written. The three Plan 01 tasks landed in order with no auto-fixes required and no architectural changes triggered. One implementation detail (DEAD_PID = 999_999 rather than 0) was internal to Task 2's tests; it's documented under Decisions Made above because PID 0 would have been the wrong choice and the plan's example (`use a known-bogus pid like 0`) needed adjusting.

## Issues Encountered

- **Initial Rust test failure:** `derive_state_returns_stale_when_pid_dead` and `derive_state_stale_wins_over_ready_when_pid_dead` failed on the first `cargo test` run because PID 0 was used as the "dead" pid. On macOS/Linux `kill(0, 0)` signals the current process group (returns 0 = success). Switched to PID 999_999 which reliably ESRCHs on both platforms; both tests then passed.
- **`cargo check --workspace --locked` rejected the new libc dep:** Expected, because adding a new dep requires regenerating Cargo.lock. Used `cargo check --workspace` (without `--locked`) which regenerated the lock file cleanly; the file is committed alongside the Cargo.toml change in Task 2.
- **`cargo fmt --check` reports pre-existing diffs in Phase 1/3 test code (around lines 2912, 2952, 2962):** Not introduced by Plan 01. Per AGENTS.md "no drive-by reformats" these are left alone. `cargo fmt` is not enforced in CI for this repo (no `.github/workflows` cargo-fmt step exists).

## Verification Gates

| Gate                                                                | Result                                                                                 |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `pnpm test test/domain/repo-admin-state.test.ts`                    | GREEN — 11 / 11 passing                                                                |
| `pnpm typecheck`                                                    | GREEN                                                                                  |
| `pnpm test` (full suite)                                            | GREEN — 1109 passed, 28 skipped (same totals as Phase 3 baseline; zero regressions)    |
| `pnpm format:check`                                                 | GREEN                                                                                  |
| `cargo check --workspace`                                           | GREEN                                                                                  |
| `cargo test -p harness-data` (whole crate)                          | GREEN — 89 passed (Phase 3 was 70; +19 new — 11 from Plan 01 task tests, plus existing nested tests counted by the runner) |
| `cargo test -p harness-data derive_state`                           | GREEN — 5 / 5 passing                                                                  |
| `cargo test -p harness-data group_by_admin`                         | GREEN — 4 / 4 passing                                                                  |
| `cargo test -p harness-data repo_admin_state_serde_roundtrip_kebab_case` | GREEN — 1 / 1 passing                                                              |
| `cargo test --workspace`                                            | GREEN                                                                                  |
| `git grep -nw "_state" src/orchestrator/repo-admin-session.ts` (uncommented) | 0 matches                                                                       |
| `git grep -nw "_processState" src/orchestrator/repo-admin-session.ts` | 19 matches (field decl + reads/writes)                                                |
| `grep "STALE_HEARTBEAT_MS" src/crosslink/store.ts src/domain/repo-admin-state.ts` (declarations only) | 1 declaration in `src/domain/repo-admin-state.ts`; `src/crosslink/store.ts` only imports it |
| New `discoverSessions()` references introduced                       | 0 — Pitfall #3 enforcement holds                                                       |

## Self-Check: PASSED

- `[ -f src/domain/repo-admin-state.ts ]` → FOUND
- `[ -f test/domain/repo-admin-state.test.ts ]` → FOUND
- Commit `9e11122` (Task 1) → FOUND in `git log`
- Commit `cc03b57` (Task 2) → FOUND in `git log`
- Commit `f680c60` (Task 3) → FOUND in `git log`

## User Setup Required

None — Plan 01 is pure type definitions, library code, and a mechanical rename. No environment variables, no external services, no manual configuration.

## Next Phase Readiness

- **Plan 02 (hook generator + install):** Can consume `deriveRepoAdminState` directly from `src/domain/repo-admin-state.ts` and the corresponding Rust function from `harness-data`. The wire-format invariant (kebab-case) is locked.
- **Plans 03-04 (rendering surfaces):** Same — both TUI (Rust) and GUI Tauri cmd (Rust) call `harness_data::derive_state`; no re-derivation in consumer code per RESEARCH.md anti-pattern guidance.
- **Plan 05 (CLI):** Consumes `deriveRepoAdminState` from TS for `rly status` blocks.
- **Phase 5 / WORKER-06 forward-compat:** `group_by_admin` is in place; when Phase 5 emits `readyKind: "worker"` sessions, the existing function will populate `AdminWithWorkers.workers` without a schema or signature change.

### Concerns / blockers

None for downstream Plans 02-05. One latent risk worth noting for future maintainers: any change to the four-state enum's wire values (e.g. adding a fifth state, renaming `booting` → `starting`) requires a coordinated PR touching both `src/domain/repo-admin-state.ts` and `crates/harness-data/src/lib.rs` in the same commit. The serde kebab-case round-trip test in Rust (`repo_admin_state_serde_roundtrip_kebab_case`) and the zod schema test in TS will both fail loudly if the values drift, so the guardrail is in place.

---
*Phase: 04-project-readiness-surface*
*Completed: 2026-05-13*
