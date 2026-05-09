# Phase 1 — Plan Re-check (iteration 3)

**Verified:** 2026-05-09
**Plan:** `.planning/phases/01-token-usage-telemetry-context-bar/01-PLAN.md` (post-revision)

## VERDICT: READY

The revision substantively addresses both HIGH-severity blockers and all 9 MEDIUM findings. PR-1 will compile in isolation, TUI dispatch parity is now BLOCKING and unconditional, and the contract sharpening (M3, M4, M5, M7, M8) is real code-and-test, not just doc-level handwaving. No new HIGH-severity issues introduced. Plan is execution-ready.

## Spot-check observations

**1. H1 — TUI dispatch parity (CLOSED).** Confirmed against source: `tui/src/main.rs:2686` does `Command::new(&claude_bin)`, parse loop at `:2704`, `Some("result")` arm at `:2751-2769`, `child.wait()` at `:2779`. Task 10b's diff lands `let mut captured_usage` at `:2700`, captures `json.get("usage")` in the `result` arm, and shells out after `:2779` — every line number in the plan matches reality. Unconditional language is in place ("BLOCKING for Task 9 acceptance"). Task 9's `<done>` and `<behavior>` both explicitly require "TUI-launched chat session populates `~/.relay/sessions/<sid>/budget.jsonl` and updates the bar live."

**2. H2 — PR-1 compile gap (CLOSED).** Option B adopted. PR-1 = Tasks 0 + 1 + 2 + 6, totaling ~750 LOC. Task 0's `<done>` removes the "skeleton type stubs (acceptable)" hedge and instead asserts `pnpm typecheck && cargo check --workspace --locked` BOTH pass independently. Each test file in Task 0 references types that land in the same PR. Compile path verified.

**3. M1 spot-check (schemaVersion drift) — closed.** Task 0 step 10 contains `assert_eq!(deserialized.schema_version, 1)` AND `session_budget_v2_round_trip()` that hand-writes `version: 2` and asserts NO silent downgrade. Task 0 step 7 adds the TS-side `version: 2` parse-failure assertion. Both halves of the drift guard are real test code.

**4. M3 spot-check (kind discriminator) — closed in substance.** `kind` field plumbed end-to-end: TS schema in Task 2 (`SessionKind = z.enum(["chat", "run", "admin"])`), Rust enum in Task 6, orchestrator dispatch passes `"run"`, `rly chat record-usage` defaults `"chat"`, `loadActiveSessions` filters `parsed.kind !== "chat"`, `list_chat_session_budgets` filters server-side, M4 test `list_chat_session_budgets_filters_admin` present. Real fix.

**5. M5/M7/M8 spot-check — closed.** Multi-tracker test (M5), `/^\d+\.\d{2}$/` precision regex (M7), `SessionTrackerPool.get` soft-warning probe (M8). The handoff contract doc (Task 5) and `<phase_2_handoff_contract>` block both carry the M8 sharpening verbatim.

## New-risk check

- **Task 10b scope:** ~230 LOC (crate scaffolding + capture/spawn + Cargo.toml updates). PR-3 totals ~560 LOC (Task 7 ~250 + Task 9 ~80 + Task 10b ~230). Under 800. Split contingency documented.
- **`crates/relay-paths` circular-dep check:** New crate consumes only `std`; `tui` and `gui-src-tauri` consume it. `harness-data` does not depend on `relay-paths`, and vice versa. No cycle.
- **Acceptance vagueness:** New Task 10b `<done>` is concrete (sample `budget.jsonl` with `kind: "chat"`, `cumulativeUsed`, `cli_bin()` shared-crate location). Task 9's amended acceptance is testable.
- **Goal coverage still holds:** All 9 REQ-1.x identifiers remain in `requirements:` frontmatter and source_audit. REQ-1.4 cites both Task 9 and Task 10b. Phase 2 contract block preserved.

## LOW-severity polish (non-blocking)

- **Task 10b Step 1 naming inaccuracy:** The plan says "Move `cli_bin()` similarly (currently in `gui/src-tauri/src/lib.rs`; one-liner `which("rly")` style helper)." But there is no function named `cli_bin` in that file — the existing helpers are `resolve_rly_bin`, `resolve_rly_invocation`, `cli_run`, `cli_json`, `rly_invocation_debug` (around `:625-660`). Task 10b is asking the executor to **create** `cli_bin()` as a thin wrapper around the existing plumbing when hoisting to `crates/relay-paths`. Recommend a one-line clarification: "Create a new `pub fn cli_bin() -> PathBuf` in `crates/relay-paths` that wraps the existing `resolve_rly_invocation`/`resolve_rly_bin` plumbing currently in `gui/src-tauri/src/lib.rs:625-660`." Not a blocker — executor will figure out from context.
- **Task 10 Step 3 inherits the same naming inaccuracy.** Align with Task 10b's "to-be-created" framing.
- **`model_owned` plumbing in Task 10b Step 3:** Plan acknowledges this may need plumbing but doesn't estimate cost. Likely 5-10 LOC of `Arc::clone` before `std::thread::spawn`. Within budget; worth the executor checking before they start.
- **Filename consistency:** `<output>` says `01-SUMMARY.md` (per L5), but `files_modified` and wave structure don't enumerate it. Non-issue — the summary template is referenced via `<execution_context>` so the executor uses the correct template.

None of these block execution.
