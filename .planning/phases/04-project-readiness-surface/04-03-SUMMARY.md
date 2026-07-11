---
phase: 04-project-readiness-surface
plan: 03
subsystem: install
tags:
  [install, manifest, hooks, claude, codex, toml, session-start, drift-detection]

# Dependency graph
requires:
  - phase: 04-project-readiness-surface (plan 02)
    provides: generateSessionStartHookScripts (src/crosslink/hook.ts) — emits the shell + node hook script pair that this plan registers
  - phase: 04-project-readiness-surface (plan 01)
    provides: RepoAdminState contract — referenced indirectly via the script body the hook drift SHA tracks
provides:
  - rly install now writes SessionStart hook entries into ~/.claude/settings.json AND ~/.codex/hooks.json (idempotent atomic-rename merge)
  - rly install enables [features].hooks = true in ~/.codex/config.toml (idempotent TOML merge, comment-preserving for non-features sections)
  - rly install --check reports per-target hook drift alongside surface drift, via an additive optional `hooks` block in ~/.relay/installed.json (schemaVersion stays at 1)
  - --skip-codex flag for Claude-only installs
  - Codex CLI version probe is fail-soft (writes config even on missing CLI or v<0.130; activates on upgrade)
affects:
  - 04-04 (TUI/GUI rendering — consumes hooks installed here)
  - 04-05 (CLI status / SUMMARY)
  - future phases that touch rly install (manifest hooks block is part of public on-disk contract)

# Tech tracking
tech-stack:
  added:
    - "@iarna/toml ^2.2.5 (TOML parser for Codex config.toml round-trip)"
  patterns:
    - "Filter-out-then-push idempotency: tag-based identification of Relay-owned entries in user-shared config files (matcher === 'relay-channel-readiness'); preserves third-party entries on re-run"
    - "Codex version probe + fail-soft: spawnSync with 2s timeout, log a friendly note on any failure mode, write config anyway (activates on upgrade)"
    - "Manifest additive extension: optional `hooks` block, schemaVersion unchanged — back-compat Phase 3 manifests parse cleanly"
    - "Drift SHA = hash of GENERATED script body (deterministic given fixed relayDir) — single source of truth for detecting on-disk tampering"

key-files:
  created:
    - "src/install/codex-toml.ts — ensureCodexFeatureFlag idempotent TOML writer"
    - "test/install/codex-toml.test.ts — 10 cases pinning fresh-file, idempotent, preservation, comment warning"
    - "test/install/manifest-hooks.test.ts — 10 cases for hooks block + drift helpers + back-compat"
    - "test/install/install-session-start.test.ts — 12 end-to-end cases for the hook install path"
    - ".planning/phases/04-project-readiness-surface/04-03-SUMMARY.md (this file)"
  modified:
    - "src/install/manifest.ts — added HookTarget, HookRecord, HOOK_TARGETS; markHookInstalled / getHookRecord / diffHook / reportHookDrift; exported InstallManifest"
    - "src/install/installer.ts — installSessionStartHooks; writeHookConfig (idempotent JSON merge w/ atomic-rename + backup-on-malformed); runCodexVersionProbe (fail-soft); RELAY_HOOK_MATCHER constant"
    - "src/cli/install.ts — --skip-codex flag; hook drift in runCheck; calls installSessionStartHooks after surface install"
    - "package.json + pnpm-lock.yaml — @iarna/toml dep"

key-decisions:
  - "Use @iarna/toml (most widely deployed Node TOML library) rather than smol-toml — runtime size acceptable, parse API simpler. Accepted limitation: comments inside the [features] section are lost on round-trip (logged as a stderr note when detected; comments in OTHER sections survive)."
  - "Codex version probe is fail-soft (D-Plan-1) — write config on any failure (v<0.130, ENOENT, timeout, unparseable). Configs are harmless on older Codex builds and activate automatically on upgrade. Preserves the four-surface parity promise even on partial installs."
  - "Matcher tag 'relay-channel-readiness' identifies Relay-owned hook entries. Filter-out-by-tag-then-push idempotency: re-running install replaces our entry by tag, never by array index, so third-party SessionStart entries are never displaced."
  - "Hook SHA = SHA-256 of generated session-start.mjs body. Both Claude and Codex share the same source SHA (they hash the same script). Manifest entries record per-target so --skip-codex callers don't see phantom rows."
  - "Malformed ~/.claude/settings.json: install backs up to .bak.<ts> and proceeds — avoids the 'install nuked my settings' failure mode when the user has a syntax error mid-edit."
  - "Schema version stays at 1 — hooks block is ADDITIVE optional. Phase 3-shaped manifests parse without modification (regression test pins this)."

patterns-established:
  - "Hook install idempotency: filter-out-by-matcher-tag + atomic-rename merge into user-shared JSON config files"
  - "Fail-soft external CLI probe: spawnSync + timeout + multi-failure-mode logger note + continue"
  - "Drift detection by hashing generator output, not on-disk file content (decouples drift from formatting)"
  - "Additive manifest extension: optional field, schemaVersion unchanged, isManifest predicate accepts both shapes"

requirements-completed:
  - SURFACE-01
  - SURFACE-02
  - SURFACE-07

# Metrics
duration: 7min
completed: 2026-05-13
---

# Phase 4 Plan 03: rly install — Claude + Codex SessionStart hook wiring + manifest hooks block Summary

**rly install now atomically registers the Plan 04-02 SessionStart hook in both `~/.claude/settings.json` and `~/.codex/hooks.json`, sets `[features].hooks = true` in `~/.codex/config.toml`, and tracks per-target drift via an additive `hooks` block in `installed.json` — with a fail-soft Codex version probe that preserves the four-surface parity promise on older Codex builds.**

## Performance

- **Duration:** ~7 min
- **Started:** 2026-05-13T14:42:00Z
- **Completed:** 2026-05-13T14:49:22Z
- **Tasks:** 3
- **Files modified:** 4 source files (manifest.ts, installer.ts, cli/install.ts, codex-toml.ts), 3 test files, package.json + pnpm-lock.yaml
- **Tests added:** 32 (10 codex-toml, 10 manifest-hooks, 12 install-session-start)
- **Full-suite test count:** 1167 passing / 28 skipped (no regressions; was 1135+ pre-plan)

## Accomplishments

- Net-new install path that closes the Plan 04-02 generator-to-agent gap: agents now actually see Relay state on every Claude/Codex session start after `rly install`.
- Idempotent JSON merge into shared config files preserves user-configured hooks (UserPromptSubmit, third-party SessionStart entries) — verified by Threat T-04-09 mitigation tests.
- Per-target drift detection through the manifest's new optional `hooks` block, surfaced in `rly install --check` alongside surface drift, sharing the same `fresh` / `current` / `behind` vocabulary.
- Codex version probe is fail-soft — install never blocks or fails on missing Codex CLI, old version, or hung child process (2s timeout); writes config anyway and logs a single friendly note.
- TOML helper preserves unrelated sections + keys; documented limitation on [features]-section comment reformatting with stderr warning when detected.

## Task Commits

Each task was committed atomically against the wave-3 base (after merging `feat/phase-04-project-readiness-surface` for Wave 1+2 dependencies):

1. **Task 1: Codex TOML feature-flag helper** — `439d186` (feat)
2. **Task 2: Manifest extension with SessionStart hook records** — `81f5e17` (feat)
3. **Task 3: rly install wiring for Claude + Codex SessionStart hooks** — `209ceaa` (feat)

Wave-base merge: `f00f5ce` (`merge: bring waves 1+2 into wave 3 base for plan 04-03`).

## Files Created/Modified

### Created

- `src/install/codex-toml.ts` — `ensureCodexFeatureFlag(flag, value, opts?)` idempotent TOML merge; `codexConfigPath()`; private `hasCommentsInFeatures` heuristic for the warning path.
- `test/install/codex-toml.test.ts` — 10 cases (fresh write, idempotent, preservation of other sections + keys, update existing flag, atomic-rename cleanup, legacy `codex_hooks` left untouched, comment-warning emit + non-emit cases, fresh-write parent-dir, nested-table preservation).
- `test/install/manifest-hooks.test.ts` — 10 cases (back-compat Phase 3 manifest, markHookInstalled persistence, idempotency, diffHook semantics, reportHookDrift both targets + caller-skip support, drift `behind`, write-then-read regression, malformed-hooks fallback, schemaVersion-stays-at-1 guard).
- `test/install/install-session-start.test.ts` — 12 end-to-end cases including pre-existing-hook preservation (T-04-09), idempotent re-run, third-party-SessionStart preservation, version probe < v0.130 / ENOENT / unparseable, `--skip-codex` skips all Codex writes, 64-char-hex sha in manifest, drift detection regression, malformed-settings backup recovery.
- `.planning/phases/04-project-readiness-surface/04-03-SUMMARY.md` (this file).

### Modified

- `src/install/manifest.ts` — Exported `InstallManifest`; new types `HookTarget`, `HookRecord`, constant `HOOK_TARGETS`; new helpers `getHookRecord`, `markHookInstalled`, `diffHook`, `reportHookDrift`, type `HookDriftEntry`; `isManifest` extended to accept optional/missing/object hooks block, rejects malformed (e.g. `hooks: null`). `schemaVersion` stays at `1` (additive change).
- `src/install/installer.ts` — New exports `installSessionStartHooks` (with `InstallSessionStartHooksOptions` + `InstallSessionStartHooksResult` interfaces) and `RELAY_HOOK_MATCHER` constant. Private `writeHookConfig` (filter-out-then-push semantic with atomic-rename, malformed-JSON backup-and-recover path) and `runCodexVersionProbe` (spawnSync + 2s timeout + structured kind union). Imports `generateSessionStartHookScripts` from Plan 04-02 + `ensureCodexFeatureFlag` from Task 1.
- `src/cli/install.ts` — Added `--skip-codex` flag and HELP text. `runCheck` now also computes the hook source SHA via the generator, calls `reportHookDrift`, and prints per-target drift lines + a `(hooks drifted: …)` suffix on the resolution prompt. `handleInstallCommand` invokes `installSessionStartHooks` after surface installs (skipped if any surface install failed; user re-runs cheaply).
- `package.json` + `pnpm-lock.yaml` — Added `@iarna/toml ^2.2.5` to `dependencies` (NOT devDependencies — install runs at user-runtime).

## Decisions Made

All decisions were either pre-decided in the plan or routine engineering choices:

- **TOML library:** `@iarna/toml` chosen over `smol-toml` (per Plan Task 1 read_first). No existing TOML dep in the repo. Added to `dependencies` (not devDeps) because `rly install` executes at user-runtime.
- **Codex version probe behavior:** Followed plan D-Plan-1 fail-soft contract exactly — log a friendly note for each failure mode (`too-old`, `not-found`, `unparseable`), write config anyway, return exit 0 unless an unrelated FS write failure occurs.
- **Matcher tag idempotency:** Used the documented tag `relay-channel-readiness` for both Claude and Codex entries. The matcher appears 5 times in `src/install/installer.ts` (constant declaration + filter + tests + comments) — exceeds the acceptance criteria minimum of ≥2.
- **Malformed JSON recovery:** Implemented backup-to-`.bak.<ts>` rather than throwing, to honor the spirit of "do not nuke the user's settings" (Threat T-04-09). The user's broken settings are preserved on disk, and install proceeds with a fresh base.
- **Test isolation:** All install tests use a tmpdir-rooted `HOME` and `__resetRelayDirCacheForTests` (the same pattern Plan 04-02's session-start-hook tests use). No test touches the real `~/.relay/`, `~/.claude/`, or `~/.codex/`.

## Deviations from Plan

None substantive. Minor adjustments tracked here for transparency:

### Auto-fixed / discovered during execution (not deviations from plan intent)

**1. [Rule 2 — Missing critical] Backup-on-malformed-JSON recovery path**

- **Found during:** Task 3 (writeHookConfig design)
- **Issue:** The plan asked for "preserve user-configured pre-existing hooks" but did not specify what to do when `~/.claude/settings.json` is itself malformed JSON (e.g., user mid-edit with a syntax error). A naive `JSON.parse` throw would leave the install half-done.
- **Fix:** On JSON.parse failure, copy the malformed file to `.bak.<ts>` and proceed with an empty base. Test case `recovers gracefully when settings.json contains malformed JSON (backup written)` verifies the backup is created.
- **Files modified:** `src/install/installer.ts` (writeHookConfig), `test/install/install-session-start.test.ts`
- **Committed in:** `209ceaa`

**2. [Rule 3 — Blocking] Unparseable Codex version output handling**

- **Found during:** Task 3 (probe design)
- **Issue:** Plan listed two probe failure modes (< v0.130 and ENOENT) but didn't address an exotic third: probe succeeds, stdout has no version-shaped substring (e.g., `garbled output\n`). Without a third branch the probe would silently mask this as `not-found`, hiding a real diagnostic.
- **Fix:** Added an `unparseable` probe kind with its own logger line `Could not parse Codex CLI version (got: <raw>)`. Test case `Codex version probe with unparseable stdout: writes anyway + logs note` verifies behavior. Still fail-soft — writes config anyway.
- **Files modified:** `src/install/installer.ts`
- **Committed in:** `209ceaa`

---

**Total deviations:** 2 small additions (1 missing-critical recovery path, 1 missing-blocking probe branch). Both inside the spirit of D-Plan-1 fail-soft + T-04-09 mitigation — no scope expansion.

**Impact on plan:** None on plan intent. Both additions strengthen the contract by closing edge cases the plan listed at the right level of abstraction.

## Issues Encountered

- **Prettier formatting drift:** Initial source files needed reformatting (long template literals broken across lines). Resolved by running `pnpm format` and re-staging. No semantic changes.
- **Format-check gated commit assembly:** Three files committed in Tasks 1+2 were reformatted by Task 3's `pnpm format` pass. Folded the reformat into Task 3's commit (pure whitespace, no semantic delta) to keep history honest about which commit introduced final formatting.

## Verification Summary

```
pnpm test test/install/                  → 32 passing (3 files)
pnpm test                                → 1167 passing | 28 skipped | 0 failing
pnpm typecheck                           → green
pnpm format:check                        → "All matched files use Prettier code style!"
grep -c "relay-channel-readiness" src/install/installer.ts → 5 (≥ 2 required)
grep -n "discoverSessions" src/install/  → no matches in new code (Pitfall #3 avoided)
grep -n "schemaVersion: 1" src/install/manifest.ts → still 1 (additive change)
grep -n "hooks?:" src/install/manifest.ts → field is OPTIONAL
```

## User Setup Required

None — the install path is fully automatic. After running `rly install`, agents will see Relay channel state on every Claude or Codex session start (Codex v0.130+; older Codex builds get the config and activate on upgrade).

## Next Phase Readiness

- **04-04 (TUI/GUI rendering of admin/worker state):** ready. The hook install path now puts the SessionStart script into agents' execution paths; TUI/GUI rendering plans consume the same state derivation contract (Plan 04-01) the hook script uses, so rendering changes do not need to touch this plan's artifacts.
- **04-05 (CLI status / SUMMARY):** ready. `rly install --check` JSON output now exposes per-target hook drift (under a new `hooks` key) for any consumer that wants programmatic access.
- **Public on-disk contract:** the `hooks?` block in `~/.relay/installed.json` is now part of the documented manifest shape. Future plans modifying the manifest should preserve back-compat via additive optional fields the same way.

## Self-Check: PASSED

- src/install/codex-toml.ts: FOUND
- src/install/installer.ts (modified, includes installSessionStartHooks export): FOUND
- src/install/manifest.ts (modified, includes HookRecord export): FOUND
- src/cli/install.ts (modified): FOUND
- test/install/codex-toml.test.ts: FOUND
- test/install/manifest-hooks.test.ts: FOUND
- test/install/install-session-start.test.ts: FOUND
- Commit 439d186 (Task 1): FOUND
- Commit 81f5e17 (Task 2): FOUND
- Commit 209ceaa (Task 3): FOUND

---
*Phase: 04-project-readiness-surface*
*Plan: 03*
*Completed: 2026-05-13*
