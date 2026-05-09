# Phase 2 — Plan Re-check (iteration 3)

**Verified:** 2026-05-09
**Plan:** `.planning/phases/02-handoff-command-brief-synthesizer/02-PLAN.md` (post-revision)
**Previous review:** `02-CHECK.md` (2 HIGH, 10 MEDIUM, 7 LOW)

## VERDICT: READY

Both HIGH-severity blockers are fully closed in code-and-test, not just doc-level handwaving. All 10 MEDIUMs landed substantively (spot-checked four). No new HIGH-severity issues introduced. The Phase 1 contract block in `<phase_2_handoff_contract_inherited_from_phase_1>` matches what Phase 1 actually emits per its READY plan. Goal coverage holds — REQ-2.1…REQ-2.10 all map to tasks. Plan is execution-ready.

## Spot-check observations

**1. H1 — ApprovalsQueue.list signature (CLOSED).** Confirmed against `src/approvals/queue.ts:312`: actual signature is `list(sessionId: string, options: ListOptions = {})` where `ListOptions = { status? }`. Plan's Task 3.1 Step 2 (PLAN L820) now reads `const existing = await approvalsQueue.list(sessionId);` followed by `if (rec.kind !== "handoff-prompt") continue;` — exactly the H1-prescribed shape. Dedup is on `(sessionId, threshold)` extracted from `payload.thresholdPct` (PLAN L824-829). The `entryId`-half of the dedup story is dropped — `HandoffPromptPayload` interface deliberately has no `entryId` field per the explicit comment at L836. Verification step 5 grep (PLAN L1267-1278) is correctly tightened to `src/orchestrator/handoff/`, `src/cli/handoff.ts`, `src/mcp/channel-tools.ts`, plus the `git diff` slice for `dispatch.ts` / `run-autonomous.ts` — pre-existing `src/approvals/queue.ts` is explicitly excluded with rationale.

**2. H2a — SUMMARY filename (CLOSED).** `<output>` block (PLAN L1374) now reads `02-SUMMARY.md` (short form). Mirrors Phase 1's L5 convention (`01-SUMMARY.md`, confirmed in Phase 1 PLAN L1992). One-character fix landed correctly.

**3. H2b — Defense-in-depth two-session test (CLOSED).** `threshold-listener.test.ts` Step 5 (PLAN L868-895) contains the exact `it("two distinct sessionIds both crossing 90% enqueue independent approvals", ...)` test the original CHECK demanded — posts two `context_threshold` entries for `sess-A` / `sess-B`, attaches one listener per session, asserts both approvals exist and neither dedupes against the other. Sync-point note added inside `<phase_2_handoff_contract_inherited_from_phase_1>` at L234: *"If Phase 1 ships without its M5 fix, Phase 2 owns the dedup-by-(sessionId, threshold) contract test in its own suite."* Note: Phase 1 actually shipped the M5 multi-tracker test (its own RECHECK confirms — see Phase 1 RECHECK §3), so this is genuine defense-in-depth, not load-bearing.

**4. M2 spot-check (PERMISSIVE `--save`) — closed in substance.** `validateBrief` signature now takes `mode: "strict" | "permissive"` (PLAN L607). PERMISSIVE mode skips the 8K cap and missing-section checks, runs ONLY the secret-pattern scan (PLAN L609). Task 4.1 mode dispatch routes `--save` → PERMISSIVE (PLAN L967) and `--to` → STRICT (PLAN L968). Tests cover both modes (PLAN L1123-1125 acceptance bullets + L1037 force-doesn't-bypass-secret in BOTH modes). Real fix.

**5. M9 spot-check (schemaVersion round-trip) — closed.** Task 2.1 Step 2 Zod schema uses `z.literal(1).optional()` (PLAN L707), explicit failing test at L718 (`schemaVersion: 2 in input ⇒ Zod rejects`), persistence-side fail-closed at L727 (`readLatestGapFill returns null when on-disk record has schemaVersion: 2`). Both halves of the M9 gate (input + disk-read) covered. Real test code, not handwaving.

**6. M10 spot-check (cross-dashboard widening audit) — closed.** Wave 5 Task 5.1 Step 0 (PLAN L1089-1095) is an explicit RUN-FIRST audit step over `tui/`, `gui/src/`, `gui/src-tauri/src/lib.rs`, `crates/harness-data/src/lib.rs`. For renderers: widen with placeholder rendering `"Handoff prompt — context at <pct>%"`. For kind-agnostic surfaces: document fall-through. New `rly pending-approvals --json` test at L1109 asserts the handoff-prompt record renders. Files added to `files_modified` frontmatter (L47-51) with "audit only — no code changes expected" annotation.

**7. Phase 1 sync verification — passes.** Cross-checked Phase 1 PLAN L2008-2014 against Phase 2's inherited contract block (PLAN L223-237):
- File subscribed: `~/.relay/channels/<channelId>/feed.jsonl` ✓
- Filter on `metadata.kind === "context_threshold" && metadata.threshold === "90"` ✓
- Threshold values 75/90/95 ✓ (Phase 1 D-01 widens THRESHOLDS to `[50, 60, 75, 85, 90, 95, 100]`, threshold-feed-bridge filters to `[75, 90, 95]` for chat — PLAN L202)
- `metadata.threshold` STRING (`"75"`/`"90"`/`"95"`) ✓
- `metadata.pct` STRING matching `/^\d+\.\d{2}$/` ✓ (Phase 1 PLAN L922-923)
- `metadata.schemaVersion === "1"` STRING ✓
- D-03 handoff-id contract (new sessionId starts at 0, Phase 1 doesn't enforce in code, M8 soft-warning) — Phase 2's contract block carries the M8 sharpening verbatim from Phase 1.
- M1 string→number boundary parsing: confirmed at PLAN L787 (`Number(entry.metadata.threshold)`, `Number(entry.metadata.pct)`, `Number(used)`, `Number(total)` — exactly once, in listener Step 2).

No drift between what Phase 1 emits and what Phase 2 consumes.

## New-risk check

- **M10 cross-dashboard audit scope:** Wave 5 already absorbs design doc + CLI doc + integration test. Adding the M10 audit + potential widening of TUI/GUI/Rust kind-switches is a real scope bump. Plan acknowledges with explicit "Wave 5 may split into 5a/5b if M10 widening is heavy" (PLAN L1281, L1358). Acceptable — the split contingency is pre-planned. **Not a blocker.**
- **`gitLogEnabled` opt:** Single `BuildBriefOptions` field with default `true` (PLAN L78). Used by tests for strict bit-identicality (`gitLogEnabled: false`). Not a CLI flag, not a config file knob, not a feature flag — just an injectable boolean for test isolation. Does NOT proliferate config flags. Clean.
- **Wave 4 LOC pre-split:** L3 fix splits into 4a (CLI handler + mode dispatch) and 4b (spawn helpers + index.ts wiring), pre-planned in Task 4.1 action. Both stay under 800 LOC.
- **Acceptance vagueness:** Spot-checked Task 3.1 `<done>` (L908-910), Task 4.1 `<done>` (L1068), Task 5.1 acceptance bullets (L1123-1125) — all concrete, testable, named files/grep patterns. No vague language.
- **Goal coverage still holds:** All 10 REQ-2.x identifiers remain in `requirements:` frontmatter (PLAN L55-64) and the L1-mapped coverage matrix (L1287-1297). REQ-2.4 maps to Task 3.1 + Task 5.1 (M10 audit). REQ-2.7 (validation) and REQ-2.8 (--save/--resume) trace to D-09 / D-08 explicitly. No requirement orphaned.

## LOW-severity polish (non-blocking)

- **Task 3.1 Step 5 boilerplate test** could share fixture-creation helpers with the H2b two-session test to keep the file under ~300 LOC. Not a blocker — the file lands well under the per-file readability ceiling either way.
- **`<files_modified>` `tui/` and `gui/src/`** are listed as bare directory paths rather than specific files (because the audit-only outcome is unknown until Step 0 runs). Acceptable — the M10 audit step explicitly adjusts the frontmatter list if widening is needed. Plan acknowledges at L48 with the inline comment.
- **`buildCodexChatArgv` helper** (M6) is asserted as unit-testable in Task 4.1 `<done>` (L1068) but no specific test file is named in `files_modified`. The existing `handoff-cli.test.ts` will likely cover it via Codex spawn assertions; if the helper grows non-trivial, a dedicated `codex-chat-argv.test.ts` would be cleaner. Non-blocking.
- **Phase 1 RECHECK note about `cli_bin()` naming inaccuracy** does not affect Phase 2 — Phase 2 references `gui/src-tauri/src/lib.rs:start_chat` only as an idiom, not via the `cli_bin` helper. No cross-phase contamination.

None of these block execution.
