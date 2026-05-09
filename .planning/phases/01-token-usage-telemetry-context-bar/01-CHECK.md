# Phase 1 — Plan Check

**Verified:** 2026-05-09
**Plan:** `.planning/phases/01-token-usage-telemetry-context-bar/01-PLAN.md`
**Phase goal:** Live "% of context window consumed" indicator per session, visible in TUI/GUI/CLI status. Foundational for Phase 2's 90% nudge. Threshold events must emit reliably enough for Phase 2 to subscribe to.

---

## VERDICT: NEEDS_REVISION

The plan is comprehensive, well-structured, and mostly sound. Goal coverage is strong, the Phase 2 contract is the best-specified part of the plan, and the source_audit traces every requirement to a task. However, there are two HIGH-severity findings that will defeat acceptance criteria as written, plus a cluster of MEDIUM findings that should be addressed before execution.

The most consequential gap: **TUI chat-mode is a third dispatch path that the plan does not record telemetry from**, despite the question being explicitly raised by the upstream verifier. As written, a user running a chat session via `rly tui` will see a 0% bar permanently, breaking REQ-1.4 in practice even though Task 9 ships a TUI bar widget.

---

## HIGH-SEVERITY FINDINGS (must fix before execution)

### H1. TUI chat-mode dispatch records no telemetry — directly defeats REQ-1.4 acceptance

**Affects:** Task 10 (Step 4), Task 9
**Severity:** HIGH (blocker)

**Gap:**
The plan correctly identifies two dispatch paths in its writing — `OrchestratorV2.dispatch` (Task 4) and the GUI's chat-event Rust loop (Task 10 Step 3) — but it then fumbles the third. `tui/src/main.rs:2627-2779` spawns Claude directly via `Command::new(claude_bin)` and runs its own JSONL parser (a `Some("result") =>` arm at `:2751-2769`). That arm extracts `session_id` and the result text but does NOT extract `usage` and does NOT shell out to `rly chat record-usage`.

Task 10 Step 4 acknowledges this dispatch path may exist but treats it as conditional:
> "if the TUI has its own chat dispatch path, add the same shell-out. If TUI chat goes through `rly` already (via `cli_json`), then nothing to do — `rly chat record-usage` is the universal sink. Verify by grepping `tui/src/main.rs` for chat dispatch patterns and document in the task summary."

Verification result: it does NOT go through `rly`. It uses its own `Command::new(claude_bin)` at `tui/src/main.rs:2686`. Task 10 must therefore add a TUI-side `result`-arm extension that mirrors the GUI's, OR the Task 9 bar will read `~/.relay/sessions/<sessId>/budget.jsonl` files that never get populated for TUI-launched sessions.

This is the exact "dispatch parity" failure the upstream verifier asked you to surface.

**Suggested fix:**
Make Task 10 Step 4 a hard requirement, not a conditional:
1. Add `let mut captured_usage: Option<serde_json::Value> = None;` before the parse loop in `tui/src/main.rs:2700`.
2. In the `Some("result")` arm at `:2751`, capture `json.get("usage")` into `captured_usage`.
3. After `child.wait()` resolves, if `captured_usage` and `session_id` are both `Some`, spawn `rly chat record-usage --session <sid> --input <n+cache> --output <n> --channel <chid> --model <model>` exactly the way the GUI does. Reuse the same env-augmentation helper (TUI doesn't have `augmented_child_path()` — copy it from `gui/src-tauri/src/lib.rs` or move it to a shared crate; this is a real diff item, not a one-line change).
4. Remove the conditional language from Task 10 Step 4. Mark it BLOCKING for Task 9's bar to actually update on a TUI-launched session.

The plan currently treats TUI chat as a possibility; verification confirms it's the case. As-is, executing the plan delivers a TUI bar that never updates for the dispatch path TUI users actually use.

---

### H2. Wave 0 PR (Task 0) cannot compile without the types Tasks 2 and 6 introduce

**Affects:** Task 0, Wave structure / PR-1 boundary
**Severity:** HIGH (blocker for the as-described PR ordering)

**Gap:**
Task 0's `<done>` field is honest about this:
> "the test bodies refer to `SessionBudget` / `load_session_budget` which Tasks 2 and 6 will introduce, so this task may need to land alongside skeleton type stubs (acceptable)."

But the `<wave_structure>` then says "PR 1: Wave 0 (test scaffolds + spike)" and "PR 2: Waves 1 + 2". As specified, PR 1's `pnpm typecheck` and `cargo check --workspace --locked` will fail because:
- `test/domain/session-budget.test.ts` imports `SessionBudgetSchema` (added in Task 2 / PR 2).
- `test/budget/session-tracker-pool.test.ts` imports `SessionTrackerPool` (added in Task 4 / PR 2).
- `test/budget/threshold-feed-bridge.test.ts` imports `attachThresholdFeed` (added in Task 5 / PR 2).
- `test/cli/chat-record-usage.test.ts` imports `handleChatRecordUsage` (added in Task 10 / PR 4).
- `crates/harness-data/src/lib.rs` `#[test]` block references `SessionBudget` (added in Task 6 / PR 2).

PR 1 cannot be merged independently — every CI gate fails. The plan's own Task 0 `<verify>` does `! grep -q "0 failed"` (asserts SOME tests fail, RED) but `pnpm typecheck` is not run in that verify command, masking the issue. The real CI for the PR will run `pnpm typecheck`, which will fail outright because of missing imports.

**Suggested fix:**
Pick one:
- **Option A (preferred — fewer PRs, simpler):** Collapse PR 1 + PR 2 into a single PR. Total estimated LOC stays under 800 if Task 0's tests don't include the doc and Wave 1 stays disciplined. Justify in the PR description; the wave-structure block currently cites ~600 + ~700 = 1,300 LOC, which exceeds the 800 LOC discipline — re-estimate before committing.
- **Option B (stay 5 PRs):** Restructure: ship Tasks 0 + 2 + 6 together as one PR (test scaffolds + the types they reference + Rust mirror). Then PRs 2, 3, 4, 5 ship the rest. This preserves the cross-dashboard contract (TS+Rust together) and keeps each PR compilable in isolation.

Either way: edit `<wave_structure>` and `<done>` for Task 0 to remove the "skeleton type stubs (acceptable)" language and replace with the chosen ordering. As written it ships a known-failing CI run.

---

## MEDIUM-SEVERITY FINDINGS (should fix; not blocking)

### M1. `SessionBudget` schemaVersion field has a TS↔Rust drift risk that the plan's own fixture test will not catch

**Affects:** Task 0 (Rust serde fixture), Task 2 (TS shape), Task 6 (Rust mirror)
**Severity:** MEDIUM

The fixture test in Task 0 step 10 hand-writes `"schemaVersion":1`. The Rust struct in Task 6 has `pub schema_version: u32` with `#[serde(default = "default_session_budget_schema_version")]` returning 1. If the TS side ships `schemaVersion: 2` someday and the Rust side hasn't been updated, the fixture test will still pass because the Rust default kicks in — silently degrading the schema-version assertion to "any value or no value, treat as 1." This defeats the purpose of versioning.

**Suggested fix:** The Rust fixture test must explicitly assert `assert_eq!(deserialized.schema_version, 1)` AND a second test must hand-write a version-2 line and assert it round-trips to `2` (not gets silently downgraded to `1`). On the TS side, Task 0 step 7 only checks `0` and `missing` cases — add a `version: 2` case that asserts the parser errors with a clear message.

---

### M2. A1 spike fallback path is named INCONCLUSIVE but has no machine-readable structure for Task 3 to consume deterministically

**Affects:** Task 1, Task 3
**Severity:** MEDIUM

Task 1's verify gives a `grep`-able BRANCH marker, but Task 3's INCONCLUSIVE branching ("Implement both paths; use Branch A first; fall back to Branch B if `parsed.usage` is undefined and a JSONL stream file is available") has no defined source for the Codex stream-flag name. Task 3's INCONCLUSIVE branch becomes "implement Branch A and hope" — silently does nothing for Codex if the assumption breaks in production.

**Suggested fix:**
- Add to Task 1's spike output an explicit `STREAM_FLAG=<name>` line (e.g. `STREAM_FLAG=--json` or `STREAM_FLAG=NONE`). Make this machine-readable so Task 3 can `grep` it.
- Update Task 3's Branch INCONCLUSIVE language: "If `STREAM_FLAG=NONE`, implement Branch A only and emit a `[budget] Codex usage extraction unavailable` warning to stderr if `parsed.usage` is undefined after a Codex run. If `STREAM_FLAG` is set, implement both paths."

---

### M3. Task 4 dispatch wiring uses `run-${run.id}` as session id, not a chat session id — orchestrator and chat-mode write to different keyspaces

**Affects:** Task 4, Task 11 (CLI status), Task 7 (worst-session chip)
**Severity:** MEDIUM

Task 4 Step 2 uses ``const sessionId = `run-${run.id}`;``. Task 10 Step 1 records into the actual chat session id. This produces three keyspaces under `~/.relay/sessions/`: `run-*` (orchestrator), `<claudeSessionId>` (chat-mode), `admin-*` (autonomous loop, per `repo-admin-session.ts:448-461`). Task 11's `loadActiveSessions()` reads ALL `~/.relay/sessions/<id>/budget.jsonl` files filtered by mtime — it will return entries from all three keyspaces indistinguishably. The plan's must_haves truth #3 says "see active **chat sessions**" but the plan as written does not distinguish chat from orchestrator runs from autonomous admin sessions.

**Suggested fix:** Add a `kind: "chat" | "run" | "admin"` field to each `budget.jsonl` line and have `loadActiveSessions` filter on it. Default `kind: "admin"` if missing for back-compat with existing autonomous-loop files.

---

### M4. The "worst session" chip in Task 7 has no defined exclusion for autonomous and orchestrator sessions

**Affects:** Task 7 (Step 5)
**Severity:** MEDIUM

`list_chat_session_budgets()` is described as walking `~/.relay/sessions/<id>/budget.jsonl` files without filtering by kind. The chip will fire for autonomous/orchestrator sessions too despite the function name. Resolve M3 first; the same `kind` field fixes this. Add an explicit assertion in the test scaffold that an `admin-*` budget file does NOT show up in `list_chat_session_budgets` output.

---

### M5. Threshold-feed bridge handoff scenario isn't tested

**Affects:** Task 5, Phase 2 contract documentation
**Severity:** MEDIUM

The bridge contract says "A handoff creates a NEW sessionId in the destination provider. Its tracker starts at 0% and never re-emits the source session's thresholds." Task 5's tests assert that crossing 90% emits exactly one event — but they do NOT assert the handoff scenario (two sessions both crossing 90%, two separate events with distinct sessionIds).

**Suggested fix:** Add to Task 0 step 2 a test case that creates two trackers (different sessionIds), records each crossing 90%, asserts both feed entries with distinct `metadata.sessionId` values. This is the "pre-execution proof" Phase 2 can rely on.

---

### M6. End-to-end test that would catch a regression in "% live in TUI/GUI/CLI" doesn't exist

**Affects:** Task 12 (Phase gate), Task 0 (test scaffolds)
**Severity:** MEDIUM

All Task 0 tests are unit-tier. There is no test that wires: adapter usage parsing → orchestrator dispatch → tracker.record → budget.jsonl → harness-data::load_session_budget → returns the right `pct`. A regression in the middle of this chain (e.g. `OrchestratorV2.dispatch` refactor breaks `result.tokenUsage` propagation) will not be caught. Task 12 step 7 says "manually verify (or document in this task's summary how it was automated-verified)" — kicking the can.

**Suggested fix:** Add `test/integration/session-budget-end-to-end.test.ts` under Task 0 that constructs an `OrchestratorV2` with a fake `CommandInvoker`, dispatches with hand-crafted usage, and asserts `<tmpdir>/sessions/run-<runId>/budget.jsonl` contains the expected `cumulativeUsed`. If a Rust+TS integration is too costly, the equivalent in Rust closes the loop on the Rust side.

---

### M7. Plan does not enforce that the threshold-feed-bridge's `metadata.pct` precision matches the doc

**Affects:** Task 5
**Severity:** MEDIUM

The doc shows `"pct": "91.23"`. The bridge code says `pct: evt.pct.toFixed(2)`. There's no test that asserts the precision is 2 decimal places. A future change to `toFixed(3)` would silently drift from the contract.

**Suggested fix:** Add to Task 0 step 2's test: `assert entry.metadata.pct.match(/^\d+\.\d{2}$/)`. One-line addition.

---

### M8. Phase-2 handoff contract says new sessions start at 0% but doesn't actually require it in code

**Affects:** Task 5 (D-03 documentation), Task 4 (tracker pool)
**Severity:** MEDIUM

The contract reads as if Phase 1 enforces the 0% guarantee, when in fact Phase 1 just relies on the consumer to not re-use IDs. If Phase 2 reuses an ID with a pre-existing budget.jsonl, replay() loads prior state.

**Suggested fix:** Sharpen the contract doc to say "Phase 1 does not guarantee 0% on a new session — it guarantees `firedThresholds` is replayed from disk. Phase 2 must use unique sessionIds to satisfy the 0% start requirement." OR add a guard in `SessionTrackerPool.get` that warns if a brand-new session-id has a pre-existing budget.jsonl with non-zero cumulativeUsed. Either is acceptable.

---

### M9. `gui/src/lib/modelContextWindows.ts` is a manual mirror with no test guarding drift

**Affects:** Task 7 (Step 4)
**Severity:** MEDIUM

Task 7 Step 4 documents the duplication of the model-context-window table but adds no test that the two TS copies have the same keys/values. Drift will be silent.

**Suggested fix:** Add a test in `gui/src/lib/modelContextWindows.test.ts` that imports BOTH copies and asserts deep-equality of the table. Or have the GUI-side copy `import` from the canonical source if vite config allows reaching out of the gui workspace.

---

## LOW-SEVERITY FINDINGS

### L1. Sub-800 LOC discipline estimate for PR 2 is optimistic

PR 2 bundles Tasks 2 + 3 + 4 + 5 + 6, plan estimates ~700 LOC. Realistic walk: Task 2 (~160), Task 3 (150-300), Task 4 (~170), Task 5 (~220), Task 6 (~160) = ~860-1010 LOC, slightly over budget. Note in wave structure that PR 2 may need to split into PR-2a (Tasks 2 + 5 + design doc) and PR-2b (Tasks 3 + 4 + 6) IF the diff trends over 800.

### L2. Task 4 dead code: unused `const cache` variable

In Task 4 Step 2, `const cache = (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0)` is computed but never passed to `tracker.record()` because `inputTokens` already includes cache. Delete the unused lines to keep the code tight.

### L3. Task 11's `loadActiveSessions` pseudocode is incomplete

Step 1 punts the body with `// ... readdir, filter by mtime ...`. Add: "Guard with `if (!existsSync(root)) return []` before readdir. Catch and log per-file parse errors so a single bad file doesn't poison the whole list."

### L4. Plan never enumerates which tests are RED in Wave 0 vs which are stubbed

Task 0's verify does a single `! grep -q "0 failed"` check — passes if ANY test fails. Update verify to assert each test file has at least one failing test individually (per-file grep), so a single failing test can't mask 8 accidentally-passing or skipped tests.

### L5. Plan's `<output>` requires non-standard SUMMARY filename

`01-token-usage-telemetry-context-bar-01-SUMMARY.md` is non-standard (typically `01-SUMMARY.md`). The Phase 2 handoff contract block references this filename; if the executor's summary tool defaults to `01-SUMMARY.md`, Phase 2's planner will look for the wrong file. Verify with the orchestrator that this long-form filename matches the GSD summary template.

### L6. `agentResultJsonSchema` mentioned in Task 1 but plan doesn't say where to find it

Task 1 says use `agentResultJsonSchema` but doesn't reference `zod-to-json-schema` (which is the standard conversion tool). Add explicit conversion command or skip the schema and just verify the simpler hypothesis by passing a minimal `{}` schema.

---

## Goal-coverage matrix

| Goal element | Plan tasks | Status |
|---|---|---|
| Live "% of context window consumed" — TUI | Task 9 | Conditionally covered (broken by H1 — TUI dispatch path doesn't record) |
| Live "% of context window consumed" — GUI | Tasks 7, 10 | Covered |
| Live "% of context window consumed" — CLI status | Task 11 | Covered (M3 conflates with autonomous) |
| Both Claude AND Codex | Tasks 1, 3, 4, 10 | Covered (with M2 caveat for INCONCLUSIVE branch) |
| Threshold events at 75/90/95 on channel feed | Task 5 | Covered |
| Phase 2 90% nudge subscribes deterministically | Task 5 doc + Phase-2 contract block | Covered (M5, M8 sharpen the contract) |
| Survives session restart | Task 6 (load_session_budget reads disk), Task 8 manual check | Covered |

---

## Requirements coverage (REQ-1.1 through REQ-1.9)

The plan's source_audit table maps every REQ-1.x to a task. All 9 sub-requirements appear in the `requirements:` frontmatter and in at least one task's `<requirements>`. **No orphans.** Note: research.md used REQ-1 through REQ-8 numbering and the plan re-numbered to REQ-1.1 through REQ-1.9 — that's a renumbering, not a gap, but it's undocumented.

---

## Phase 2 contract solidity assessment

The Phase 2 handoff contract block is the strongest part of the plan:

- **File path:** explicit (`~/.relay/channels/<channelId>/feed.jsonl`)
- **Filter expression:** explicit, machine-checkable
- **Stable fields:** enumerated with types
- **Per-session vs per-channel semantics:** stated (per-session)
- **0% start guarantee:** stated, but enforcement is by convention not code (M8)
- **Single-emit semantics:** stated, backed by `TokenTracker.firedThresholds` replay
- **Schema bumps:** stated (coordinated update required)
- **Reference doc:** `docs/design/context-threshold-events.md` exists in Task 5

**Verdict:** STRONG. With M5 and M8 addressed, Phase 2's planner has everything they need.

---

## Hidden assumptions surfaced

1. **Task 4** assumes `agent.capability.model` exists. Step 2's fallback is described but unverified — silently uses 200_000 default, miscalibrating Opus 4.7 sessions to ~5x of actual.
2. **Task 7** assumes `tokenPctSeverity` is exported / extractable from `AutonomousSessionHeader.tsx:258-263`.
3. **Task 10** assumes `cli_bin()`, `augmented_child_path()`, `final_session_id` are accessible variables in the chat-event closure scope at line ~2200.
4. **Task 12 step 7 #1** ("Telemetry survives a process restart") is verified manually only — no automated test closes a tracker, opens a new one with the same sessionId, and asserts pct survives.

---

## Recommendation

**Status: NEEDS_REVISION.**

Fix the two HIGH-severity findings (H1: TUI dispatch parity; H2: PR ordering / Wave 0 compile gap) before execution begins. The MEDIUM findings can be batched into a single revision pass — most are 1-3 line changes to existing tasks. The LOW findings are polish.

After revision, the plan is execution-ready. The structure, source-audit, locked decisions, and Phase 2 contract are all genuinely good. The verification process surfaced gaps in *coverage of dispatch parity* and *PR-merge mechanics*, not in design.
