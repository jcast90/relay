---
phase: 04-project-readiness-surface
plan: 02
subsystem: crosslink-hook
tags: [session-start-hook, formatter, watermark, schema-additive, prompt-injection-mitigation]

# Dependency graph
requires:
  - phase: 04-project-readiness-surface
    plan: 01
    provides: "RepoAdminState enum + deriveRepoAdminState (TS) + STALE_HEARTBEAT_MS"
provides:
  - "`formatSessionStartContext` pure formatter at `src/crosslink/session-start-hook-content.ts` — deterministic ~5-15 line text block matching D-03; no IO, no Date.now."
  - "`generateSessionStartHookScripts()` at `src/crosslink/hook.ts` — emits `~/.relay/crosslink/hooks/session-start.{sh,mjs}` (chmod 755 wrapper) following the same shape as `generateHookScripts` for UserPromptSubmit."
  - "Generated `.mjs` SessionStart hook script: resolves active channel via `RELAY_CHANNEL_ID` env or cwd-prefix reverse lookup (D-02), reads raw `~/.relay/crosslink-session/*.json` (never `discoverSessions`), inlines `deriveRepoAdminState` + the formatter byte-for-byte, prints plain stdout, exits 0 on every path."
  - "`Feed: N new entries` tail gated on `RELAY_SESSION_ID` resolving to a real CrosslinkSession — user-launched sessions correctly omit the tail."
  - "`CrosslinkSession.lastSeenFeedIdx?: number` (TS) + `last_seen_feed_idx: Option<u64>` (Rust) — additive optional field, back-compat preserved."
  - "`CrosslinkStore.advanceFeedWatermark(sessionId, idx)` — monotonic, idempotent, atomic-rename. Returns `null` for unknown sessions."
  - "`getClaudeSessionStartHookConfig(shellScriptPath)` exported for Plan 03 install wiring."
affects: [04-03-PLAN.md, 04-04-PLAN.md, 04-05-PLAN.md]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "String-template node script generator with inlined formatter + state derivation — single source of truth in TS, byte-equivalent inlined mirror verified by a behavioral-equivalence test against the 4-state truth-table fixture from plan 01."
    - "Hook output as plain stdout (no ANSI / no JSON wrapper) — works for both Claude SessionStart and Codex SessionStart per RESEARCH Pattern 3."
    - "Graceful no-op everywhere — every failure path exits 0 with empty stdout (Pitfall #2); the hook never blocks session start."
    - "Channel-scoped session read (Pitfall #6 < 100ms budget; measured 32ms in end-to-end test) — filter sessions to the resolved channel before iterating; never enumerate the full set."
    - "Feed-tail gating on RELAY_SESSION_ID — honest behavior (no noisy `Feed: N` for non-Relay-spawned sessions) vs every-start emission."

key-files:
  created:
    - "src/crosslink/session-start-hook-content.ts"
    - "test/crosslink/session-start-hook-content.test.ts"
    - "test/crosslink/session-start-hook.test.ts"
    - "test/crosslink/channel-store-watermark.test.ts"
  modified:
    - "src/crosslink/hook.ts"
    - "src/crosslink/types.ts"
    - "src/crosslink/store.ts"
    - "crates/harness-data/src/lib.rs"

key-decisions:
  - "Inlined .mjs derivation + formatter rather than bundling — keeps the script self-contained (no module-resolution at runtime). Drift is guarded by the behavioral-equivalence test (`generated_mjs_formatter_matches_TS_deriveRepoAdminState_for_all_4_states`) and the literal-`STALE_HEARTBEAT_MS = 120_000` grep test."
  - "Feed: tail gated on `RELAY_SESSION_ID` matching a real session record (NOT on bare env presence) — user-launched sessions omit the tail entirely rather than emit `Feed: <total>` every start. Honest behavior vs noisy default."
  - "Empty-list contract for the formatter mirrors `formatActiveSessionsBlock` (src/cli/print-status-context.ts:26-44) — `repoStates.length === 0` returns `\"\"` so callers can append-then-skip-on-empty without an extra length check."
  - "`advanceFeedWatermark` does NOT touch `lastHeartbeat` (contrast with `updateReadiness`, which does) — the watermark is a presentation-layer signal, not session liveness. A no-op call when at or behind the high-water mark returns `{ ok: false, idx: current }` so the caller still observes the actual watermark."
  - "Hook output uses factual / declarative phrasing only — test 7 in the formatter asserts the output never contains `MUST`, `ATTENTION`, or `do not` (case-insensitive). Mitigates T-04-04 prompt-injection-via-hook-output."

patterns-established:
  - "SessionStart hooks emit plain UTF-8 stdout with state-word vocabulary (`disconnected | booting | ready | stale`) that matches the canonical RepoAdminState enum byte-for-byte — agents and downstream parsers read one shared vocabulary."
  - "Hook script body has three guardrail tests at the template level: (a) all four state strings present, (b) STALE_HEARTBEAT_MS literal present, (c) `discoverSessions` is NOT referenced. Any future drift in the inlined logic is caught at test time, not at runtime."
  - "Additive optional field shipped in TS schema + Rust mirror in the same plan with serde-default + skip-serializing-if-none — same shape Phase 3 used for `readyAt`/`readyKind`. Back-compat verified by a dedicated test that asserts the serialized output does NOT contain the field when the value is `None`."

requirements-completed: [SURFACE-01]

# Metrics
duration: ~13 min
completed: 2026-05-13
---

# Phase 4 Plan 02: SessionStart hook generator + Feed-watermark Summary

**Generated SessionStart hook script (TS + inlined node template), pure formatter for its stdout, and the `lastSeenFeedIdx` watermark plumbing in both TS schema and Rust mirror — the agent-visible surface of Phase 4 is live.**

## Performance

- **Duration:** ~13 minutes (atomic-task execution; ~3 min context load + plan-01 merge, ~3 min Task 1, ~5 min Task 2, ~2 min Task 3)
- **Started:** 2026-05-13T14:19:49Z
- **Completed:** 2026-05-13T14:33:24Z
- **Tasks:** 3
- **Files modified:** 8 (4 created + 4 modified)
- **End-to-end hook render time (informational, Pitfall #6 budget < 100ms):** 32ms in the 3-repo fixture

## Accomplishments

- New `src/crosslink/session-start-hook-content.ts` with `formatSessionStartContext`, `glyphFor`, `detailFor` — pure functions (no IO, no Date.now()) producing the D-03 sample shape. 9 vitest cases cover the empty contract, mixed 3-repo header + rows, feed-tail gating (present/absent for 0/undefined/positive), booting relative-time buckets (`Ns`/`Nm`/`Nh`), stale glyph + state word, glyph-per-state map, and prompt-injection guard (no MUST/ATTENTION/do-not phrasing).
- New `generateSessionStartHookScripts()` in `src/crosslink/hook.ts` (sibling to the existing `generateHookScripts` for UserPromptSubmit) emits `~/.relay/crosslink/hooks/session-start.{sh,mjs}` with chmod 755 on the wrapper. The generated `.mjs` script: resolves active channel via env-or-cwd reverse lookup, reads raw session JSON (NEVER `discoverSessions`), inlines `deriveRepoAdminState` + formatter byte-for-byte, gates the Feed-tail on `RELAY_SESSION_ID`, does best-effort atomic-rename watermark advance, and exits 0 on every path.
- 12 vitest cases in `test/crosslink/session-start-hook.test.ts` cover the generator (paths + chmod), template shape (4-state strings, STALE_HEARTBEAT_MS literal, no `discoverSessions`, shell exit 0), end-to-end script execution (env-resolved, cwd-resolved via stdin payload, graceful no-op on missing channel + outside-cwd), Feed-tail omitted/rendered gates, and a behavioral-equivalence test that compares the inlined `.mjs` state word against the TS reference `deriveRepoAdminState` across the 4-state truth-table fixture.
- TS schema in `src/crosslink/types.ts`: `lastSeenFeedIdx: z.number().int().nonnegative().optional()` added next to `readyAt`/`readyKind`. Additive — no schemaVersion bump.
- `CrosslinkStore.advanceFeedWatermark(sessionId, idx)` in `src/crosslink/store.ts`: monotonic, idempotent, atomic via `HarnessStore.putDoc`. Returns `null` for unknown session, `{ ok: false, idx: current }` for no-op (at or behind watermark), `{ ok: true, idx }` on successful advance. Does NOT touch `lastHeartbeat`.
- Rust mirror in `crates/harness-data/src/lib.rs`: `pub last_seen_feed_idx: Option<u64>` with `#[serde(default, skip_serializing_if = "Option::is_none")]`. Two new tests (`parses_session_with_watermark`, `parses_session_without_watermark`) cover round-trip + back-compat + the skip-on-None serialization invariant.
- 5 vitest cases in `test/crosslink/channel-store-watermark.test.ts` cover set-on-fresh, monotonic-no-rewind, idempotent-same-idx, null-for-unknown-sessionId, and the legacy-session-without-the-field back-compat property.

## Task Commits

Each task committed atomically:

1. **Task 1: Pure formatSessionStartContext formatter + truth-table tests** — `264371b` (feat)
2. **Task 2: generateSessionStartHookScripts + node-script template + e2e tests** — `6d0746d` (feat)
3. **Task 3: lastSeenFeedIdx watermark — schema + Rust mirror + store advance** — `4f2caf3` (feat)

(Plus a precursor merge commit `14efea8` that brought plan 04-01's `deriveRepoAdminState` + `STALE_HEARTBEAT_MS` into the wave-2 base — see Deviations below.)

## Files Created/Modified

- `src/crosslink/session-start-hook-content.ts` (created) — Pure formatter module: `glyphFor`, `detailFor`, `formatSessionStartContext`. No IO. Doc-comments cite the inlined `.mjs` mirror in `hook.ts` and the byte-equivalence test gate.
- `test/crosslink/session-start-hook-content.test.ts` (created) — 9 vitest cases: empty-list contract, mixed 3-repo header + rows, feed-tail gating (present/absent), booting relative-time, stale glyph + state word, prompt-injection guard, all-state glyph map.
- `src/crosslink/hook.ts` (modified) — Added `generateSessionStartHookScripts`, `buildSessionStartShellScript`, `buildSessionStartNodeScript`, `getClaudeSessionStartHookConfig`. Existing `generateHookScripts` untouched. The new node-script template inlines the formatter + state derivation as plain JS with KEEP-IN-SYNC comments cross-referencing the three sources of truth (TS formatter, TS deriveRepoAdminState, this template).
- `test/crosslink/session-start-hook.test.ts` (created) — 12 vitest cases: generator path layout + chmod, script template grep (4 state strings, STALE_HEARTBEAT_MS literal, no discoverSessions, shell exit 0), Claude SessionStart config shape, end-to-end execution with RELAY_CHANNEL_ID set, with RELAY_CHANNEL_ID UNSET (cwd reverse lookup via stdin payload), graceful no-op for missing channel + outside-cwd, Feed-tail omitted/rendered gates, behavioral-equivalence across the 4-state truth-table fixture.
- `src/crosslink/types.ts` (modified) — Added `lastSeenFeedIdx: z.number().int().nonnegative().optional()` to `CrosslinkSessionSchema` with doc-comment cross-referencing the Rust mirror and the hook write site.
- `src/crosslink/store.ts` (modified) — Added `CrosslinkStore.advanceFeedWatermark` between `updateReadiness` and `deregisterSession`. Monotonic, idempotent, atomic. Doc-comment captures the contract: no `lastHeartbeat` bump, `null` for unknown session, `{ ok: false, idx: current }` for no-op.
- `test/crosslink/channel-store-watermark.test.ts` (created) — 5 vitest cases for the advance contract + back-compat with legacy session.json shapes.
- `crates/harness-data/src/lib.rs` (modified) — Added `pub last_seen_feed_idx: Option<u64>` to `CrosslinkSession` with serde-default + skip-on-none. Two new `#[test]` cases (`parses_session_with_watermark`, `parses_session_without_watermark`) including a serialization assertion that the field is omitted when None. The test-helper `make_session` constructor was updated to initialize the new field to `None`.

## Decisions Made

- **Inlined `.mjs` derivation + formatter rather than bundling.** The generated hook script must run as a standalone node file with no `import` of third-party or workspace modules — bundling would have meant either shipping the harness through a bundle or splitting a runtime-loadable script into the install footprint. Drift between the inlined logic and the TS reference is guarded by the behavioral-equivalence test and the literal-`STALE_HEARTBEAT_MS = 120_000` grep test; any future change to `deriveRepoAdminState` or `formatSessionStartContext` requires touching this file too. The doc-comment in `buildSessionStartNodeScript` calls this out explicitly as "KEEP IN SYNC".
- **Feed: tail gated on `RELAY_SESSION_ID` matching a real session record.** The plan asked for the gate (must_haves bullet 4 + Plan 02 Task 2 acceptance criterion). The implementation reads the env, looks up the session in the already-loaded session set, and only computes/advances the watermark when both exist. User-launched (`claude` or `codex` in a Relay-channel directory without `RELAY_SESSION_ID` set) sessions render the header + per-repo lines and skip the tail entirely — honest behavior vs the noisy default that would emit `Feed: <total>` every start.
- **`advanceFeedWatermark` does NOT touch `lastHeartbeat`.** Contrast with `updateReadiness` which DOES (because readiness IS activity). The watermark is a presentation signal — incrementing it on every render would corrupt the heartbeat-age stale-detection contract. The Rust `derive_state` reads `lastHeartbeat` only.
- **Hook runs `process.cwd()` for cwd fallback, with stdin override.** Claude pipes a JSON payload with `cwd` on SessionStart; the script reads stdin, parses defensively (empty stdin OK), and prefers the stdin-supplied cwd. When stdin is empty or malformed, `process.cwd()` is used. This works for both Claude (stdin-driven) and Codex (no stdin payload — falls through to process.cwd).
- **Empty contract `repoStates.length === 0 → ""` mirrors `formatActiveSessionsBlock`.** Same append-then-skip-on-empty shape used by `print-status-context.ts`. Callers don't need a separate length check.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking issue] Merged plan 04-01 into wave-2 worktree base**
- **Found during:** Task 1 setup (typecheck failed importing `RepoAdminState` from `src/domain/repo-admin-state.js` — the module didn't exist on the wave-2 branch's tip).
- **Issue:** The worktree was branched from `main` BEFORE plan 04-01's merge commit landed. Plan 02's `depends_on: [01]` declaration meant 01's TS contract (`RepoAdminState` enum, `deriveRepoAdminState`, `STALE_HEARTBEAT_MS`, Rust mirror) needed to be in the working tree before Task 1's import line could compile.
- **Fix:** `git merge --no-ff 46f862e` (plan 04-01's SUMMARY commit, which encapsulates the full plan-01 state with `derive_state` + `STALE_HEARTBEAT_MS` exported from `src/domain/repo-admin-state.ts`). Clean merge — no conflicts because plan 02's files are net-new.
- **Files modified:** none (the merge is purely additive — plan 01's files arrive in the worktree).
- **Commit:** `14efea8` (merge commit prepended before Task 1).

**2. [Rule 1 - Bug] Initial Write tool calls landed in main repo instead of worktree**
- **Found during:** Task 1 (Write tool's `file_path` parameter was the main-repo absolute path `/Users/jonathanlancaster/projects/agent-harness/...`, not the worktree path `.claude/worktrees/agent-ad68e607fb06c19fe/...`).
- **Issue:** First two Write tool calls created files at the wrong absolute path — outside the worktree. Discovered via `ls test/crosslink/session-start-hook-content.test.ts` (relative from worktree cwd) returning ENOENT despite the Write tool reporting success. Per the `<worktree_path_safety>` invariant in the prompt, absolute paths must be derived from the worktree root, not the orchestrator's cwd.
- **Fix:** Removed the misplaced files from the main repo (`rm /Users/jonathanlancaster/projects/agent-harness/{src,test}/crosslink/session-start-hook-content.*`), then re-issued the Write calls with the full worktree-prefixed absolute path. Files now live in the worktree; commits attached to the worktree branch.
- **Files modified:** clean-room — the misplaced copies were removed before any commit, so the main repo is untouched.
- **Commit:** N/A (recovery happened before Task 1's commit).

**3. [Rule 2 - Prettier formatting] Auto-applied prettier on the e2e test file**
- **Found during:** Final `pnpm format:check` gate after Task 3.
- **Issue:** Two lines in `test/crosslink/session-start-hook.test.ts` exceeded prettier's print-width (a `writeFile` call and the `feed.jsonl` join expression).
- **Fix:** `npx prettier --write test/crosslink/session-start-hook.test.ts` — formatting-only change, no behavior. Verified tests still pass after the rewrap.
- **Files modified:** `test/crosslink/session-start-hook.test.ts` (formatting only).
- **Commit:** rolled into Task 3's commit (`4f2caf3`) so the format-check gate is GREEN on the final commit of the plan.

### Auth gates

None — Plan 02 is library code + tests; no external services.

## Issues Encountered

- **`pnpm typecheck` initially failed with `Cannot find module '../domain/repo-admin-state.js'`.** Root cause was the missing plan 01 merge into wave-2 base (deviation #1). Resolved by the merge.
- **`cargo test -p harness-data parses_session_with_watermark parses_session_without_watermark` rejected the two test names on the same invocation** (cargo only accepts a single optional `TESTNAME` filter). Ran each test in a separate `cargo test` call to verify. The plan's verification command syntax was tweaked in the SUMMARY's verification table below to reflect the actual invocation.
- **Rust struct field added → existing test-helper `make_session` constructor failed to compile.** Caught immediately by `cargo test`. Fixed by adding `last_seen_feed_idx: None` to the constructor; no other test bodies needed updating because none of the existing tests read the field.

## Verification Gates

| Gate                                                                                          | Result                                                                                       |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `pnpm test test/crosslink/session-start-hook-content.test.ts`                                 | GREEN — 9 / 9 passing                                                                        |
| `pnpm test test/crosslink/session-start-hook.test.ts`                                         | GREEN — 12 / 12 passing (e2e duration 32ms, well under Pitfall #6 100ms budget)              |
| `pnpm test test/crosslink/channel-store-watermark.test.ts`                                    | GREEN — 5 / 5 passing                                                                        |
| `pnpm test` (full suite)                                                                      | GREEN — 1135 passed, 28 skipped (Phase 3 baseline 1109 → +26 new tests; zero regressions)    |
| `pnpm typecheck`                                                                              | GREEN                                                                                        |
| `pnpm format:check`                                                                           | GREEN                                                                                        |
| `cargo test -p harness-data parses_session_with_watermark`                                    | GREEN — 1 / 1 passing                                                                        |
| `cargo test -p harness-data parses_session_without_watermark`                                 | GREEN — 1 / 1 passing                                                                        |
| `cargo test -p harness-data` (whole crate)                                                    | GREEN — 91 passed (plan 01 baseline 89 → +2 watermark serde tests)                            |
| `cargo check --workspace --locked`                                                            | GREEN                                                                                        |
| `grep -n "last_seen_feed_idx" crates/harness-data/src/lib.rs`                                  | Field declared at lib.rs:634 with `#[serde(default, skip_serializing_if = "Option::is_none")]` |
| `grep -n "lastSeenFeedIdx" src/crosslink/types.ts`                                            | Field declared at types.ts:58 as `z.number().int().nonnegative().optional()`                  |
| `grep -n "discoverSessions" src/crosslink/hook.ts` (uncommented references)                   | 0 — all 1 reference in the new code is in a `//` comment explaining what we DON'T do          |
| Generated script body contains `STALE_HEARTBEAT_MS = 120_000`                                 | YES — guardrail test for the literal passes                                                  |
| Generated script body contains all 4 state strings                                            | YES — `"disconnected"`, `"booting"`, `"ready"`, `"stale"` all present                         |
| Generated script body contains `discoverSessions`                                             | NO — Pitfall #3 enforced at the script-template level by `expect(script).not.toContain(...)` |
| Feed-tail omitted when `RELAY_SESSION_ID` unset                                               | YES — e2e test `Feed: tail is OMITTED when RELAY_SESSION_ID is unset` passes                  |
| Feed-tail rendered when `RELAY_SESSION_ID` matches existing session with `lastSeenFeedIdx: 2` against 5 feed entries | YES — e2e test asserts `"Feed: 3 new entries"` substring (5 − 2 = 3)                       |
| Behavioral equivalence: inlined `.mjs` state ↔ TS `deriveRepoAdminState`                       | YES — `generated_mjs_formatter_matches_TS_deriveRepoAdminState_for_all_4_states` GREEN for 5 fixture rows (disconnected, booting, ready, stale-by-heartbeat, stale-by-dead-pid) |

## Self-Check: PASSED

- `[ -f src/crosslink/session-start-hook-content.ts ]` → FOUND
- `[ -f test/crosslink/session-start-hook-content.test.ts ]` → FOUND
- `[ -f test/crosslink/session-start-hook.test.ts ]` → FOUND
- `[ -f test/crosslink/channel-store-watermark.test.ts ]` → FOUND
- Commit `264371b` (Task 1) → FOUND in `git log`
- Commit `6d0746d` (Task 2) → FOUND in `git log`
- Commit `4f2caf3` (Task 3) → FOUND in `git log`

## User Setup Required

None — Plan 02 is library code + an idle hook generator. The generator function (`generateSessionStartHookScripts`) is not yet wired into `rly install`; that happens in Plan 03. Once Plan 03 lands, an existing user re-running `rly install` will see the new `session-start.{sh,mjs}` files appear under `~/.relay/crosslink/hooks/` and a corresponding `SessionStart` entry in `~/.claude/settings.json`. No env vars or external services.

## Next Phase Readiness

- **Plan 03 (install integration):** Can wire `generateSessionStartHookScripts()` into `src/cli/install.ts` next to the existing `generateHookScripts()` call. The Claude `settings.json` snippet helper (`getClaudeSessionStartHookConfig`) is exported for the same drift-manifest treatment. Codex install path is gray-area per 04-CONTEXT.md Deferred Ideas — researcher's call lands in Plan 03 scope.
- **Plans 04-05 (TUI/GUI/CLI rendering surfaces):** Can consume the same `RepoAdminState` + the new `lastSeenFeedIdx` field; the Rust mirror is in place for the TUI/GUI direct-read path. The `Feed: N new` tail logic is centralized inside the hook script body — TUI/GUI will compute their own "unread count" against the same `lastSeenFeedIdx` field, no separate watermark needed.
- **Plan 03 dependencies:** This plan provides everything Plan 03 needs (`generateSessionStartHookScripts`, `getClaudeSessionStartHookConfig`). No further schema changes required.

### Concerns / blockers

None for downstream Plans 03-05. Two latent risks worth flagging:

1. **The inlined `.mjs` derivation lives in three places** (TS reference, formatter module, generated script). The behavioral-equivalence test catches drift in the state-word output across the 4-state truth-table fixture, and the literal-`STALE_HEARTBEAT_MS = 120_000` grep test catches drift in the constant. These are guardrails, not preventatives — a contributor changing `deriveRepoAdminState` who forgets the script template will see the test fail rather than ship a silent bug. KEEP-IN-SYNC doc-comments in `buildSessionStartNodeScript` call this out explicitly.

2. **The watermark write is best-effort fire-and-forget inside the hook script.** A disk failure during `advanceWatermark` is swallowed (Pitfall #2 graceful no-op — the hook never blocks session start). The worst-case behavior is that next session start re-emits the same "Feed: N new" count; no data corruption, no double-counting. T-04-07 documents this as `accept` in the threat register.

---
*Phase: 04-project-readiness-surface*
*Completed: 2026-05-13*
