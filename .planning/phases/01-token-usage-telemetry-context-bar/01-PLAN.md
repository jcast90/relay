---
phase: 01-token-usage-telemetry-context-bar
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  # Wave 0 — test scaffolds + spike + TS shape + Rust mirror (PR-1 bundle, see <wave_structure>)
  - test/agents/cli-agents-codex-usage-spike.test.ts
  - test/agents/cli-agents-claude-usage.test.ts
  - test/agents/cli-agents-codex-usage.test.ts
  - test/orchestrator/orchestrator-v2-token-usage.test.ts
  - test/budget/threshold-feed-bridge.test.ts
  - test/budget/session-tracker-pool.test.ts
  - test/cli/print-status-context.test.ts
  - test/domain/session-budget.test.ts
  - test/cli/chat-record-usage.test.ts
  - test/integration/session-budget-end-to-end.test.ts
  - gui/src/components/ContextWindowBar.test.tsx
  - gui/src/lib/modelContextWindows.test.ts
  - src/budget/token-tracker.ts
  - src/domain/session-budget.ts
  - src/domain/model-context-windows.ts
  - crates/harness-data/src/lib.rs
  # Wave 1 — adapter wiring + dispatch wiring + threshold-feed bridge
  - src/agents/cli-agents.ts
  - src/domain/agent.ts
  - src/budget/session-tracker-pool.ts
  - src/budget/threshold-feed-bridge.ts
  - src/orchestrator/orchestrator-v2.ts
  - docs/design/context-threshold-events.md
  # Wave 2 — dashboards (GUI + TUI)
  - gui/src-tauri/src/lib.rs
  - gui/src/api.ts
  - gui/src/types.ts
  - gui/src/lib/tokenSeverity.ts
  - gui/src/lib/modelContextWindows.ts
  - gui/src/components/ContextWindowBar.tsx
  - gui/src/components/CenterPane.tsx
  - gui/src/components/Sidebar.tsx
  - gui/src/styles.css
  - tui/src/ui.rs
  - tui/src/main.rs
  # Wave 3 — chat-mode parity + CLI surface + docs
  - src/cli/chat-record-usage.ts
  - src/cli/chat-context.ts
  - src/cli/print-status-context.ts
  - src/index.ts
  - README.md
  - docs/getting-started.md
autonomous: true
requirements:
  - REQ-1.1
  - REQ-1.2
  - REQ-1.3
  - REQ-1.4
  - REQ-1.5
  - REQ-1.6
  - REQ-1.7
  - REQ-1.8
  - REQ-1.9

must_haves:
  truths:
    - "User can see a percent-of-context bar in the GUI chat session detail view, live-updating as the session consumes tokens."
    - "User can see a percent-of-context bar in the TUI chat pane, live-updating on every poll tick, including for sessions launched from the TUI's own `Command::new(claude_bin)` chat dispatcher."
    - "User can run `rly status` and see active chat sessions with `ctx N% (used / total)` line per session."
    - "GUI sidebar / header shows a 'worst session' chip when any active session is at >= 75% context."
    - "Telemetry survives a process restart — closing the GUI mid-session and re-opening shows the prior cumulative usage. Verified by an automated test (Task 12 step 7 #1), not just manual."
    - "Threshold events at 75 / 90 / 95 percent appear in the channel feed as `status_update` entries with `metadata.kind == 'context_threshold'`."
    - "The same feature works for both Claude and Codex sessions."
    - "`list_chat_session_budgets()` excludes autonomous (`admin-*`) and orchestrator (`run-*`) keyspaces — only entries with `kind == 'chat'` surface in the worst-session chip."
  artifacts:
    - path: "src/domain/session-budget.ts"
      provides: "Stable `SessionBudget` TS shape + zod schema + `schemaVersion: 1` constant + `kind: 'chat' | 'run' | 'admin'` discriminator"
      contains: "export interface SessionBudget"
    - path: "src/domain/model-context-windows.ts"
      provides: "Hard-coded `MODEL_CONTEXT_WINDOWS` lookup table + `resolveContextWindow(modelName?)` fallback"
      contains: "export const MODEL_CONTEXT_WINDOWS"
    - path: "src/budget/session-tracker-pool.ts"
      provides: "`SessionTrackerPool` — keyed map of TokenTracker per chat sessionId"
      contains: "export class SessionTrackerPool"
    - path: "src/budget/threshold-feed-bridge.ts"
      provides: "`attachThresholdFeed(tracker, channelId, store, opts)` — forwards subset of THRESHOLDS to channel feed"
      contains: "export function attachThresholdFeed"
    - path: "crates/harness-data/src/lib.rs"
      provides: "`SessionBudget` Rust struct mirror (with `kind` field) + `load_session_budget(session_id, total)` reader"
      contains: "pub struct SessionBudget"
    - path: "gui/src/lib/tokenSeverity.ts"
      provides: "Shared `tokenPctSeverity(pct)` util — extracted from AutonomousSessionHeader so the chip and bar both depend on the named export, not a copy-paste."
      contains: "export function tokenPctSeverity"
    - path: "gui/src/components/ContextWindowBar.tsx"
      provides: "GUI percent-bar React component, severity-colored, polled per refreshTick"
      contains: "export function ContextWindowBar"
  key_links:
    - from: "src/agents/cli-agents.ts ParsedProviderResult"
      to: "src/domain/agent.ts AgentResult.tokenUsage"
      via: "adapter `usage` field flows through normalizePayload into AgentResult"
      pattern: "tokenUsage\\?:"
    - from: "src/orchestrator/orchestrator-v2.ts dispatch()"
      to: "TokenTracker.record(input, output)"
      via: "after `result = await agent.run(request)` resolves on success; writes with `kind: 'run'`"
      pattern: "tokenTracker\\.record\\("
    - from: "TokenTracker.onThreshold"
      to: "ChannelStore.postEntry"
      via: "src/budget/threshold-feed-bridge.ts post-filter for [75, 90, 95]"
      pattern: "context_threshold"
    - from: "gui/src-tauri/src/lib.rs `get_chat_session_budget` Tauri cmd"
      to: "crates/harness-data::load_session_budget"
      via: "shared crate read on every refreshTick"
      pattern: "load_session_budget"
    - from: "tui/src/ui.rs draw_chat"
      to: "harness_data::load_session_budget"
      via: "LineGauge widget rendered below chat title"
      pattern: "LineGauge"
    - from: "gui/src-tauri/src/lib.rs chat-event spawner"
      to: "rly chat record-usage --session ... --input N --output N --kind chat"
      via: "shell-out from streaming Rust loop into TS-side TokenTracker (chat-mode parity per D-04)"
      pattern: "record-usage"
    - from: "tui/src/main.rs:2627-2779 Claude chat worker loop"
      to: "rly chat record-usage --session ... --input N --output N --kind chat"
      via: "result-arm capture mirroring the GUI's, shells out via cli_bin() + augmented_child_path() (TUI dispatch parity per D-04 / H1 fix)"
      pattern: "record-usage"
---

<revision_log>
**Iteration 2 — 2026-05-09.** All HIGH and MEDIUM findings from `01-CHECK.md` addressed. Summary by finding:

- **H1 (TUI dispatch parity):** Original plan's Task 10 Step 4 treated TUI shell-out as conditional — verification confirmed `tui/src/main.rs:2627-2779` spawns Claude directly via `Command::new(&claude_bin)` and does NOT route through `rly`. Fix: extracted as a NEW dedicated `Task 10b` (BLOCKING for Task 9 acceptance). Step-by-step diff: hoist `augmented_child_path()` and a tiny `cli_bin()` companion into a shared `crates/relay-paths` crate (with the LOC implication flagged in PR-3); add `let mut captured_usage` before the parse loop at `:2700`; capture `json.get("usage")` in the `Some("result")` arm at `:2751`; after `child.wait()` resolves, if both `captured_usage` and `session_id` are `Some`, fire-and-forget `rly chat record-usage` via `Command::new(cli_bin()).env("PATH", augmented_child_path())`. Conditional language removed everywhere. Acceptance criteria for Task 9 amended to require: "TUI-launched chat session populates `~/.relay/sessions/<sid>/budget.jsonl` and updates the bar live."
- **H2 (PR-1 compile gap):** Adopted Option B from the review. PR-1 now bundles Tasks 0 + 2 + 6 (test scaffolds + TS shape + Rust mirror) so every test compiles against landed types. PRs 2-5 renumbered. Each PR independently passes `pnpm typecheck && pnpm test && cargo check --workspace --locked`. "Skeleton type stubs (acceptable)" language removed from Task 0's `<done>`. PR-2 estimate re-walked: Task 3 (~250) + Task 4 (~170) + Task 5 (~220) + design doc (~70) = ~710 LOC, with PR-2a/PR-2b split documented as the contingency if it trends over 800.
- **M1 (schemaVersion drift):** Rust fixture test now explicitly asserts `assert_eq!(deserialized.schema_version, 1)`. Added a second Rust test that round-trips `version: 2`. Added a TS-side `version: 2` test that asserts the parser errors with a clear message.
- **M2 (A1 spike machine-readable):** Task 1's `01-SPIKE-A1.md` MUST emit a `STREAM_FLAG=<name|NONE>` line. Task 3's INCONCLUSIVE branch now `grep`s it: `STREAM_FLAG=NONE` → Branch A only + stderr warning when `parsed.usage` is undefined; otherwise both paths.
- **M3 (kind discriminator):** Added `kind: "chat" | "run" | "admin"` to `SessionBudget` (TS + Rust). Default `kind: "admin"` for back-compat with autonomous-loop files. `loadActiveSessions()` filters by `kind`. The orchestrator's dispatch now writes `kind: "run"`; chat-mode `record-usage` writes `kind: "chat"`; `RepoAdminSession`'s tracker writes `kind: "admin"` (or omits — back-compat default covers it).
- **M4 (worst-session chip filter):** `list_chat_session_budgets()` filters `kind === "chat"`. Added an explicit test asserting an `admin-*` budget file does NOT appear.
- **M5 (handoff scenario test):** Added to Task 0 step 2 a multi-tracker test that creates two trackers (different sessionIds), records each crossing 90%, and asserts both feed entries with distinct `metadata.sessionId` values.
- **M6 (end-to-end test):** Added `test/integration/session-budget-end-to-end.test.ts` that wires adapter usage parsing → orchestrator dispatch → tracker.record → budget.jsonl → harness-data::load_session_budget → returns expected `pct`. Lives in Wave 0; goes GREEN once Tasks 3+4+6 land.
- **M7 (pct precision regex):** Added to Task 0 step 2: `assert(entry.metadata.pct.match(/^\d+\.\d{2}$/))`.
- **M8 (Phase-2 contract sharpening):** Updated `<phase_2_handoff_contract>` to clarify Phase 1 does NOT guarantee 0% on a new sessionId; Phase 1 guarantees `firedThresholds` is replayed from disk. Phase 2 must use unique sessionIds for the 0% start. Added a soft warning in `SessionTrackerPool.get` when a brand-new sessionId surfaces a pre-existing budget.jsonl with non-zero `cumulativeUsed`.
- **M9 (model table drift test):** Added `gui/src/lib/modelContextWindows.test.ts` that imports both copies and asserts deep-equality of the table (recommended over reaching out of the gui workspace via vite, since AGENTS.md flags GUI workspace boundaries).
- **L1:** PR-2 wave structure note added: split into PR-2a / PR-2b if diff trends >800 LOC.
- **L2:** Removed unused `const cache = ...` from Task 4 Step 2.
- **L3:** Task 11 `loadActiveSessions` now begins with `if (!existsSync(root)) return []` and catches per-file parse errors so one bad file doesn't poison the list.
- **L4:** Task 0 verify replaced the global `! grep "0 failed"` with per-file failing-test assertions.
- **L5:** Standardized to `01-SUMMARY.md`. `<phase_2_handoff_contract>` and `<output>` updated.
- **L6:** Task 1 step 1 now uses `zod-to-json-schema` explicitly OR documents the simpler `{}` fallback hypothesis test.

**Hidden-assumption fixes:**
- Task 4: Hard-asserts `agent.capability.model` (or `agent.model`) is set; throws loudly with a `[budget] missing model on agent capability` message rather than silently defaulting. Added a unit test that asserts the throw.
- Task 7: Extracted `tokenPctSeverity` to `gui/src/lib/tokenSeverity.ts` as a shared util; both the chip and the bar import from the named export.
- Task 10: Documented the `cli_bin()`, `augmented_child_path()`, `final_session_id`, `model_thread`, `channel_id_thread` accessor scoping. Where they are not currently in scope at the chat-event closure sites (TUI especially), Task 10b adds a sub-step to plumb them in.
- Task 12 step 7 #1: Replaced "manually verify" with an automated 10-line vitest test (`test/budget/tracker-restart-replay.test.ts`).
</revision_log>

<phase_goal>
Per-session context-window telemetry (`% of context used`) live across TUI, GUI, and CLI status surfaces, populated by both Claude and Codex adapters, persisted at `~/.relay/sessions/<sessId>/budget.jsonl`, and emitting threshold events at 75 / 90 / 95 % on the channel feed for Phase 2's handoff trigger to subscribe to.
</phase_goal>

<objective>
Plumb provider token-usage from CLI adapters through the orchestrator into the existing `TokenTracker`, persist it under `~/.relay/sessions/<sessId>/budget.jsonl`, and render it in three independent dashboards. Widen the canonical threshold list from `[50, 60, 85, 95, 100]` to `[50, 60, 75, 85, 90, 95, 100]` (D-01) and post a filtered `[75, 90, 95]` subset to the channel feed for chat sessions. Land a stable `SessionBudget` schema (TS + Rust mirror, `schemaVersion: 1`, `kind: "chat" | "run" | "admin"`, D-06) that Phase 2's planner can subscribe to.

**Purpose:** Today Relay's only signal that a session is about to exhaust its context is the agent silently misbehaving or refusing. The autonomous-session pipeline already has every piece needed (`TokenTracker`, threshold-event bus, `budget.jsonl` persistence, GUI severity tiers); this phase plumbs the same pipes for chat sessions and surfaces the result on every dashboard, including for sessions launched from the TUI's own `Command::new(claude_bin)` chat dispatcher (a third dispatch path that the original plan revision missed). It is the prerequisite for Phase 2's handoff feature, whose 90% nudge subscribes to a threshold event this phase emits.

**Output:** A wired-up token-usage signal that survives process restart, renders identically across CLI/TUI/GUI for all three dispatch paths (orchestrator, GUI chat-event loop, TUI chat-event loop), fires deterministic threshold events on the channel feed, and ships with cargo + vitest test coverage.

**User story:** _As a Relay user running a Claude or Codex chat session, I want to see how close I am to exhausting the context window in every place I look at the session (terminal, TUI, GUI), so that I can decide to hand off, wind down, or compact before the agent starts misbehaving silently._
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/ROADMAP.md
@.planning/phases/01-token-usage-telemetry-context-bar/01-RESEARCH.md
@.planning/phases/01-token-usage-telemetry-context-bar/01-CHECK.md
@.planning/codebase/ARCHITECTURE.md
@.planning/codebase/STRUCTURE.md
@.planning/codebase/STACK.md
@.planning/codebase/INTEGRATIONS.md
@.planning/codebase/CONVENTIONS.md
@.planning/codebase/TESTING.md
@.planning/codebase/CONCERNS.md
@.planning/notes/handoff-feature-design.md
@AGENTS.md
@CLAUDE.md
@src/budget/token-tracker.ts
@src/agents/cli-agents.ts
@src/orchestrator/orchestrator-v2.ts
@src/domain/agent.ts
@src/cli/chat-context.ts
@src/orchestrator/repo-admin-session.ts
@gui/src/components/AutonomousSessionHeader.tsx
@crates/harness-data/src/lib.rs
@tui/src/ui.rs
@tui/src/main.rs
@gui/src-tauri/src/lib.rs

<locked_decisions>
The following decisions are LOCKED — execute them exactly as specified. Do not re-litigate.

- **D-01 (thresholds):** Widen `THRESHOLDS` in `src/budget/token-tracker.ts` to `[50, 60, 75, 85, 90, 95, 100]` (additive — preserves `60` for `RepoAdminSession`'s memory-shed subscriber). Threshold-feed bridge filters to `[75, 90, 95]` for chat sessions.
- **D-02 (per-session):** `SessionBudget` is keyed by chat `sessionId`. A channel may host multiple sessions over its lifetime; each gets its own budget file at `~/.relay/sessions/<sessId>/budget.jsonl`.
- **D-03 (Phase-2 handoff contract):** A handoff creates a new session id in the destination provider, and its tracker starts at 0%. Document this in the threshold-bridge metadata contract — Phase 2's planner will rely on it. Phase 1 does not enforce the 0% guarantee in code; it relies on Phase 2 minting unique sessionIds. See M8 mitigation (soft warning) below.
- **D-04 (chat-mode parity):** Add a TS-side recording entry point (`rly chat record-usage --session <id> --input <n> --output <n> [--kind chat] [--model <name>] [--channel <id>]`) that the GUI's chat-event Rust loop, the TUI's chat-event Rust worker (`tui/src/main.rs:2627-2779`), and any future TUI chat-mode dispatcher all shell out to. All record into the same `TokenTracker` so persistence shape is identical regardless of dispatch path.
- **D-05 (model context-window table):** Live in `src/domain/model-context-windows.ts`; mirror the constant (or a fallback table) into Rust if it is needed by `harness-data` callers. Default to 200_000 with a stderr warning when model is unrecognized. Mirror the GUI-side table at `gui/src/lib/modelContextWindows.ts`; a drift test (`gui/src/lib/modelContextWindows.test.ts`) imports both and asserts deep-equality (M9).
- **D-06 (schemaVersion + kind):** Introduce `schemaVersion: 1` AND a `kind: "chat" | "run" | "admin"` discriminator on `SessionBudget`. Default `kind: "admin"` when missing for back-compat with existing autonomous-loop files. Do not extend versioning to other `~/.relay/` artifacts in this phase.
- **D-07 (A1 spike):** First task in execution is a small Codex `--output-schema` spike to confirm the response JSON includes a top-level `usage` block. If it does not, fall back to parsing the JSONL event stream's last `turn.completed.usage`. Spike output MUST include a machine-readable `STREAM_FLAG=<name|NONE>` line so Task 3's INCONCLUSIVE branch can `grep` it deterministically (M2). Mark the spike task with `assumption_check: A1`.
</locked_decisions>

<interfaces>
<!-- Key contracts the executor will implement against. Extracted directly from source. -->
<!-- Executor uses these as-is — no codebase exploration needed. -->

From `src/domain/agent.ts:108-115` (existing AgentResultSchema — extend with optional tokenUsage):
```typescript
export const AgentResultSchema = z.object({
  summary: z.string().min(1),
  evidence: z.array(z.string()),
  proposedCommands: z.array(z.string()),
  blockers: z.array(z.string()),
  failureClassification: FailureClassificationSchema.optional(),
  phasePlan: z.unknown().optional(),
});
```

From `src/budget/token-tracker.ts:21` (THRESHOLDS — widen per D-01):
```typescript
export const THRESHOLDS = [50, 60, 85, 95, 100] as const;
// → MUST become [50, 60, 75, 85, 90, 95, 100] as const;
```

From `src/budget/token-tracker.ts:126` (record API — already correct shape, no change):
```typescript
record(inputTokens: number, outputTokens: number): void
```

From `src/budget/token-tracker.ts:218-223` (onThreshold — subscribe surface used by threshold-feed-bridge):
```typescript
onThreshold(listener: ThresholdListener): () => void
// ThresholdEvent: { sessionId, used, total, pct, threshold }
```

From `src/agents/cli-agents.ts:84-94` (ParsedProviderResult — extend with usage):
```typescript
interface ParsedProviderResult {
  rawResponse: string;
  parsed: {
    summary: string;
    evidence: string[];
    proposedCommands: string[];
    blockers: string[];
    failureClassification?: FailureClassification;
    phasePlan?: PhasePlan;
  };
  // → ADD: usage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number };
}
```

From `src/agents/cli-agents.ts:483-485` (Claude streaming — capture obj.usage on result):
```typescript
} else if (obj.type === "result" && typeof obj.result === "string") {
  resultText = obj.result;
  // → ADD: if (obj.usage && typeof obj.usage === "object") capturedUsage = obj.usage;
}
```

From `src/agents/cli-agents.ts:332` (Codex buffered — parse top-level usage from response.json per A1 spike):
```typescript
const rawResponse = await readFile(outputPath, "utf8");
// → after JSON.parse, lift response.usage if present
```

From `src/orchestrator/orchestrator-v2.ts:501-547` (dispatch — record after agent.run resolves, write `kind: "run"`):
```typescript
try {
  const result = await agent.run(request);
  // → ADD: if (result.tokenUsage && run.channelId) {
  //          tokenTracker.record(result.tokenUsage.inputTokens, result.tokenUsage.outputTokens);
  //        }
  // ... existing code
}
```

From `src/orchestrator/repo-admin-session.ts:448-461` (existing tracker pattern — `admin-${alias}` sessionId, will be tagged `kind: "admin"` via tracker construction option):
```typescript
this.tokenTracker = new TokenTracker(`admin-${this.alias}`, ceiling, {
  rootDir: dirname(this.logDir),
});
this.unsubscribeTokenTracker = this.tokenTracker.onThreshold((evt) =>
  this.handleThresholdEvent(evt)
);
```

From `gui/src-tauri/src/lib.rs:3111-3135` (existing read_session_budget_used — relocate the logic into harness-data per D-05 mirror discipline):
```rust
fn read_session_budget_used(session_id: &str) -> u64 { ... last_cumulative ... }
```

From `gui/src-tauri/src/lib.rs:681` (existing `augmented_child_path()` — TUI fix copies / shares this; H1):
```rust
fn augmented_child_path() -> String { /* shell-PATH harvest with launchd-strip workaround */ }
```

From `crates/harness-data/src/lib.rs` `harness_root()` and `load_*` patterns — mirror these for `load_session_budget`.

From `gui/src-tauri/src/lib.rs:1960-2300` (existing GUI chat-event Rust loop — D-04 hook point):
- Inside the `for line in reader.lines()` parse arm, when `json["type"] == "result"` (or final stream-event), shell out via `rly chat record-usage --session <session_id> --input N --output N --kind chat --model <model>`.
- Pattern to mirror: `cli_json(&["chat", "system-prompt", "--channel", ...])` already in this file.

From `tui/src/main.rs:2627-2779` (TUI chat worker — H1 fix point; verified to spawn Claude directly via `Command::new(&claude_bin)` at `:2686` — does NOT route through `rly`):
- Inside the `for line in reader.lines()` parse arm (`:2704`), the `Some("result")` arm at `:2751-2769` extracts `session_id` and the result text but DOES NOT extract `usage`.
- Task 10b adds: capture `json.get("usage")` into a `captured_usage` Option declared before the loop at `:2700`; after `child.wait()` resolves at `:2779`, if both `captured_usage` and `session_id` are `Some`, fire-and-forget `Command::new(cli_bin())` with `record-usage` args, `.env("PATH", augmented_child_path())`. `cli_bin()` and `augmented_child_path()` currently live in `gui/src-tauri/src/lib.rs`; Task 10b hoists them into a shared `crates/relay-paths` (or similar) crate. PR-3 boundary impact noted in `<wave_structure>`.
</interfaces>

<source_audit>
## Multi-source coverage audit

| Source item                                                              | Type     | Plan/Task                  | Coverage   |
|--------------------------------------------------------------------------|----------|----------------------------|------------|
| ROADMAP Phase 1 Goal: live `% of context window consumed` per session    | GOAL     | Tasks 5, 6, 7, 8, 11       | covered    |
| ROADMAP Phase 1 Acceptance: TUI shows bar (incl. TUI-launched chat)      | GOAL     | Tasks 9, 10b               | covered    |
| ROADMAP Phase 1 Acceptance: GUI shows bar                                | GOAL     | Tasks 7, 8                 | covered    |
| ROADMAP Phase 1 Acceptance: CLI surfaces in `rly status`                 | GOAL     | Task 11                    | covered    |
| ROADMAP Phase 1 Acceptance: telemetry survives session restart           | GOAL     | Tasks 4, 6, 12 step 7 #1   | covered    |
| ROADMAP Phase 1 Acceptance: 75/90/95 channel-feed events                 | GOAL     | Task 5                     | covered    |
| ROADMAP Phase 1 Acceptance: Claude AND Codex                             | GOAL     | Tasks 1, 3, 4              | covered    |
| REQ-1.1 Per-session token-usage signal in orchestrator                   | REQ      | Tasks 3, 4                 | covered    |
| REQ-1.2 Persist `~/.relay/sessions/{id}/budget.jsonl`                    | REQ      | Tasks 4, 6, 10, 10b        | covered    |
| REQ-1.3 Threshold events at 75/90/95 on channel feed                     | REQ      | Tasks 2, 5                 | covered    |
| REQ-1.4 TUI percent bar (works for TUI-launched chat)                    | REQ      | Tasks 9, 10b               | covered    |
| REQ-1.5 GUI percent bar + worst-session chip (kind=chat filtered)        | REQ      | Tasks 7, 8                 | covered    |
| REQ-1.6 CLI `rly status` + session listings                              | REQ      | Task 11                    | covered    |
| REQ-1.7 Stable SessionBudget schema TS + Rust mirror (with kind)         | REQ      | Tasks 2, 6                 | covered    |
| REQ-1.8 Tests — vitest + cargo + integration                             | REQ      | Tasks 0, 12 (gate)         | covered    |
| REQ-1.9 Threshold-event contract for Phase 2                             | REQ      | Tasks 5, 12                | covered    |
| RESEARCH: extend ParsedProviderResult.usage                              | RESEARCH | Task 3                     | covered    |
| RESEARCH: SessionTrackerPool keyed by sessionId                          | RESEARCH | Task 4                     | covered    |
| RESEARCH: threshold-feed-bridge subscriber                               | RESEARCH | Task 5                     | covered    |
| RESEARCH: extract processLine to pure helper for testability             | RESEARCH | Task 3                     | covered    |
| RESEARCH: ratatui LineGauge inline below chat title                      | RESEARCH | Task 9                     | covered    |
| RESEARCH: GUI ContextWindowBar mirroring AutonomousSessionHeader pattern | RESEARCH | Task 7                     | covered    |
| RESEARCH: serde fixture test for SessionBudget                           | RESEARCH | Task 6, Task 0 step 10     | covered    |
| RESEARCH: A1 spike — Codex --output-schema response.json shape           | RESEARCH | Task 1 (assumption_check)  | covered    |
| RESEARCH: model context-window table fallback to 200K                    | RESEARCH | Task 2                     | covered    |
| RESEARCH: don't define new ChannelEntryType                              | RESEARCH | Task 5 (status_update)     | covered    |
| D-01 widen THRESHOLDS to 7-element list                                  | CONTEXT  | Task 2                     | covered    |
| D-02 per-session granularity                                             | CONTEXT  | Task 4                     | covered    |
| D-03 Phase-2 handoff: new session id starts at 0%                        | CONTEXT  | Task 5 (metadata + docs)   | covered    |
| D-04 chat-mode parallel hook + parity (GUI + TUI)                        | CONTEXT  | Tasks 10, 10b              | covered    |
| D-05 model-context-windows.ts canonical home + drift test                | CONTEXT  | Tasks 2, 7 (drift test)    | covered    |
| D-06 schemaVersion: 1 + kind discriminator on SessionBudget              | CONTEXT  | Tasks 2, 6                 | covered    |
| D-07 Codex --output-schema A1 verification + STREAM_FLAG output          | CONTEXT  | Task 1                     | covered    |

**Result:** All source items mapped to a task. No gaps. No items deferred.
</source_audit>

</context>

<tasks>

<task type="auto">
  <name>Task 0: Test scaffolds — write all RED tests + serde fixtures (PR-1 bundle)</name>
  <files>
    test/agents/cli-agents-claude-usage.test.ts,
    test/agents/cli-agents-codex-usage.test.ts,
    test/orchestrator/orchestrator-v2-token-usage.test.ts,
    test/budget/threshold-feed-bridge.test.ts,
    test/budget/session-tracker-pool.test.ts,
    test/budget/tracker-restart-replay.test.ts,
    test/cli/print-status-context.test.ts,
    test/domain/session-budget.test.ts,
    test/cli/chat-record-usage.test.ts,
    test/integration/session-budget-end-to-end.test.ts,
    gui/src/components/ContextWindowBar.test.tsx,
    crates/harness-data/src/lib.rs (append `#[test]` block at end of `mod tests`)
  </files>
  <requirements>REQ-1.8</requirements>
  <action>
    Create the failing test scaffolds for every behavior this plan introduces. **All tests must currently fail** (RED). Each test asserts on the contract per the `<interfaces>` block, NOT on implementation details. Use vitest scripted-mode patterns from `.planning/codebase/TESTING.md` (per-test tmpdir + `RM_OPTS = { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }`).

    **PR-1 bundles Tasks 0 + 2 + 6 (per H2 fix):** Task 0's tests reference `SessionBudget`, `SessionTrackerPool`, `attachThresholdFeed`, `handleChatRecordUsage`, etc. Tasks 2 (TS shape) and 6 (Rust mirror) land in the same PR so `pnpm typecheck && cargo check --workspace --locked` pass independently. Implementation tasks (3, 4, 5, 7, 9, 10, 10b, 11) turn the RED tests GREEN incrementally as their PRs land.

    Test contents:

    1. **`test/budget/session-tracker-pool.test.ts`** — assert `SessionTrackerPool.get(sessionId, ceiling)` returns the same instance for the same sessionId, distinct instances for different ones; `closeAll()` flushes all trackers and clears the map. Add a test that asserts a `[budget]` warning is logged (spy on `console.warn`) when `get()` is called for a brand-new sessionId whose `~/.relay/sessions/<id>/budget.jsonl` already exists with a non-zero `cumulativeUsed` (M8 mitigation — soft warning).

    2. **`test/budget/threshold-feed-bridge.test.ts`** — wire a `TokenTracker` (over a tmp `~/.relay`) through `attachThresholdFeed(tracker, channelId, channelStore, { postThresholds: [75, 90, 95] })` and force a record that crosses 90%. Assert `feed.jsonl` gets exactly one new entry of shape `{ type: "status_update", metadata: { kind: "context_threshold", threshold: "90", pct: "...", used: "...", total: "...", sessionId: "..." } }`. Assert that crossing 50/60/85 does NOT emit (filtered).

       **Add (M5):** create TWO trackers (different sessionIds), record each crossing 90%, assert two distinct `feed.jsonl` entries with distinct `metadata.sessionId` values. This is the pre-execution proof Phase 2's handoff planner relies on.

       **Add (M7):** `assert(entry.metadata.pct.match(/^\d+\.\d{2}$/))` — pins the precision to two decimal places so a future drift to `toFixed(3)` is caught.

    3. **`test/agents/cli-agents-claude-usage.test.ts`** — extract `processStreamLine` (Task 3 will implement it as a pure exported function). Test: feed a hand-written `{"type":"result","result":"...","usage":{"input_tokens":1500,"output_tokens":250,"cache_read_input_tokens":3000}}` line; assert state captures `usage` with cache tokens summed into inputs. Test: feed `assistant` events with mid-stream usage and assert they are IGNORED (only `result` is authoritative — pitfall #2 from research).

    4. **`test/agents/cli-agents-codex-usage.test.ts`** — exercise `CodexCliAgent.invokeProvider` via the existing `cli-agents-env-overlay.test.ts` fake-invoker pattern. Inject a fake response.json containing `{ summary: "...", ..., usage: { input_tokens: 800, output_tokens: 120 } }` and assert `parsedResult.usage = { inputTokens: 800, outputTokens: 120 }`. Add a second test for the missing-`usage` case (older Codex versions): assert `parsedResult.usage === undefined`, no throw. Add a third test that simulates `STREAM_FLAG=NONE` from the spike (Task 1) and asserts a `[budget] Codex usage extraction unavailable` stderr warning when `parsed.usage` is undefined post-Codex-run (M2).

    5. **`test/orchestrator/orchestrator-v2-token-usage.test.ts`** — wire OrchestratorV2 over `ScriptedInvoker` (default scripted mode), inject a `SessionTrackerPool`, run a `dispatch` call whose returned `AgentResult` has a `tokenUsage` block, then assert `pool.get(sessionId).used > 0` AND `~/.relay/sessions/<sessId>/budget.jsonl` exists with one well-formed line containing `cumulativeUsed` AND the budget line carries `kind: "run"` (M3). Add a second test: dispatch with an Agent whose `capability.model` is undefined → expect a thrown error with message matching `/missing model/i` (hidden-assumption fix for Task 4).

    6. **`test/cli/print-status-context.test.ts`** — call the new `formatActiveSessionsBlock(sessions)` helper (extracted from `printStatus` in Task 11) with a hand-crafted list of `{ sessionId, channelId, pct, used, total, model }` and assert the output contains lines like `- sess-... (channel: ch-...) ctx 76% (152K / 200K tokens) — Sonnet 4.5`. No `~/.relay/` reads in this test — pure formatter. Add a second test for `loadActiveSessions` that asserts: (a) `kind: "admin"` and `kind: "run"` budgets are excluded, (b) only `kind: "chat"` budgets surface (M3 + M4), (c) when `~/.relay/sessions/` does not exist `loadActiveSessions()` returns `[]` without throwing (L3), (d) when one session file is malformed, the others still surface (L3).

    7. **`test/domain/session-budget.test.ts`** — round-trip a `SessionBudget` object through `JSON.stringify` → `JSON.parse` → `SessionBudgetSchema.parse`, assert all fields preserved including `schemaVersion: 1` and `kind: "chat"`. Assert that an object with `schemaVersion: 0` or missing-version FAILS (forces the migration awareness for future bumps). **Add (M1):** assert that `schemaVersion: 2` FAILS parse with a message containing `schemaVersion`. Assert that `kind` defaults to `"admin"` when missing (back-compat).

    8. **`test/cli/chat-record-usage.test.ts`** — exercise the new CLI subcommand handler. Run `handleChatRecordUsageCommand({ session, input, output, kind, model, channel? })` against a tmp `~/.relay/`; assert a tracker is created, `record()` is called, `budget.jsonl` is written with `kind: "chat"` (or whatever was passed). Assert that passing a `--channel <id>` triggers `attachThresholdFeed` so a >90% input fires a feed entry.

    9. **`gui/src/components/ContextWindowBar.test.tsx`** — RTL render with props `{ used: 150_000, total: 200_000, sessionId: "sess-1", model: "Sonnet 4.5" }`; assert text "ctx 75%" present, severity class `metric--tokens-warn` applied. Render with pct >= 90 → assert `metric--tokens-hot`. Render with pct >= 100 → assert `metric--tokens-overrun`. Mirror `gui/src/components/AutonomousSessionHeader.test.tsx` skeleton. Import `tokenPctSeverity` from `gui/src/lib/tokenSeverity.ts` (the shared util Task 7 extracts).

    10. **Rust serde fixture in `crates/harness-data/src/lib.rs`** — append a `#[test] fn session_budget_serde_fixture()` to the existing test mod (after `:2310` per research). Hand-write a JSON line:
       ```json
       {"schemaVersion":1,"kind":"chat","sessionId":"sess-x","used":42,"total":200000,"pct":0.021,"lastUpdated":"2026-05-09T00:00:00Z","modelName":"Sonnet 4.5"}
       ```
       Deserialize via `serde_json::from_str::<SessionBudget>`. **Explicitly assert** `assert_eq!(deserialized.schema_version, 1)` (M1 — guards against silent default-fallthrough). Add a second test `session_budget_v2_round_trip()` that hand-writes a `version: 2` line, asserts it deserializes with `schema_version == 2` (NOT silently downgraded to 1) — this is the drift guard. Add a third test `session_budget_load_from_jsonl()` that writes a fake `budget.jsonl` to `scoped_root().sessions/<id>/budget.jsonl` with three lines (each with `cumulativeUsed`) and asserts `load_session_budget("sess-x", 200_000).used == last_cumulative` and `pct == (used / total) * 100`.

    11. **`test/integration/session-budget-end-to-end.test.ts` (M6 — NEW):** wire the full chain: construct an `OrchestratorV2` with a fake `CommandInvoker` returning a hand-crafted Claude `result` line containing `usage`. Dispatch. Assert: (a) `<tmpdir>/.relay/sessions/run-<runId>/budget.jsonl` exists and contains a line with `cumulativeUsed` matching the input usage, (b) reading the file via a TS helper that mirrors `harness_data::load_session_budget` (or, more pragmatically, hand-parse the last JSON line) returns the expected `pct = (used / 200_000) * 100`. If TS+Rust integration in one test is too heavy, split into two: a Rust round-trip test in `crates/harness-data` (already covered by step 10) PLUS this TS-side test which asserts the JSONL line shape and `kind: "run"` field. Use `mkdtemp` + `RM_OPTS`; override `HOME` env var per the existing pattern in `cli-agents-env-overlay.test.ts`.

    12. **`test/budget/tracker-restart-replay.test.ts` (Task 12 step 7 #1 fix — NEW):** create a `TokenTracker` over a tmp `~/.relay`, record `(150_000, 0)` so cumulative = 150_000 (pct = 75% on a 200K ceiling). Call `tracker.close()`. Construct a NEW `TokenTracker` with the same sessionId + ceiling; assert `tracker.used === 150_000` and `firedThresholds` includes `[50, 60, 75]` (NOT empty). This is the automated proof that "telemetry survives a process restart" — replaces the original plan's manual verification.

    13. **`gui/src/lib/modelContextWindows.test.ts` (M9 — NEW):** vitest test that imports both `gui/src/lib/modelContextWindows.ts` and `src/domain/model-context-windows.ts` (via a relative path `../../../../src/domain/model-context-windows.js` IF vite config allows reaching out of the gui workspace — verify in Task 7). Assert `MODEL_CONTEXT_WINDOWS` is `deepEqual` between the two. If reaching out is blocked, the test maintains the GUI-side copy as the source of truth and asserts each row matches the canonical-side copy by hard-coding the expected mapping. Either way: drift is caught by CI.

    Test fakes: in tests that touch `cli-agents.ts`, follow the existing pattern at `test/agents/cli-agents-env-overlay.test.ts` — a hand-rolled fake `CommandInvoker` whose `exec` returns a hand-built result; do NOT rely on `ScriptedInvoker.spawn` (it doesn't implement spawn — research Q13).

    All tests follow CONVENTIONS: two-space indent, double quotes, semicolons, trailing commas, ESM relative imports with `.js` extension.

    **Use this task to discover unknowns.** If during scaffolding you find a contract that doesn't match the `<interfaces>` block (e.g. `processStreamLine` signature in Task 3 needs different args), update the test and surface it in your task summary so the implementer sees the corrected contract.
  </action>
  <verify>
    <automated>
      pnpm test test/budget/session-tracker-pool.test.ts test/budget/threshold-feed-bridge.test.ts test/budget/tracker-restart-replay.test.ts test/agents/cli-agents-claude-usage.test.ts test/agents/cli-agents-codex-usage.test.ts test/orchestrator/orchestrator-v2-token-usage.test.ts test/cli/print-status-context.test.ts test/domain/session-budget.test.ts test/cli/chat-record-usage.test.ts test/integration/session-budget-end-to-end.test.ts 2>&1 | tee /tmp/wave0-tests.log;
      # L4 fix: per-file failing-test assertion. Each test file MUST have at least one FAIL line in the report.
      for f in test/budget/session-tracker-pool.test.ts test/budget/threshold-feed-bridge.test.ts test/budget/tracker-restart-replay.test.ts test/agents/cli-agents-claude-usage.test.ts test/agents/cli-agents-codex-usage.test.ts test/orchestrator/orchestrator-v2-token-usage.test.ts test/cli/print-status-context.test.ts test/domain/session-budget.test.ts test/cli/chat-record-usage.test.ts test/integration/session-budget-end-to-end.test.ts; do
        grep -E "(FAIL|✗|×).*${f##*/}" /tmp/wave0-tests.log >/dev/null || { echo "NO FAILING TEST FOUND IN $f"; exit 1; };
      done;
      pnpm -C gui test ContextWindowBar modelContextWindows 2>&1 | tail -20;
      cargo test -p harness-data session_budget 2>&1 | tail -20;
      pnpm typecheck;
      cargo check --workspace --locked
    </automated>
  </verify>
  <done>All listed test files exist and run. **Every test file has at least one failing test individually** (RED state, per-file grep). `pnpm typecheck` AND `cargo check --workspace --locked` BOTH pass independently — the test bodies refer to `SessionBudget` / `load_session_budget` / etc., AND those types ALSO land in the same PR-1 bundle (Tasks 2 + 6, per H2 fix). No "skeleton type stubs" language; the types are real and final.</done>
</task>

<task type="auto" assumption_check="A1">
  <name>Task 1: Codex `--output-schema` usage spike (D-07)</name>
  <files>test/agents/cli-agents-codex-usage-spike.test.ts, .planning/phases/01-token-usage-telemetry-context-bar/01-SPIKE-A1.md</files>
  <requirements>REQ-1.1</requirements>
  <action>
    **Goal:** Verify whether `codex exec --output-schema <schema> -o <out>` writes a top-level `usage` block into the response file. This is the open assumption A1 from RESEARCH.md Q2 — the rest of the Codex parsing strategy (Task 3) depends on the answer.

    **Method (live, but bounded):**
    1. If `codex` CLI is on PATH (`which codex`): run a one-shot live invocation against a trivial prompt:
       ```bash
       # Generate the JSON schema using zod-to-json-schema (already in node_modules; if not,
       # install via pnpm add -D zod-to-json-schema and document in the spike doc).
       node -e 'import("zod-to-json-schema").then(({zodToJsonSchema}) => import("./dist/domain/agent.js").then(({AgentResultSchema}) => process.stdout.write(JSON.stringify(zodToJsonSchema(AgentResultSchema), null, 2))))' > /tmp/relay-spike-schema.json

       codex exec --skip-git-repo-check --sandbox read-only \
         --output-schema /tmp/relay-spike-schema.json \
         -o /tmp/relay-spike-response.json \
         "Return a JSON object with summary='ok', evidence=[], proposedCommands=[], blockers=[]."
       cat /tmp/relay-spike-response.json
       ```
       If `zod-to-json-schema` is not on the dep tree, fallback hypothesis test (L6): pass `{}` (an empty schema) and observe whether Codex still includes `usage` in the response — that answers the A1 question without needing the full agent schema. Document which path was taken.
    2. If `codex` is NOT installed (CI / sandbox): mark the spike as `INCONCLUSIVE` and emit `STREAM_FLAG=NONE`. Proceed with Branch A only in Task 3 (per M2 fix).

    **Document outcome in `01-SPIKE-A1.md`:**

    The first 5 lines of the file MUST contain (exact, machine-readable):
    ```
    BRANCH=<A|B|INCONCLUSIVE>
    STREAM_FLAG=<--json|NONE|...>
    CODEX_VERSION=<output of `codex --version` or "not installed">
    SCHEMA_PATH=<schema flag used or "fallback-empty-schema">
    USAGE_PRESENT=<true|false|unknown>
    ```

    Body:
    - **Branch A (assumption holds):** `response.json` contains a top-level `usage: { input_tokens, cached_input_tokens?, output_tokens }`. Task 3 parses it directly. Single code path. Set `STREAM_FLAG=NONE` (no JSONL stream needed).
    - **Branch B (assumption fails):** `response.json` does NOT contain `usage`. Task 3 must additionally pass the documented stream flag (e.g. `--json`) to spawn the JSONL event stream and capture the last `turn.completed.usage`. Write the `codex exec --help` output to the spike doc. Note any flag conflict (research warned: `--output-schema` and `--json` may not coexist — verify by running both flags together; if it errors, Task 3 needs an exec-twice or stream-only path). Set `STREAM_FLAG=<flag>` to the resolved flag name.
    - **Branch INCONCLUSIVE:** Codex not installed. Task 3 implements Branch A only and emits a stderr `[budget] Codex usage extraction unavailable` warning when `parsed.usage` is undefined post-Codex-run (per M2). Set `STREAM_FLAG=NONE`.

    Add `test/agents/cli-agents-codex-usage-spike.test.ts` as a snapshot of the spike's findings — a single test that reads `01-SPIKE-A1.md`, parses the `BRANCH=` and `STREAM_FLAG=` lines, and asserts the documented branch is the one Task 3 implements (by grepping `src/agents/cli-agents.ts` for the matching code path). Future Codex output-shape regressions force a re-spike.

    **Output for the executor of Task 3:** `01-SPIKE-A1.md` with the exact 5-line header above.
  </action>
  <verify>
    <automated>
      test -f .planning/phases/01-token-usage-telemetry-context-bar/01-SPIKE-A1.md &&
      head -5 .planning/phases/01-token-usage-telemetry-context-bar/01-SPIKE-A1.md | grep -E "^BRANCH=(A|B|INCONCLUSIVE)$" &&
      head -5 .planning/phases/01-token-usage-telemetry-context-bar/01-SPIKE-A1.md | grep -E "^STREAM_FLAG=" &&
      pnpm test test/agents/cli-agents-codex-usage-spike.test.ts
    </automated>
  </verify>
  <done>
    `01-SPIKE-A1.md` exists at the phase directory. First 5 lines contain `BRANCH=<A|B|INCONCLUSIVE>`, `STREAM_FLAG=<...>`, `CODEX_VERSION=<...>`, `SCHEMA_PATH=<...>`, `USAGE_PRESENT=<true|false|unknown>` in exactly that order. The decision is reproducible from the documented commands. The spike test parses the markers and confirms Task 3 implemented the documented branch. Surfaced in the task summary.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Domain shapes + threshold widening + model table (PR-1 bundle)</name>
  <files>
    src/budget/token-tracker.ts,
    src/domain/session-budget.ts,
    src/domain/model-context-windows.ts,
    test/budget/token-tracker.test.ts (extend with widened-thresholds assertions, do not replace)
  </files>
  <requirements>REQ-1.1, REQ-1.7, REQ-1.9</requirements>
  <behavior>
    - `THRESHOLDS` now exports the 7-element list `[50, 60, 75, 85, 90, 95, 100]` and existing tracker tests still pass (60% subscriber unaffected).
    - `record()` that crosses 75 fires exactly one threshold event with `threshold === 75`; same for 90 and 95.
    - Replay across a process restart that already-crossed 75 / 90 does NOT re-fire.
    - `SessionBudgetSchema` validates `{ schemaVersion: 1, kind: "chat" | "run" | "admin", sessionId, used, total, pct, lastUpdated?, modelName? }`. `schemaVersion !== 1` fails parse with a message containing `schemaVersion`. Missing `kind` defaults to `"admin"` (back-compat).
    - `MODEL_CONTEXT_WINDOWS["claude-sonnet-4-5"] === 200_000` and `["claude-opus-4-7"] === 1_000_000`. `resolveContextWindow(undefined)` returns 200_000 and writes a one-line stderr warning. `resolveContextWindow("unknown-model-x")` same fallback + warning.
  </behavior>
  <action>
    **Step 1 — widen THRESHOLDS (D-01):**
    Edit `src/budget/token-tracker.ts:21`. Change the array literal to `[50, 60, 75, 85, 90, 95, 100] as const`. Update the comment block above it: enumerate which subscribers care about which threshold:
    - `60` → `RepoAdminSession.handleThresholdEvent` (memory-shed cycle, AL-15) — UNCHANGED.
    - `75 / 90 / 95` → `attachThresholdFeed` posts these to the channel feed (Phase 1 chat sessions); Phase 2's handoff nudge subscribes to `90` from the feed.
    - `100` → existing overrun signal.

    **Step 2 — extend `test/budget/token-tracker.test.ts`** (do NOT touch existing tests; append new ones):
    - Test that `record(150_000, 0)` on a 200_000-ceiling tracker fires `[75]` exactly.
    - Test that subsequent `record(50_000, 0)` (cumulative 200_000) fires `[85, 90, 95, 100]` in order.
    - Test that replay-with-prior-state of `cumulativeUsed = 180_000 / 200_000` (90%) marks `[50, 60, 75, 85, 90]` as already-fired and the next `record` only fires `[95, 100]`.

    **Step 3 — create `src/domain/session-budget.ts`** (D-06):
    ```typescript
    import { z } from "zod";

    /**
     * Schema version for SessionBudget. Bumping this requires a same-PR Rust
     * mirror update (`crates/harness-data/src/lib.rs::SessionBudget::schema_version`)
     * AND a forward-migration helper for any pre-existing on-disk lines.
     *
     * Phase 2's handoff brief artifacts depend on this contract being stable —
     * if you bump it, surface the change in the Phase 2 plan's revision_context.
     */
    export const SESSION_BUDGET_SCHEMA_VERSION = 1 as const;

    /**
     * Discriminator for the three keyspaces under `~/.relay/sessions/`:
     *   - "chat":  chat-mode sessions (recorded via `rly chat record-usage`)
     *   - "run":   orchestrator dispatches (recorded by OrchestratorV2.dispatch)
     *   - "admin": autonomous-loop admin sessions (existing keyspace under
     *              `admin-<alias>`); default when missing for back-compat
     *              with files that pre-date Phase 1.
     *
     * `list_chat_session_budgets()` and `loadActiveSessions()` filter on
     * `kind === "chat"` to avoid surfacing autonomous noise in the
     * worst-session chip / `rly status` block.
     */
    export const SessionKind = z.enum(["chat", "run", "admin"]);
    export type SessionKind = z.infer<typeof SessionKind>;

    export const SessionBudgetSchema = z.object({
      schemaVersion: z.literal(SESSION_BUDGET_SCHEMA_VERSION),
      kind: SessionKind.default("admin"),
      sessionId: z.string().min(1),
      used: z.number().int().nonnegative(),
      total: z.number().int().positive(),
      pct: z.number(),
      lastUpdated: z.string().optional(),
      modelName: z.string().optional(),
    });

    export type SessionBudget = z.infer<typeof SessionBudgetSchema>;
    ```

    **Step 4 — create `src/domain/model-context-windows.ts`** (D-05):
    ```typescript
    /**
     * Hard-coded per-model context-window ceilings as of 2026-05-09. Sources:
     *   - Claude: support.claude.com/en/articles/8606395
     *   - Codex / OpenAI: docs.onlinetool.cc/codex (varies by deployed model)
     *
     * Add new entries when models ship; missing keys fall back to a conservative
     * 200_000 with a stderr warning so the operator knows their bar may be off.
     * Mirrored at `gui/src/lib/modelContextWindows.ts` (same keys / values).
     * `gui/src/lib/modelContextWindows.test.ts` asserts the two copies stay in
     * sync (drift guard, M9). Adding a new entry here REQUIRES adding it
     * there in the same PR.
     */
    export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
      "claude-sonnet-4-5": 200_000,
      "claude-opus-4-7": 1_000_000,
      "claude-haiku-3-5": 200_000,
      "gpt-5": 200_000,
      "o3-mini": 200_000,
    };

    export const DEFAULT_CONTEXT_WINDOW = 200_000;

    const warnedModels = new Set<string>();

    export function resolveContextWindow(modelName?: string | null): number {
      if (!modelName) return DEFAULT_CONTEXT_WINDOW;
      const known = MODEL_CONTEXT_WINDOWS[modelName];
      if (typeof known === "number") return known;
      if (!warnedModels.has(modelName)) {
        warnedModels.add(modelName);
        console.warn(
          `[budget] Unknown model "${modelName}"; assuming ${DEFAULT_CONTEXT_WINDOW.toLocaleString()}-token context window.`
        );
      }
      return DEFAULT_CONTEXT_WINDOW;
    }
    ```

    **Project conventions:** `kebab-case` filenames, ESM `.js` extension on relative imports, two-space indent, double quotes, semicolons, trailing commas. Per-call `console.warn` with `[budget]` prefix matches the existing module-prefix convention.

    **Cross-dashboard contract:** No Rust mirror needed in Task 2 — `MODEL_CONTEXT_WINDOWS` is consumed only by the TS orchestrator (deciding what `total` to pass when constructing a `TokenTracker`). The on-disk `SessionBudget` shape Rust will mirror lives in Task 6 (same PR-1).
  </action>
  <verify>
    <automated>pnpm test test/budget/token-tracker.test.ts test/domain/session-budget.test.ts && pnpm typecheck</automated>
  </verify>
  <done>THRESHOLDS contains 7 ascending integers; both new test files pass GREEN; the existing autonomous-loop tests in `test/orchestrator/repo-admin-session.test.ts` still pass (60% subscriber path unchanged); `pnpm typecheck` clean.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 3: Adapter usage extraction (Claude streaming + buffered + Codex)</name>
  <files>src/agents/cli-agents.ts, src/domain/agent.ts</files>
  <requirements>REQ-1.1</requirements>
  <behavior>
    - Claude streaming: `result` event's `usage` field captured; mid-stream `assistant.message.usage` ignored.
    - Claude buffered: top-level `usage` field on `--output-format json` body captured.
    - Codex: top-level `usage` field on `response.json` captured (Branch A from Task 1) OR JSONL event stream's last `turn.completed.usage` captured (Branch B). If Branch INCONCLUSIVE: Branch A only + stderr warning if `parsed.usage` is undefined post-run.
    - Cache tokens (`cache_read_input_tokens`, `cache_creation_input_tokens`, `cached_input_tokens`) are **summed into inputTokens** before being returned (research Q3).
    - Missing usage is non-fatal: `parsed.usage === undefined`, no throw.
    - `AgentResult.tokenUsage` is the new typed field surfacing usage to callers.
  </behavior>
  <action>
    **Step 1 — extend the domain schema (`src/domain/agent.ts`):**

    Append to `AgentResult`:
    ```typescript
    export interface TokenUsage {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    }

    export interface AgentResult {
      // ... existing fields
      tokenUsage?: TokenUsage;
    }
    ```

    Append to `AgentResultSchema`:
    ```typescript
    export const TokenUsageSchema = z.object({
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      cacheReadTokens: z.number().int().nonnegative().optional(),
      cacheWriteTokens: z.number().int().nonnegative().optional(),
    });

    export const AgentResultSchema = z.object({
      // ... existing fields
      tokenUsage: TokenUsageSchema.optional(),
    });
    ```

    Mirror in `agentResultJsonSchema` so the Claude `--json-schema` flag still validates: add an optional `tokenUsage` property — but since the model itself will not emit this (we extract from `usage`, not from the agent's response body), keep it optional and also accept it not being present.

    **Step 2 — extend `ParsedProviderResult` (`src/agents/cli-agents.ts:84-94`):**
    ```typescript
    interface ParsedProviderResult {
      rawResponse: string;
      parsed: {
        // ... existing fields
        tokenUsage?: TokenUsage;
      };
    }
    ```

    Update `normalizePayload` to copy `tokenUsage` through if `AgentResultSchema.parse(payload)` produces it (it won't from a normal model response — the field is set by adapter parsing, not model generation; `normalizePayload` should **not** overwrite a usage already injected by the parsing path). Refactor: have the adapter's `invokeProvider` return `{ rawResponse, parsed: { ...normalizePayload(body), tokenUsage } }` where `tokenUsage` is set by the parse-side helper.

    **Step 3 — extract `processStreamLine` to a pure exported function** (research recommendation Q13b):
    ```typescript
    export interface StreamParseState {
      accumText: string;
      resultText: string | null;
      capturedUsage: TokenUsage | null;
    }

    export function processStreamLine(
      line: string,
      state: StreamParseState,
      onLine: (line: string) => void
    ): void { /* ... existing logic + obj.usage capture on type==="result" ... */ }
    ```
    Move the closure body verbatim into the function, then have `invokeStreaming` call `processStreamLine(line, state, onLine)`. Mid-stream `assistant.message.usage` is intentionally ignored (pitfall #2). On `obj.type === "result"`, if `obj.usage` is an object, normalize via:
    ```typescript
    function normalizeClaudeUsage(usage: Record<string, unknown>): TokenUsage {
      const input = num(usage.input_tokens);
      const cacheRead = num(usage.cache_read_input_tokens);
      const cacheWrite = num(usage.cache_creation_input_tokens);
      return {
        inputTokens: input + cacheRead + cacheWrite, // research Q3 — cache occupies window
        outputTokens: num(usage.output_tokens),
        cacheReadTokens: cacheRead || undefined,
        cacheWriteTokens: cacheWrite || undefined,
      };
    }
    ```

    **Step 4 — buffered Claude path (`invokeProvider` for ClaudeCliAgent, around `:412-415`):**
    Parse `result.stdout` as JSON, extract optional top-level `usage` and pass through `normalizeClaudeUsage`. Same shape as the streaming `result` event per Anthropic Messages API.

    **Step 5 — Codex (`CodexCliAgent.invokeProvider`, around `:332-337`):**

    Read `01-SPIKE-A1.md` first 5 lines. `grep "^BRANCH=" 01-SPIKE-A1.md` resolves the branch:

    **Branch A** (`BRANCH=A`, `STREAM_FLAG=NONE`):
    Parse `rawResponse` as JSON, extract optional top-level `usage`, normalize:
    ```typescript
    function normalizeCodexUsage(usage: Record<string, unknown>): TokenUsage {
      const input = num(usage.input_tokens);
      const cached = num(usage.cached_input_tokens);
      return {
        inputTokens: input + cached,
        outputTokens: num(usage.output_tokens),
        cacheReadTokens: cached || undefined,
      };
    }
    ```

    **Branch B** (`BRANCH=B`, `STREAM_FLAG=<flag>`):
    Add a JSONL stream parsing path. Spawn Codex with the documented stream flag from `STREAM_FLAG=`. Tail the stream for `turn.completed` events; capture the LAST one's `usage`. Document the flag-conflict resolution from Task 1 in a comment.

    **Branch INCONCLUSIVE** (`BRANCH=INCONCLUSIVE`, `STREAM_FLAG=NONE`):
    Implement Branch A only. After Codex completes, if `parsed.usage` is undefined, emit ONE stderr warning: `console.warn("[budget] Codex usage extraction unavailable; bar will not update for this session. Re-run the A1 spike with codex installed to enable telemetry.")`. The orchestrator (Task 4) guards with `if (result.tokenUsage)`, so a missing usage is a noop. M2 fix: never silently no-op without logging.

    **Step 6 — surface `tokenUsage` on `AgentResult` returned by `run()`:**
    `CliAgentBase.run()` (`:233-240`) does `return { ...response.parsed, rawResponse }`. Since `tokenUsage` is now on `parsed`, the spread already exposes it.

    **Conventions reminder:** Two-space indent, double quotes, semicolons, trailing commas. ESM `.js` imports. No drive-by reformats — only touch lines whose semantics change. Sub-800 LOC budget — this task should land at ~150-300 added LOC across `cli-agents.ts` + `agent.ts`.
  </action>
  <verify>
    <automated>pnpm test test/agents/cli-agents-claude-usage.test.ts test/agents/cli-agents-codex-usage.test.ts test/agents/cli-agents-codex-usage-spike.test.ts test/agents/cli-agents-env-overlay.test.ts test/agents/cli-agents-full-access.test.ts && pnpm typecheck</automated>
  </verify>
  <done>Both Claude and Codex usage tests pass GREEN; `processStreamLine` exported as a pure function with passing tests; existing adapter tests unchanged + still GREEN; `AgentResult.tokenUsage` typed end-to-end through zod; no break in scripted-mode orchestrator tests; the Codex branch implemented matches what `01-SPIKE-A1.md` documents.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 4: Tracker pool + dispatch wiring</name>
  <files>src/budget/session-tracker-pool.ts, src/orchestrator/orchestrator-v2.ts</files>
  <requirements>REQ-1.1, REQ-1.2, D-02</requirements>
  <behavior>
    - `SessionTrackerPool` returns the same `TokenTracker` instance for the same sessionId across calls.
    - On `get()` for a brand-new sessionId where `~/.relay/sessions/<id>/budget.jsonl` already exists with non-zero `cumulativeUsed`, emit a `console.warn("[budget] tracker for new sessionId X is replaying non-zero state from disk")` (M8 soft-warning).
    - On dispatch resolving with `tokenUsage`, the tracker pool is consulted for the run's session id and `record(in+cache, out)` is called. The budget line is written with `kind: "run"`.
    - **Hard assertion:** if `agent.capability.model` (or fallback `agent.model`) is undefined, throw a descriptive error rather than silently defaulting to `200_000` (hidden-assumption fix). Miscalibrating an Opus 4.7 session to 5x of actual is the silent-failure class AGENTS.md explicitly flags.
    - `~/.relay/sessions/<sessId>/budget.jsonl` exists with at least one line after the first dispatch.
    - Dispatch with `tokenUsage === undefined` (e.g. Codex INCONCLUSIVE fallback miss) does not throw and does not record.
  </behavior>
  <action>
    **Step 1 — create `src/budget/session-tracker-pool.ts`:**

    Per RESEARCH Pattern 3:
    ```typescript
    import { existsSync, readFileSync } from "node:fs";
    import { join } from "node:path";
    import { TokenTracker } from "./token-tracker.js";
    import { getRelayDir } from "../config/relay-dir.js";

    /**
     * One-tracker-per-chat-session pool. Construction is lazy: the first
     * `get(sessionId, ceiling)` call mints the tracker (which immediately
     * starts replaying any prior `~/.relay/sessions/<sessId>/budget.jsonl`).
     * Subsequent calls return the same instance — same-process records
     * serialize through the tracker's writeChain (token-tracker.ts:75).
     *
     * Per D-02 the pool is keyed by chat sessionId, not channelId — a
     * channel may host multiple sessions over its lifetime; each gets its
     * own tracker + budget file. Per D-03 a Phase-2 handoff creates a new
     * sessionId in the destination provider; that session's tracker starts
     * at 0% (the file is fresh on disk).
     *
     * M8 soft-warning: if a "brand-new" sessionId surfaces a pre-existing
     * budget.jsonl with non-zero cumulativeUsed, log via console.warn — this
     * is most likely a reused id from Phase 2 that violated the 0%
     * guarantee, OR a legitimate same-id resumption (in which case the
     * warning is harmless). Prefer false positives over silent failures.
     */
    export class SessionTrackerPool {
      private readonly trackers = new Map<string, TokenTracker>();

      get(sessionId: string, ceiling: number, kind: "chat" | "run" | "admin" = "run"): TokenTracker {
        let tracker = this.trackers.get(sessionId);
        if (!tracker) {
          // M8: probe disk before construction to surface the soft-warning.
          const path = join(getRelayDir(), "sessions", sessionId, "budget.jsonl");
          if (existsSync(path)) {
            try {
              const content = readFileSync(path, "utf8").trim();
              const lastLine = content.split("\n").filter(Boolean).pop();
              if (lastLine) {
                const parsed = JSON.parse(lastLine);
                if (typeof parsed.cumulativeUsed === "number" && parsed.cumulativeUsed > 0) {
                  console.warn(
                    `[budget] tracker for sessionId "${sessionId}" is replaying non-zero state (used=${parsed.cumulativeUsed}) from disk — if Phase 2 minted this id, the 0% start guarantee may have been violated.`
                  );
                }
              }
            } catch {
              // Malformed file is fine — the tracker's own replay handles torn lines.
            }
          }
          tracker = new TokenTracker(sessionId, ceiling, { kind });
          this.trackers.set(sessionId, tracker);
        }
        return tracker;
      }

      has(sessionId: string): boolean {
        return this.trackers.has(sessionId);
      }

      async closeAll(): Promise<void> {
        const all = [...this.trackers.values()];
        this.trackers.clear();
        await Promise.all(all.map((t) => t.close()));
      }
    }
    ```

    Note: `TokenTracker` constructor needs a new `kind?: "chat" | "run" | "admin"` option that gets serialized into each `budget.jsonl` line. Add it minimally — the field is written alongside `cumulativeUsed`, no behavior change to threshold logic. Default `"admin"` for back-compat with `RepoAdminSession` (which doesn't pass `kind`).

    **Step 2 — wire into OrchestratorV2 (`src/orchestrator/orchestrator-v2.ts`):**

    Add a `private readonly trackerPool = new SessionTrackerPool();` field. Optionally accept it via constructor options for test injection. Construct via `OrchestratorV2Options.trackerPool ?? new SessionTrackerPool()`.

    In `dispatch()` (around `:501-547`), after `const result = await agent.run(request);` resolves:
    ```typescript
    if (result.tokenUsage && run.channelId) {
      try {
        const sessionId = `run-${run.id}`;
        // Hidden-assumption fix: hard-assert model is set. Resolve via
        // `agent.capability.model` (CliAgentBase.capability) OR `agent.model`
        // (some legacy agents). Throw if neither is set — silent default to
        // 200_000 would miscalibrate an Opus 4.7 session by ~5x.
        const model = agent.capability?.model ?? (agent as { model?: string }).model;
        if (!model) {
          throw new Error(
            `[budget] missing model on agent capability (agentId=${agent.id ?? "unknown"}); ` +
            `cannot resolve context-window ceiling for sessionId=${sessionId}.`
          );
        }
        const ceiling = resolveContextWindow(model);
        const tracker = this.trackerPool.get(sessionId, ceiling, "run");
        // inputTokens already includes cache per normalizeClaude/CodexUsage
        // (Task 3, research Q3). Pass them as-is — the tracker doesn't care
        // about the breakdown; it just sums input+output for cumulative.
        // (L2 fix: removed unused `const cache = ...` lines.)
        tracker.record(result.tokenUsage.inputTokens, result.tokenUsage.outputTokens);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[orchestrator] tracker.record failed (runId=${run.id}): ${message}`);
        // Hard-assert errors (missing model) re-throw so tests catch them.
        if (err instanceof Error && err.message.includes("missing model")) throw err;
      }
    }
    ```

    **Important:** Do NOT change the existing `recordEvidence` / `recordEvent` flow. The tracker work is additive and best-effort EXCEPT for the missing-model assertion which is hard. A non-assertion tracker failure must NOT abort the dispatch — log and continue, mirroring the existing `trackChannelPost` best-effort pattern.

    **`Agent.capability.model`:** check `src/domain/agent.ts:45-50` for the field. If not present, fall back to `(agent as { model?: string }).model`. If neither is set: hard-throw per above. Add a unit test in Task 0's orchestrator-v2-token-usage.test.ts that asserts the throw (already specified in the M3-amended Task 0 step 5).

    **Step 3 — wire `trackerPool.closeAll()` into the run completion path:**
    In `OrchestratorV2.run()`'s `finally` (or whatever cleanup path drains `pendingWrites`), call `await this.trackerPool.closeAll()` so all `budget.jsonl` writes flush to disk before the run resolves. Mirrors the `pendingWrites` drain pattern.

    **Step 4 — extend the orchestrator-v2 unit tests** to assert `~/.relay/sessions/run-<runId>/budget.jsonl` exists and has the expected `cumulativeUsed` AND `kind: "run"` after a scripted-mode dispatch with a fake `tokenUsage`. Use the existing `mkdtemp` + `RM_OPTS` pattern.
  </action>
  <verify>
    <automated>pnpm test test/budget/session-tracker-pool.test.ts test/orchestrator/orchestrator-v2-token-usage.test.ts test/orchestrator-v2.test.ts && pnpm typecheck</automated>
  </verify>
  <done>`SessionTrackerPool` exists and is exercised; dispatch records into the right tracker; `budget.jsonl` lands at `~/.relay/sessions/run-<runId>/budget.jsonl` (or the test override path) with valid JSON lines containing `cumulativeUsed` and `kind: "run"`; missing-model assertion throws (test confirms); existing `test/orchestrator-v2.test.ts` still passes.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 5: Threshold-feed bridge (75/90/95) with Phase-2 contract docs</name>
  <files>src/budget/threshold-feed-bridge.ts, src/orchestrator/orchestrator-v2.ts, docs/design/context-threshold-events.md</files>
  <requirements>REQ-1.3, REQ-1.9, D-03</requirements>
  <behavior>
    - `attachThresholdFeed(tracker, channelId, channelStore, opts)` returns an unsubscribe.
    - Crossing 75/90/95 emits exactly one `status_update` ChannelEntry per crossing with `metadata.kind === "context_threshold"`.
    - Crossing 50/60/85/100 does NOT post (filter applied; 60 is still consumed by `RepoAdminSession`'s in-process subscriber).
    - The same `metadata` object includes stable string-typed fields: `threshold`, `pct` (matching `/^\d+\.\d{2}$/`), `used`, `total`, `sessionId`, `model?`, `schemaVersion: "1"`.
    - Phase 2's planner can subscribe by reading `feed.jsonl` and filtering on `metadata.kind === "context_threshold" && metadata.threshold === "90"`.
  </behavior>
  <action>
    **Step 1 — create `src/budget/threshold-feed-bridge.ts`** per RESEARCH Pattern 6:

    ```typescript
    import type { ChannelStore } from "../channels/channel-store.js";
    import type { TokenTracker, ThresholdEvent } from "./token-tracker.js";

    export interface ThresholdFeedOptions {
      /**
       * Subset of `THRESHOLDS` (token-tracker.ts:21) to forward to the channel
       * feed. Defaults to [75, 90, 95] per the Phase-1 brief. Other thresholds
       * still fire on the in-process EventEmitter for in-process subscribers
       * (e.g. RepoAdminSession's 60% memory-shed subscriber); they are simply
       * not posted to the channel feed here.
       */
      postThresholds?: readonly number[];
      /** Optional model name surfaced in metadata for downstream readers. */
      modelName?: string;
    }

    const DEFAULT_POST_THRESHOLDS = [75, 90, 95] as const;

    /**
     * Best-effort listener: on every threshold crossing in the configured
     * subset, post one `status_update` ChannelEntry. Never throws — channel
     * post failures are logged via `console.warn("[threshold-feed] ...")`.
     *
     * D-03 contract for Phase 2's handoff planner:
     *   - `metadata.kind === "context_threshold"` is the discriminator.
     *   - `metadata.threshold` is the integer-as-string crossed (e.g. "90").
     *   - `metadata.pct` is a fixed-2-decimal string (e.g. "91.23"). Phase 2
     *     planners parse with parseFloat. M7 test pins this regex.
     *   - `metadata.sessionId` is the Phase-1 chat sessionId. After a Phase-2
     *     handoff, the destination provider gets a NEW sessionId; that
     *     session's tracker starts at 0% (subject to D-03 caveat — see M8 in
     *     the design doc) and never re-emits the source session's thresholds.
     *     Subscribers are per-session.
     *   - `metadata.schemaVersion === "1"` is the contract version. Bumping it
     *     requires a coordinated update across Phase 1 and Phase 2 codepaths.
     */
    export function attachThresholdFeed(
      tracker: TokenTracker,
      channelId: string,
      channelStore: ChannelStore,
      opts: ThresholdFeedOptions = {}
    ): () => void {
      const post = new Set(opts.postThresholds ?? DEFAULT_POST_THRESHOLDS);
      return tracker.onThreshold(async (evt: ThresholdEvent) => {
        if (!post.has(evt.threshold)) return;
        try {
          await channelStore.postEntry(channelId, {
            type: "status_update",
            fromAgentId: null,
            fromDisplayName: "Relay",
            content: `Context window at ${Math.round(evt.pct)}% (${evt.threshold}% threshold).`,
            metadata: {
              kind: "context_threshold",
              schemaVersion: "1",
              threshold: String(evt.threshold),
              pct: evt.pct.toFixed(2), // M7 — pin precision; bridge test enforces.
              used: String(evt.used),
              total: String(evt.total),
              sessionId: evt.sessionId,
              ...(opts.modelName ? { model: opts.modelName } : {}),
            },
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.warn(`[threshold-feed] post failed (sessionId=${evt.sessionId}): ${message}`);
        }
      });
    }
    ```

    **Step 2 — wire the bridge into `OrchestratorV2`:**

    Maintain a `Map<sessionId, () => void>` of unsubscribes alongside the trackerPool. When a new tracker is minted (in dispatch — extend the lazy-construct path), if `run.channelId` is set, immediately call `attachThresholdFeed(tracker, run.channelId, channelStore, { modelName: agent.capability?.model ?? (agent as { model?: string }).model })` and stash the unsubscribe. On `closeAll`, run all unsubscribes first, then close trackers.

    **Step 3 — write `docs/design/context-threshold-events.md`** (the Phase 2 contract — REQ-1.9):

    ```markdown
    # Context-threshold events on the channel feed

    Status: Stable as of Phase 1 (2026-05-09)
    Owner: Relay core
    Related code paths: `src/budget/threshold-feed-bridge.ts`, `src/budget/token-tracker.ts`, `src/channels/channel-store.ts`

    ## Problem
    Phase 2's handoff feature surfaces a "you're at 90%, want to hand off?" prompt. It needs a deterministic, on-disk signal that a session has crossed 90% of its model's context window. Phase 1 emits that signal on the channel feed.

    ## Goals
    - Phase 2's planner can subscribe by tailing `~/.relay/channels/<id>/feed.jsonl`.
    - The signal is rising-edge only — re-crossing 90% (e.g. after compaction) does not re-fire within the same session.
    - The signal survives a process restart — the underlying TokenTracker's `firedThresholds` replay (token-tracker.ts:371-375) ensures crossed thresholds don't re-fire after a reload.

    ## Specs

    ### Channel-feed shape

    A threshold crossing emits ONE `ChannelEntry`:

    ```jsonc
    {
      "type": "status_update",
      "fromAgentId": null,
      "fromDisplayName": "Relay",
      "content": "Context window at 91% (90% threshold).",
      "metadata": {
        "kind": "context_threshold",
        "schemaVersion": "1",
        "threshold": "90",
        "pct": "91.23",
        "used": "182464",
        "total": "200000",
        "sessionId": "sess-1762634000123",
        "model": "claude-sonnet-4-5"
      }
    }
    ```

    All metadata values are strings (matches `ChannelEntry.metadata: Record<string, unknown>` convention; numeric round-trips are the consumer's job). `metadata.pct` is pinned to `/^\d+\.\d{2}$/` by `test/budget/threshold-feed-bridge.test.ts`.

    ### Phase 2 subscription rule

    Filter `feed.jsonl` lines where `entry.type === "status_update" && entry.metadata?.kind === "context_threshold" && entry.metadata?.threshold === "90"`. The `sessionId` field tells you WHICH session crossed; a channel hosting multiple sessions over its lifetime emits one event per (session, threshold) pair.

    ### Handoff session-id contract (D-03 + M8)

    A Phase-2 handoff creates a new sessionId in the destination provider. The intent is that this session's tracker starts at 0% — but **Phase 1 does not enforce this in code**. Phase 1 guarantees only that `firedThresholds` is replayed from disk for the same sessionId (`src/budget/token-tracker.ts:371-375`).

    To satisfy the 0% start requirement, **Phase 2 MUST mint unique sessionIds** that have no pre-existing `~/.relay/sessions/<id>/budget.jsonl`. As a soft guard, `SessionTrackerPool.get` emits `console.warn("[budget] tracker for sessionId X is replaying non-zero state from disk")` if a brand-new sessionId surfaces a non-zero existing budget — but this is a warning, not an error. Phase 2 owns the uniqueness invariant.

    Subscribers should treat each (sessionId, threshold) pair as independent.

    ## Non-goals

    - Cross-process locking on `feed.jsonl` writes — the existing append-only contract applies (AGENTS.md:111-113). A torn last line is silently skipped by the Rust reader and recovers on the next render cycle (CONCERNS.md "Cross-language read-during-write race").
    - Re-firing a crossed threshold within the same session — by design, per `TokenTracker.firedThresholds`. Phase 2 must not assume retriggers.

    ## Sign-off
    Pending Phase 2 plan-phase confirmation.
    ```

    **Conventions:** sub-800 LOC budget per AGENTS.md. This task lands at ~80 LOC bridge + ~80 LOC docs + ~30 LOC orchestrator wire-up = well under budget.
  </action>
  <verify>
    <automated>pnpm test test/budget/threshold-feed-bridge.test.ts && pnpm typecheck && test -f docs/design/context-threshold-events.md && grep -q "schemaVersion.*1" docs/design/context-threshold-events.md && grep -q "Phase 1 does not enforce" docs/design/context-threshold-events.md</automated>
  </verify>
  <done>Bridge fires only for [75, 90, 95]; channel-feed entry shape matches the Phase 2 contract documented in `docs/design/context-threshold-events.md`; design doc exists, includes the D-03 handoff-id rule AND the M8 sharpening; `metadata.pct` matches `/^\d+\.\d{2}$/`; unsubscribe handle cleans up on tracker close.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 6: Rust SessionBudget mirror + harness-data loader (PR-1 bundle)</name>
  <files>crates/harness-data/src/lib.rs, gui/src-tauri/src/lib.rs (relocate read_session_budget_used)</files>
  <requirements>REQ-1.2, REQ-1.7</requirements>
  <behavior>
    - `harness_data::SessionBudget` round-trips JSON with `schemaVersion: 1` AND `kind: "chat" | "run" | "admin"` (camelCase via `#[serde(rename_all = "camelCase")]`). Missing `kind` defaults to `"admin"`.
    - `harness_data::load_session_budget(session_id, total)` reads the last well-formed `cumulativeUsed` from `~/.relay/sessions/<sessId>/budget.jsonl` and returns a populated `SessionBudget`.
    - Missing file → `SessionBudget { used: 0, total, pct: 0, schemaVersion: 1, kind: "admin", ... }` (kind default for empty).
    - The GUI Tauri backend's existing `read_session_budget_used` is replaced by a thin wrapper around `harness_data::load_session_budget` (DRY; same answer either way per RESEARCH Q5 caveat).
  </behavior>
  <action>
    **Step 1 — add `SessionBudget` struct to `crates/harness-data/src/lib.rs`** (mirror `src/domain/session-budget.ts`):

    Land near the existing `ChatSession` struct definition (around line 1268-1295 — research Pattern 3):

    ```rust
    /// Per-session token-budget snapshot. Mirrors `SessionBudget` in
    /// `src/domain/session-budget.ts`. Bumping `schemaVersion` requires a
    /// same-PR TS-side bump and a forward-migration helper for any pre-
    /// existing on-disk lines (CONCERNS.md "Channel state has no
    /// schema-version field anywhere"). Phase 2's handoff briefs depend on
    /// this contract being stable.
    #[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
    #[serde(rename_all = "camelCase")]
    pub enum SessionKind {
        Chat,
        Run,
        Admin,
    }

    impl Default for SessionKind {
        fn default() -> Self { SessionKind::Admin }
    }

    #[derive(Debug, Serialize, Deserialize, Clone)]
    #[serde(rename_all = "camelCase")]
    pub struct SessionBudget {
        #[serde(default = "default_session_budget_schema_version")]
        pub schema_version: u32,
        #[serde(default)]
        pub kind: SessionKind,
        pub session_id: String,
        pub used: u64,
        pub total: u64,
        pub pct: f64,
        #[serde(default)]
        pub last_updated: Option<String>,
        #[serde(default)]
        pub model_name: Option<String>,
    }

    fn default_session_budget_schema_version() -> u32 { 1 }

    impl SessionBudget {
        pub fn empty(session_id: impl Into<String>, total: u64) -> Self {
            SessionBudget {
                schema_version: 1,
                kind: SessionKind::default(),
                session_id: session_id.into(),
                used: 0,
                total,
                pct: 0.0,
                last_updated: None,
                model_name: None,
            }
        }
    }

    /// Load the per-session budget snapshot from
    /// `~/.relay/sessions/<sessionId>/budget.jsonl`. Reads the last
    /// well-formed `cumulativeUsed` value; missing/empty file returns
    /// `SessionBudget::empty()`. Hand-edited or torn lines are silently
    /// skipped (research Q7, CONCERNS.md "Cross-language read-during-write
    /// race" — accepted tradeoff).
    pub fn load_session_budget(session_id: &str, total: u64) -> SessionBudget {
        let path = harness_root()
            .join("sessions")
            .join(session_id)
            .join("budget.jsonl");
        let Ok(file) = fs::File::open(&path) else {
            return SessionBudget::empty(session_id, total);
        };
        let mut last_cumulative: u64 = 0;
        let mut last_ts: Option<String> = None;
        let mut last_kind: SessionKind = SessionKind::default();
        for line in BufReader::new(file).lines().flatten() {
            let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else { continue; };
            if let Some(c) = value.get("cumulativeUsed").and_then(|v| v.as_u64()) {
                last_cumulative = c;
            }
            if let Some(ts) = value.get("ts").and_then(|v| v.as_str()) {
                last_ts = Some(ts.to_string());
            }
            if let Some(k) = value.get("kind").and_then(|v| v.as_str()) {
                last_kind = match k {
                    "chat" => SessionKind::Chat,
                    "run" => SessionKind::Run,
                    _ => SessionKind::Admin,
                };
            }
        }
        let pct = if total == 0 { 0.0 } else { (last_cumulative as f64 / total as f64) * 100.0 };
        SessionBudget {
            schema_version: 1,
            kind: last_kind,
            session_id: session_id.to_string(),
            used: last_cumulative,
            total,
            pct,
            last_updated: last_ts,
            model_name: None,
        }
    }

    /// Walk `~/.relay/sessions/<id>/budget.jsonl` files and return one row
    /// per session. Caller filters on `kind == SessionKind::Chat` to drive
    /// the worst-session chip (M3 / M4). Missing/empty `~/.relay/sessions`
    /// returns `Vec::new()` without throwing.
    pub fn list_session_budgets() -> Vec<SessionBudget> {
        let root = harness_root().join("sessions");
        let Ok(read) = fs::read_dir(&root) else { return Vec::new(); };
        let mut out = Vec::new();
        for entry in read.flatten() {
            if !entry.path().is_dir() { continue; }
            let Some(name) = entry.file_name().to_str().map(str::to_string) else { continue; };
            // total=0 here — caller's responsibility to resolve from
            // model. The chip uses pct from the last line OR computes it
            // when caller knows the model. For Phase 1 we surface the
            // file-recorded pct directly.
            let budget = load_session_budget(&name, 200_000);
            out.push(budget);
        }
        out
    }
    ```

    **Step 2 — relocate the GUI's `read_session_budget_used`**:

    The existing function at `gui/src-tauri/src/lib.rs:3111-3135` reads the same file. Replace its body with a one-line `harness_data::load_session_budget(session_id, /* unknown total */ 0).used`. Keep the function name + signature so existing call sites compile (it returns `u64`). Add a deprecation comment pointing future readers at `harness_data::load_session_budget` for the typed view.

    **Step 3 — add a Tauri command `get_chat_session_budget`** in `gui/src-tauri/src/lib.rs` for Task 7's frontend:
    ```rust
    #[tauri::command]
    fn get_chat_session_budget(session_id: String, total: u64) -> SessionBudget {
        harness_data::load_session_budget(&session_id, total)
    }

    #[tauri::command]
    fn list_chat_session_budgets() -> Vec<SessionBudget> {
        // M4: filter to kind == Chat only — admin / run sessions don't
        // belong in the worst-session chip even though they share the
        // sessions/ keyspace.
        harness_data::list_session_budgets()
            .into_iter()
            .filter(|b| matches!(b.kind, harness_data::SessionKind::Chat))
            .collect()
    }
    ```
    Register both in the `invoke_handler!` macro (around `lib.rs:4049` per RESEARCH Q11).

    **Step 4 — extend the cargo test mod with the fixture tests from Task 0** (or refine them post-Task-0) — these now go GREEN. Specifically:
    - `session_budget_serde_fixture` asserts `assert_eq!(deserialized.schema_version, 1)` AND `assert_eq!(deserialized.kind, SessionKind::Chat)` for the hand-written line.
    - `session_budget_v2_round_trip` writes `schemaVersion: 2`, asserts deserialization gives `schema_version == 2` (M1 — drift guard).
    - `session_budget_load_from_jsonl` covers the loader with three lines.
    - **New (M4):** `list_chat_session_budgets_filters_admin` writes one `chat` and one `admin`-keyed entry to disk; asserts only the chat one comes back via the (eventual TS-side wrapper of) `list_chat_session_budgets()`.

    **Cross-dashboard contract:** This is the canonical mirror landing. AGENTS.md mandates same-PR TS+Rust update — Tasks 2 and 6 are bundled in PR-1 (per H2 fix).
  </action>
  <verify>
    <automated>cargo check --workspace --locked && cargo test -p harness-data session_budget && cargo test -p harness-data list_chat_session_budgets_filters_admin && cargo test -p relay-gui-lib --lib 2>&1 | tail -10</automated>
  </verify>
  <done>`SessionBudget` Rust struct deserializes the fixture JSON; explicit `schema_version == 1` and `kind == SessionKind::Chat` assertions pass; `version: 2` round-trip test passes (no silent downgrade); `load_session_budget` returns the right `used` for fake JSONL files; `list_chat_session_budgets` filters out admin/run kinds; existing autonomous-session reader still works (regression-free); `cargo check --workspace --locked` passes; `cargo test --workspace` GREEN for all newly-added Rust tests.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 7: GUI ContextWindowBar + worst-session chip + shared util extraction</name>
  <files>gui/src/components/ContextWindowBar.tsx, gui/src/components/CenterPane.tsx, gui/src/components/Sidebar.tsx, gui/src/api.ts, gui/src/types.ts, gui/src/lib/tokenSeverity.ts, gui/src/lib/modelContextWindows.ts, gui/src/components/AutonomousSessionHeader.tsx (refactor to import shared util), gui/src/styles.css</files>
  <requirements>REQ-1.5</requirements>
  <behavior>
    - `<ContextWindowBar sessionId model total />` renders "ctx N% (used / total tokens)" with severity-tier CSS class (`metric--tokens-{ok|warn|hot|overrun}`).
    - Polled on `refreshTick` (5s App-level interval per AutonomousSessionHeader pattern).
    - A worst-session chip in the sidebar (or App top-bar near UpdateBanner) appears when ANY active session's pct >= 75 — and ONLY for `kind == "chat"` sessions (M4).
    - Clicking the chip selects that channel/session.
    - `tokenPctSeverity` is exported from `gui/src/lib/tokenSeverity.ts` (the shared util); BOTH `AutonomousSessionHeader` and `ContextWindowBar` import from it (no copy-paste; hidden-assumption fix).
  </behavior>
  <action>
    **Step 1 — extract `tokenPctSeverity` to a shared util:**

    Create `gui/src/lib/tokenSeverity.ts`:
    ```typescript
    /**
     * Map context-window pct (0-100+) to a CSS severity tier.
     * Mirrors the original implementation from
     * `gui/src/components/AutonomousSessionHeader.tsx:258-263` —
     * extracted here so `ContextWindowBar` and the worst-session chip
     * share the named export rather than copy-pasting the ladder.
     */
    export type TokenSeverity = "ok" | "warn" | "hot" | "overrun";

    export function tokenPctSeverity(pct: number): TokenSeverity {
      if (pct >= 100) return "overrun";
      if (pct >= 90) return "hot";
      if (pct >= 75) return "warn";
      return "ok";
    }
    ```

    Update `gui/src/components/AutonomousSessionHeader.tsx:258-263` to delete its inline implementation and `import { tokenPctSeverity } from "../lib/tokenSeverity";`. Verify the existing `AutonomousSessionHeader.test.tsx` still passes.

    **Step 2 — extend `gui/src/types.ts`:**
    ```typescript
    export type SessionKind = "chat" | "run" | "admin";

    export interface ChatSessionBudget {
      schemaVersion: 1;
      kind: SessionKind;
      sessionId: string;
      used: number;
      total: number;
      pct: number;
      lastUpdated?: string;
      modelName?: string;
    }
    ```

    **Step 3 — extend `gui/src/api.ts`:**
    ```typescript
    getChatSessionBudget: (sessionId: string, total: number): Promise<ChatSessionBudget> =>
      invoke("get_chat_session_budget", { sessionId, total }),
    listChatSessionBudgets: (): Promise<ChatSessionBudget[]> =>
      invoke("list_chat_session_budgets"),
    ```

    **Step 4 — create `gui/src/lib/modelContextWindows.ts`** (mirror of `src/domain/model-context-windows.ts`, GUI-side):
    ```typescript
    /**
     * GUI-side mirror of `src/domain/model-context-windows.ts`. Adding a
     * new model REQUIRES adding it to BOTH files in the same PR; the
     * sibling test `gui/src/lib/modelContextWindows.test.ts` asserts the
     * tables stay in sync (drift guard, M9).
     */
    export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
      "claude-sonnet-4-5": 200_000,
      "claude-opus-4-7": 1_000_000,
      "claude-haiku-3-5": 200_000,
      "gpt-5": 200_000,
      "o3-mini": 200_000,
    };

    export const DEFAULT_CONTEXT_WINDOW = 200_000;

    export function resolveContextWindow(modelName?: string | null): number {
      if (!modelName) return DEFAULT_CONTEXT_WINDOW;
      return MODEL_CONTEXT_WINDOWS[modelName] ?? DEFAULT_CONTEXT_WINDOW;
    }
    ```

    **Step 5 — create `gui/src/components/ContextWindowBar.tsx`** mirroring `AutonomousSessionHeader.tsx` (149 LOC reference):

    ```tsx
    import { useEffect, useState } from "react";
    import { api } from "../api";
    import type { ChatSessionBudget } from "../types";
    import { tokenPctSeverity } from "../lib/tokenSeverity";

    type Props = {
      sessionId: string;
      model?: string;
      total: number;
      refreshTick: number;
    };

    export function ContextWindowBar({ sessionId, model, total, refreshTick }: Props): JSX.Element | null {
      const [budget, setBudget] = useState<ChatSessionBudget | null>(null);
      useEffect(() => {
        let mounted = true;
        api.getChatSessionBudget(sessionId, total).then((b) => {
          if (mounted) setBudget(b);
        }).catch(() => { /* swallow — bar just won't render */ });
        return () => { mounted = false; };
      }, [sessionId, total, refreshTick]);

      if (!budget) return null;
      const severity = tokenPctSeverity(budget.pct);
      const usedK = (budget.used / 1000).toFixed(1);
      const totalK = (budget.total / 1000).toFixed(0);
      return (
        <div className={`context-window-bar metric--tokens-${severity}`}>
          <span className="context-window-bar__label">ctx {budget.pct.toFixed(0)}%</span>
          <span className="context-window-bar__counts">{usedK}K / {totalK}K tokens</span>
          {model && <span className="context-window-bar__model">{model}</span>}
          <div className="context-window-bar__rail">
            <div className="context-window-bar__fill" style={{ width: `${Math.min(100, budget.pct)}%` }} />
          </div>
        </div>
      );
    }
    ```

    **Step 6 — wire into `CenterPane.tsx`** beneath the channel/session header (per RESEARCH Q11). Pull `total = resolveContextWindow(model)` from `gui/src/lib/modelContextWindows.ts`.

    **Step 7 — worst-session chip in `Sidebar.tsx` (or App top-bar)**:
    In the App-level `refreshTick`, fetch `api.listChatSessionBudgets()`, compute `max(pct)`, and if `>= 75` render a chip near `UpdateBanner` with text "ctx N% — sess-..." and an `onClick` that selects the channel. The Tauri backend already filters to `kind === "chat"` (Task 6 step 3), so no extra TS-side filter needed.

    **Step 8 — CSS in `gui/src/styles.css`**:
    Reuse the existing `.metric--tokens-ok / -warn / -hot / -overrun` classes (already exist for `AutonomousSessionHeader`). Add new `.context-window-bar`, `.context-window-bar__rail`, `.context-window-bar__fill` styles using existing `var(--color-...)` tokens. ~40 LOC.

    **Step 9 — extend the test scaffolds from Task 0** (`ContextWindowBar.test.tsx` + `modelContextWindows.test.ts`) to GREEN: render with various pct values, assert severity classes flip at the threshold boundaries; assert the GUI table deep-equals the canonical TS table.

    **Conventions:** No `window.prompt|confirm|alert` (banned by format-check per CONVENTIONS.md). PascalCase component file. Tests sit beside the component. Sub-800 LOC budget — comfortably under.
  </action>
  <verify>
    <automated>pnpm -C gui test ContextWindowBar tokenSeverity modelContextWindows AutonomousSessionHeader 2>&1 | tail -30 && pnpm -C gui build 2>&1 | tail -10 && cargo check --workspace --locked 2>&1 | tail -5</automated>
  </verify>
  <done>GUI tests pass (ContextWindowBar, AutonomousSessionHeader using shared util, modelContextWindows drift test); `tokenPctSeverity` exported from `gui/src/lib/tokenSeverity.ts` and used by both consumers; `cd gui && pnpm build` succeeds; new Tauri commands compile; visual smoke (manual, Task 8) — running the GUI shows the bar update as a chat session consumes tokens. The worst-session chip appears in the sidebar when any chat session crosses 75% (and ONLY chat sessions surface, not admin/run).</done>
</task>

<task type="checkpoint:human-verify" gate="blocking">
  <name>Task 8: GUI visual verification</name>
  <what-built>
    - `gui/src/components/ContextWindowBar.tsx` rendering severity-colored percent bar in the chat session header.
    - Worst-session chip in the sidebar when any active chat session is at >= 75% (filtered by `kind == "chat"`).
    - Tauri commands `get_chat_session_budget` and `list_chat_session_budgets` plumbing live data from `~/.relay/sessions/<sessId>/budget.jsonl`.
    - Shared `tokenPctSeverity` util in `gui/src/lib/tokenSeverity.ts`, consumed by both AutonomousSessionHeader and ContextWindowBar.
  </what-built>
  <how-to-verify>
    1. From the repo root: `rly gui --rebuild` (Tauri rebuild + reload) OR `rly gui --dev` for hot-reload.
    2. Open an existing channel with a chat session that has `~/.relay/sessions/<sessId>/budget.jsonl` (you can hand-craft one for testing: `mkdir -p ~/.relay/sessions/sess-test && echo '{"ts":"2026-05-09T00:00:00Z","kind":"chat","inputTokens":150000,"outputTokens":1000,"cumulativeUsed":151000}' > ~/.relay/sessions/sess-test/budget.jsonl`).
    3. Confirm the bar renders below the chat session header showing roughly "ctx 76% (151.0K / 200K tokens)".
    4. Confirm the bar color tier:
       - 0-49% green (`metric--tokens-ok`)
       - 50-74% blue/cyan
       - 75-89% yellow (`metric--tokens-warn`)
       - 90-99% red (`metric--tokens-hot`)
       - 100%+ magenta (`metric--tokens-overrun`)
    5. Confirm the worst-session chip in the sidebar appears with text "ctx 76% — sess-test".
    6. Hand-craft an admin-keyed file: `mkdir -p ~/.relay/sessions/admin-foo && echo '{"ts":"2026-05-09T00:00:00Z","kind":"admin","inputTokens":190000,"outputTokens":1000,"cumulativeUsed":191000}' > ~/.relay/sessions/admin-foo/budget.jsonl`. Confirm the chip does NOT change to show "ctx 96% — admin-foo" — the M4 filter excludes admin sessions.
    7. Click the chip — confirm it selects the channel containing `sess-test`.
    8. Reload the GUI — confirm the bar still shows 76% (telemetry-survives-restart property — also covered by automated test in `tracker-restart-replay.test.ts`).

    **Edge cases to spot-check:**
    - Chat session with no `budget.jsonl` → bar should NOT render (returns null), no console errors.
    - `budget.jsonl` with malformed last line → bar shows the last good `cumulativeUsed`.
    - 100%+ overrun → bar fill clamped at 100% width visually but text shows actual e.g. "ctx 113%".
  </how-to-verify>
  <resume-signal>Type "approved" if the bar renders correctly, the chip click navigates as expected, AND the admin-keyed budget is correctly filtered out of the chip. Or describe any visual / data issues so Task 7's executor can iterate.</resume-signal>
</task>

<task type="auto" tdd="true">
  <name>Task 9: TUI percent bar in chat pane</name>
  <files>tui/src/ui.rs, tui/src/main.rs</files>
  <requirements>REQ-1.4</requirements>
  <behavior>
    - `draw_chat` renders a one-line `LineGauge` immediately below the chat title, showing `ctx N%` with severity color.
    - `severity_color(pct: f64) -> Color` is a pure function with unit tests covering all four tiers.
    - Bar updates on every TUI poll tick (no separate render thread needed — it reads `harness_data::load_session_budget` on each `draw_chat` call).
    - Missing `budget.jsonl` → no bar rendered (or 0% bar — pick whichever matches the autonomous-loop pattern; document in comments).
    - **Critical (H1):** A TUI-launched chat session — i.e. one dispatched via `tui/src/main.rs:2627-2779`'s `Command::new(claude_bin)` worker — populates `~/.relay/sessions/<sid>/budget.jsonl` and updates the bar live. This depends on Task 10b landing.
  </behavior>
  <action>
    **Step 1 — add `severity_color` pure helper at the top of `tui/src/ui.rs`:**
    ```rust
    /// Map context-window percent to a ratatui Color matching the GUI's
    /// AutonomousSessionHeader severity tiers (gui/src/lib/tokenSeverity.ts).
    /// Pure function — unit tested below.
    pub(crate) fn severity_color(pct: f64) -> Color {
        if pct >= 100.0 { Color::Magenta }
        else if pct >= 90.0 { Color::Red }
        else if pct >= 75.0 { Color::Yellow }
        else if pct >= 50.0 { Color::Cyan }
        else { Color::Green }
    }

    #[cfg(test)]
    mod severity_color_tests {
        use super::*;
        #[test]
        fn maps_each_tier() {
            assert_eq!(severity_color(0.0), Color::Green);
            assert_eq!(severity_color(49.9), Color::Green);
            assert_eq!(severity_color(50.0), Color::Cyan);
            assert_eq!(severity_color(74.9), Color::Cyan);
            assert_eq!(severity_color(75.0), Color::Yellow);
            assert_eq!(severity_color(89.9), Color::Yellow);
            assert_eq!(severity_color(90.0), Color::Red);
            assert_eq!(severity_color(99.9), Color::Red);
            assert_eq!(severity_color(100.0), Color::Magenta);
            assert_eq!(severity_color(150.0), Color::Magenta);
        }
    }
    ```

    **Step 2 — add the `LineGauge` strip inside `draw_chat`** at `tui/src/ui.rs:311+`:

    Per RESEARCH Pattern 5. After the title block (around `:322`), before the message list area, allocate a single line of vertical space. Use `Layout::vertical([Constraint::Length(3), Constraint::Length(1), Constraint::Min(0)])` to carve out: title (3) + bar (1) + messages (rest).

    Pull the active chat session id from `app.active_chat_session_id` (or whatever field tracks it in `tui/src/main.rs`'s `App` struct — check there first; if missing, plumb it through). Resolve `total` from a small Rust mirror of model-context-windows (or pass `200_000` as default with a TODO).

    ```rust
    use ratatui::widgets::LineGauge;

    if let Some(session_id) = app.active_chat_session_id.as_ref() {
        let total = 200_000u64; // TODO: resolve via model lookup once
                                 // chat-mode plumbs `model` to ui state.
        let budget = harness_data::load_session_budget(session_id, total);
        let pct_clamped = (budget.pct / 100.0).clamp(0.0, 1.0);
        let label = format!(
            "ctx {:.0}% ({}K / {}K)",
            budget.pct,
            budget.used / 1000,
            budget.total / 1000
        );
        let gauge = LineGauge::default()
            .filled_style(Style::default().fg(severity_color(budget.pct)))
            .label(label)
            .ratio(pct_clamped);
        frame.render_widget(gauge, bar_area);
    }
    ```

    If `app.active_chat_session_id` doesn't exist yet, plumb it in `main.rs` from the same place chat messages are loaded (search for `chat_messages` initialization).

    **Step 3 — verify no regression in existing chat layout** — manual TUI smoke + `cargo check --workspace`.

    **Acceptance dependency note (H1):** The bar is "live" only if `~/.relay/sessions/<sid>/budget.jsonl` is populated. For TUI-launched chat sessions this requires Task 10b. The success criterion "TUI-launched chat session updates the bar live" cannot be satisfied without Task 10b — they MUST land together (PR-3).

    **Sub-800 LOC budget:** This task lands at ~80 LOC across `ui.rs` + `main.rs`.
  </action>
  <verify>
    <automated>cargo check --workspace --locked && cargo test -p relay-tui severity_color</automated>
  </verify>
  <done>`severity_color` pure helper unit tests GREEN; `cargo check --workspace --locked` clean; running `rly tui` shows the bar in the chat pane (manual visual verification); a TUI-launched chat session (verified after Task 10b lands) populates `~/.relay/sessions/<sid>/budget.jsonl` and the bar updates live.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 10: Chat-mode parity — `rly chat record-usage` + GUI shell-out (D-04)</name>
  <files>src/cli/chat-record-usage.ts, src/cli/chat-context.ts, src/index.ts, gui/src-tauri/src/lib.rs</files>
  <requirements>REQ-1.1, REQ-1.2, D-04</requirements>
  <behavior>
    - `rly chat record-usage --session <id> --input <n> --output <n> [--kind chat] [--channel <id>] [--model <name>]` records into a `TokenTracker` for the given session, writes a line to `~/.relay/sessions/<id>/budget.jsonl` with `kind: "chat"` (or whatever was passed; default `"chat"` for this CLI), and (if `--channel` is given) attaches the threshold-feed bridge.
    - The GUI's chat-event Rust loop (`gui/src-tauri/src/lib.rs:1960-2300`) parses the `result` event's `usage` field and shells out to this CLI exactly once per Claude turn.
    - Both dispatch paths (orchestrator and chat-mode) produce identical-shape `budget.jsonl` files (modulo the `kind` field, which differentiates them).
  </behavior>
  <action>
    **Step 1 — add the CLI subcommand handler:**

    Extend `handleChatCommand` in `src/index.ts:2505+` with a new sub:
    ```typescript
    if (sub === "record-usage") {
      const sessionId = parseNamedArg(args, "--session");
      const input = parseNumberArg(args, "--input");
      const output = parseNumberArg(args, "--output");
      const channelId = parseNamedArg(args, "--channel"); // optional
      const model = parseNamedArg(args, "--model"); // optional
      const kindArg = parseNamedArg(args, "--kind"); // optional, default "chat"
      const kind: SessionKind = (kindArg === "run" || kindArg === "admin") ? kindArg : "chat";
      if (!sessionId || input === undefined || output === undefined) {
        console.error("Usage: rly chat record-usage --session <id> --input <n> --output <n> [--kind chat|run|admin] [--channel <id>] [--model <name>]");
        process.exitCode = 1;
        return;
      }
      await handleChatRecordUsage({ sessionId, input, output, channelId, model, kind });
      return;
    }
    ```

    Implement `handleChatRecordUsage` in a new `src/cli/chat-record-usage.ts` (NOT in `chat-context.ts` — that file already exceeds its single-purpose scope; new module per STRUCTURE.md "A new CLI subcommand"):

    ```typescript
    import { ChannelStore } from "../channels/channel-store.js";
    import { TokenTracker } from "../budget/token-tracker.js";
    import { attachThresholdFeed } from "../budget/threshold-feed-bridge.js";
    import { resolveContextWindow } from "../domain/model-context-windows.js";
    import type { SessionKind } from "../domain/session-budget.js";

    export interface ChatRecordUsageArgs {
      sessionId: string;
      input: number;
      output: number;
      channelId?: string;
      model?: string;
      kind?: SessionKind;
    }

    /**
     * Record a chat-mode token usage into the same `~/.relay/sessions/<id>/budget.jsonl`
     * pipeline the orchestrator uses. Per D-04, this is the parallel hook for
     * dispatch paths that don't go through OrchestratorV2: the GUI's
     * `gui/src-tauri/src/lib.rs` chat-event loop AND the TUI's
     * `tui/src/main.rs:2627-2779` chat-event worker (Task 10b). Both shell
     * out to this CLI so persistence shape is identical regardless of
     * dispatch path.
     */
    export async function handleChatRecordUsage(args: ChatRecordUsageArgs): Promise<void> {
      const ceiling = resolveContextWindow(args.model);
      const tracker = new TokenTracker(args.sessionId, ceiling, { kind: args.kind ?? "chat" });
      let unsubscribe: (() => void) | null = null;
      if (args.channelId) {
        const channelStore = new ChannelStore();
        unsubscribe = attachThresholdFeed(tracker, args.channelId, channelStore, {
          modelName: args.model,
        });
      }
      try {
        tracker.record(args.input, args.output);
        await tracker.flush();
      } finally {
        unsubscribe?.();
        await tracker.close();
      }
    }
    ```

    **Step 2 — add a comment block to `src/cli/chat-context.ts`** at the top indicating the parallel-hook contract (D-04) and pointing at `chat-record-usage.ts`.

    **Step 3 — wire the GUI shell-out in `gui/src-tauri/src/lib.rs`:**

    Inside the chat-event streaming loop (around `:2129+` where `match json.get("type")` arms are processed), add a `Some("result")` arm that:
    1. Extracts `usage.input_tokens`, `usage.output_tokens`, `usage.cache_read_input_tokens` (sum into input).
    2. Extracts the session id (from `final_session_id` or the prior `system.init` event).
    3. Spawns `rly chat record-usage --session <sid> --input <n> --output <n> --kind chat --channel <chid> --model <model>` via the existing pattern in `lib.rs:2034` (which already uses `cli_bin()` + `augmented_child_path()`).

    Verify in-scope at the call site: `cli_bin()` (declared at module scope), `augmented_child_path()` (declared at module scope), `final_session_id` (declared in the streaming closure), `channel_id_thread` and `model_thread` (passed into the closure via Arc/clone before `for line in reader.lines()`). If `model_thread` is not currently captured into the closure, plumb it through — this is a sub-step of Task 10 documented here, not a separate task.

    ```rust
    Some("result") => {
        if let Some(usage) = json.get("usage").and_then(|u| u.as_object()) {
            let input = usage.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0)
                + usage.get("cache_read_input_tokens").and_then(|v| v.as_u64()).unwrap_or(0)
                + usage.get("cache_creation_input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
            let output = usage.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
            if let Some(sid) = final_session_id.as_ref() {
                let channel_arg = format!("--channel={}", channel_id_thread);
                let model_arg = format!("--model={}", model_thread.as_deref().unwrap_or(""));
                let _ = std::process::Command::new(cli_bin())
                    .args(["chat", "record-usage",
                           "--session", sid,
                           "--input", &input.to_string(),
                           "--output", &output.to_string(),
                           "--kind", "chat"])
                    .arg(&channel_arg)
                    .arg(&model_arg)
                    .env("PATH", augmented_child_path())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn();  // fire-and-forget; the CLI handles persistence
            }
        }
    }
    ```

    Per AGENTS.md: any new `Command::new` here MUST `.env("PATH", augmented_child_path())` to survive Finder-launched-app PATH stripping. Reuse the existing `cli_bin()` helper.

    **Step 4 — make Task 0's `test/cli/chat-record-usage.test.ts` GREEN.**
  </action>
  <verify>
    <automated>pnpm test test/cli/chat-record-usage.test.ts && pnpm typecheck && cargo check --workspace --locked</automated>
  </verify>
  <done>`rly chat record-usage --session sess-x --input 100 --output 50` writes a line to `~/.relay/sessions/sess-x/budget.jsonl` with `kind: "chat"`; the GUI's Rust streamer shells out exactly once per `result` event; budget files generated by chat-mode and orchestrator are bit-for-bit indistinguishable in shape EXCEPT the `kind` discriminator; the existing autonomous-loop pipeline is unchanged.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 10b: TUI chat-event shell-out — H1 dispatch parity (BLOCKING for Task 9 acceptance)</name>
  <files>tui/src/main.rs, crates/relay-paths/src/lib.rs (NEW shared crate; Cargo.toml additions in workspace + tui + gui-src-tauri), gui/src-tauri/src/lib.rs (refactor `augmented_child_path` and `cli_bin` to delegate to shared crate)</files>
  <requirements>REQ-1.1, REQ-1.2, REQ-1.4, D-04</requirements>
  <behavior>
    - The TUI's Claude chat worker (`tui/src/main.rs:2627-2779`) extracts `usage` from the JSONL `result` event AND shells out to `rly chat record-usage --session <sid> --input <n+cache> --output <n> --kind chat --channel <chid> --model <model>` exactly once per Claude turn.
    - The shell-out uses `cli_bin()` and `augmented_child_path()` — hoisted to a shared `crates/relay-paths` crate consumed by both `tui` and `gui-src-tauri` so the launchd-PATH-strip workaround is single-source.
    - A TUI-launched chat session populates `~/.relay/sessions/<sid>/budget.jsonl` and the TUI bar (Task 9) updates live.
  </behavior>
  <action>
    **Why a separate task:** The original plan's Task 10 Step 4 conditionally added the TUI shell-out "if TUI has its own dispatch path." Verification of `tui/src/main.rs:2627-2779` confirmed it spawns Claude directly via `Command::new(&claude_bin)` at `:2686` — it does NOT route through `rly`. This task makes the fix BLOCKING and unconditional. It is the H1 mitigation.

    **Step 1 — hoist `augmented_child_path()` and `cli_bin()` to a shared crate:**

    Create `crates/relay-paths/Cargo.toml`:
    ```toml
    [package]
    name = "relay-paths"
    version = "0.1.0"
    edition = "2021"

    [dependencies]
    # No runtime deps beyond std.
    ```

    Move the body of `augmented_child_path()` (currently `gui/src-tauri/src/lib.rs:681-696`) and `compute_augmented_path()` (`:757+`), `resolve_shell_path()` (`:715-752`) into `crates/relay-paths/src/lib.rs`. Export as `pub fn augmented_child_path() -> String`. Move `cli_bin()` similarly (currently in `gui/src-tauri/src/lib.rs`; one-liner `which("rly")` style helper).

    Update `gui/src-tauri/src/lib.rs` to `use relay_paths::{augmented_child_path, cli_bin};` and delete the local definitions. Add `relay-paths = { path = "../../crates/relay-paths" }` to `gui/src-tauri/Cargo.toml`.

    Update `tui/src/main.rs` to `use relay_paths::{augmented_child_path, cli_bin};`. Add `relay-paths = { path = "../crates/relay-paths" }` to `tui/Cargo.toml`. Add the new crate to workspace `members` in the root `Cargo.toml`.

    **PR-3 LOC implication (flagged per H1):** This relocation adds ~150 LOC of crate scaffolding + ~20 LOC of import-site changes. PR-3 is the natural home (Wave 2: dashboards), but it pushes the LOC closer to the 800 ceiling. If PR-3 trends >800, split: PR-3a = Task 6 + Task 7 (GUI bar, dashboards) — wait, Task 6 is in PR-1; PR-3a = Task 7 only; PR-3b = Tasks 9 + 10b (TUI bar + TUI dispatch parity + crate hoist). Document the chosen split in the PR description.

    **Step 2 — capture `usage` in the TUI chat worker:**

    Edit `tui/src/main.rs` around `:2700` (just before `for line in reader.lines()`):
    ```rust
    let mut captured_usage: Option<serde_json::Value> = None;
    let mut captured_input_total: u64 = 0;
    let mut captured_output_total: u64 = 0;
    ```

    In the `Some("result")` arm at `:2751-2769`, add `usage` capture immediately after the `session_id` capture:
    ```rust
    Some("result") => {
        if let Some(sid) = json.get("session_id").and_then(|v| v.as_str()) {
            session_id = Some(sid.to_string());
            let _ = evt_tx.send(WorkerEvent::ClaudeSessionId(sid.to_string()));
        }
        if let Some(usage) = json.get("usage").and_then(|u| u.as_object()) {
            // Capture the result-event usage; ignore mid-stream
            // assistant.message.usage events per pitfall #2 from research.
            captured_input_total = usage.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0)
                + usage.get("cache_read_input_tokens").and_then(|v| v.as_u64()).unwrap_or(0)
                + usage.get("cache_creation_input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
            captured_output_total = usage.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
            captured_usage = Some(serde_json::Value::Object(usage.clone()));
        }
        if !got_assistant_text {
            // ... existing fallback text emit ...
        }
    }
    ```

    **Step 3 — fire-and-forget the `rly chat record-usage` shell-out after `child.wait()` resolves:**

    After `let _ = child.wait();` at `:2779`:
    ```rust
    let _ = child.wait();

    // H1 dispatch-parity fix: persist the captured usage via `rly chat
    // record-usage` so this TUI-launched session writes to the same
    // ~/.relay/sessions/<id>/budget.jsonl pipeline the GUI and
    // OrchestratorV2 use. Fire-and-forget; failures log to stderr but
    // don't abort the chat loop.
    if let (Some(_usage), Some(sid)) = (captured_usage.as_ref(), session_id.as_ref()) {
        let mut args: Vec<String> = vec![
            "chat".into(),
            "record-usage".into(),
            "--session".into(), sid.clone(),
            "--input".into(), captured_input_total.to_string(),
            "--output".into(), captured_output_total.to_string(),
            "--kind".into(), "chat".into(),
        ];
        if let Some(ref ch_id) = channel_id_owned {
            args.push("--channel".into());
            args.push(ch_id.clone());
        }
        // model_owned is captured into the worker thread alongside
        // channel_id_owned; if not currently captured, plumb it from the
        // App struct (search for where `auto_approve` is plumbed).
        if let Some(ref model) = model_owned {
            args.push("--model".into());
            args.push(model.clone());
        }
        let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        let spawn_result = std::process::Command::new(cli_bin())
            .args(&arg_refs)
            .env("PATH", augmented_child_path())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
        if let Err(e) = spawn_result {
            eprintln!("[budget] rly chat record-usage shell-out failed: {e}");
        }
    }

    let _ = evt_tx.send(WorkerEvent::Done(session_id.clone()));
    ```

    `model_owned` is the model name passed into the worker thread. If not currently captured (verify by grepping `Arc::clone` calls before `std::thread::spawn` in this region), plumb it from the App struct's chat-session model field. This is a sub-step within Task 10b, not a separate task.

    **Step 4 — verification test:**

    Add `tui/tests/dispatch_parity.rs` (Rust integration test, optional but recommended): launch the TUI worker thread with a mock JSONL stream containing a `result` event with `usage`; assert the spawned `Command` matches the expected argv (use a `MockCommand` trait OR shell out to a no-op `rly` script under `tmpdir/PATH`). If integration is too heavy for Phase 1, document the manual verification path: `rly tui` → start a chat → after the model responds, `cat ~/.relay/sessions/<sid>/budget.jsonl` → confirm a line exists with `kind: "chat"` and the expected `cumulativeUsed`.

    **Sub-800 LOC budget:** Crate hoist (~150 LOC) + TUI capture/spawn (~60 LOC) + workspace + Cargo.toml updates (~20 LOC) = ~230 LOC. Combined with Task 9 (~80 LOC) and Task 7 (~250 LOC of GUI), PR-3 lands ~560 LOC — under budget. If a PR-3 split is needed, see Step 1 contingency.
  </action>
  <verify>
    <automated>cargo check --workspace --locked && cargo test -p relay-paths && cargo build -p relay-tui && cargo build -p relay-gui-lib</automated>
  </verify>
  <done>`crates/relay-paths` crate exists with `augmented_child_path` + `cli_bin` exported; both `tui` and `gui-src-tauri` import from it (no duplicated definitions); `tui/src/main.rs:2627-2779` captures `usage` from the `result` arm, shells out via `Command::new(cli_bin()).env("PATH", augmented_child_path())` after `child.wait()` resolves; a TUI-launched Claude chat session produces a non-empty `~/.relay/sessions/<sid>/budget.jsonl` with `schemaVersion: 1`, `kind: "chat"`, and the expected `cumulativeUsed`; Task 9's bar updates live for TUI-launched sessions.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 11: CLI surfacing — `rly status` + session listing</name>
  <files>src/index.ts, src/cli/print-status-context.ts (new module)</files>
  <requirements>REQ-1.6</requirements>
  <behavior>
    - `rly status` includes an `Active sessions:` block listing each session with `ctx N% (used / total tokens) — model`.
    - The block reads from `~/.relay/sessions/<id>/budget.jsonl` files, filters to `kind === "chat"` (M3 / M4), scoped to those with mtime within the last 24h (cheap freshness heuristic).
    - `rly session list` (existing subcommand) gains a `--with-context` flag (or always includes) that adds the same per-session context line.
    - Plain text only — no color helper (research Q12).
    - `loadActiveSessions()` MUST guard with `existsSync(root)` and catch per-file parse errors so one bad file doesn't poison the whole list (L3).
  </behavior>
  <action>
    **Step 1 — extract a pure formatter `formatActiveSessionsBlock`** into `src/cli/print-status-context.ts`:
    ```typescript
    import { existsSync } from "node:fs";
    import { readdir, readFile, stat } from "node:fs/promises";
    import { join } from "node:path";
    import { getRelayDir } from "../config/relay-dir.js";
    import { resolveContextWindow } from "../domain/model-context-windows.js";

    export interface ActiveSessionRow {
      sessionId: string;
      channelId?: string;
      pct: number;
      used: number;
      total: number;
      model?: string;
    }

    export function formatActiveSessionsBlock(rows: ActiveSessionRow[]): string {
      if (rows.length === 0) return "";
      const lines = ["Active sessions:"];
      for (const r of rows) {
        const usedK = (r.used / 1000).toFixed(0);
        const totalK = (r.total / 1000).toFixed(0);
        const channel = r.channelId ? ` (channel: ${r.channelId})` : "";
        const model = r.model ? ` — ${r.model}` : "";
        lines.push(
          `- ${r.sessionId}${channel} ctx ${r.pct.toFixed(0)}% (${usedK}K / ${totalK}K tokens)${model}`
        );
      }
      return lines.join("\n");
    }

    /**
     * Walk `~/.relay/sessions/<id>/budget.jsonl` files. L3: guard against
     * missing root + per-file parse errors (one bad file doesn't poison
     * the list). M3 / M4: filter to `kind === "chat"` only — admin and
     * orchestrator-run keyspaces are excluded.
     */
    export async function loadActiveSessions(opts?: { maxAgeMs?: number }): Promise<ActiveSessionRow[]> {
      const root = join(getRelayDir(), "sessions");
      if (!existsSync(root)) return [];
      const maxAge = opts?.maxAgeMs ?? 24 * 60 * 60 * 1000;
      const now = Date.now();
      let entries: string[];
      try {
        entries = await readdir(root);
      } catch {
        return [];
      }
      const rows: ActiveSessionRow[] = [];
      for (const name of entries) {
        const dir = join(root, name);
        const file = join(dir, "budget.jsonl");
        try {
          const st = await stat(file);
          if (now - st.mtimeMs > maxAge) continue;
          const content = await readFile(file, "utf8");
          const lastLine = content.trim().split("\n").filter(Boolean).pop();
          if (!lastLine) continue;
          const parsed = JSON.parse(lastLine);
          if (parsed.kind !== "chat") continue; // M3 / M4 filter
          const used = typeof parsed.cumulativeUsed === "number" ? parsed.cumulativeUsed : 0;
          const model = typeof parsed.model === "string" ? parsed.model : undefined;
          const total = resolveContextWindow(model);
          const pct = total === 0 ? 0 : (used / total) * 100;
          rows.push({
            sessionId: name,
            channelId: typeof parsed.channelId === "string" ? parsed.channelId : undefined,
            pct,
            used,
            total,
            model,
          });
        } catch (err) {
          // L3: per-file error isolation. Log and skip — don't poison.
          const message = err instanceof Error ? err.message : String(err);
          console.warn(`[budget] skipping malformed session file ${file}: ${message}`);
          continue;
        }
      }
      return rows;
    }
    ```

    **Step 2 — wire into `printStatus` in `src/index.ts:2747`:**
    Before the `Recent runs:` block, call `loadActiveSessions()` + `formatActiveSessionsBlock()` and append the result to the printed output. Skip emission when zero active sessions.

    **Step 3 — extend `handleSessionCommand`** (find via `command === "session"` route at `src/index.ts:148`) to include the same per-session context line in its output. Keep the existing `--json` branch intact — the `ctx N%` line goes only in human-readable mode.

    **Step 4 — make Task 0's `test/cli/print-status-context.test.ts` GREEN** by exercising the pure formatter directly AND the `loadActiveSessions` filter / error-isolation paths.

    **Conventions:** New file uses `kebab-case`, ESM `.js` imports, two-space indent, double quotes, semicolons, trailing commas. Sub-800 LOC budget — well under (~150 LOC).
  </action>
  <verify>
    <automated>pnpm test test/cli/print-status-context.test.ts && pnpm typecheck && pnpm build</automated>
  </verify>
  <done>`rly status` against a tmp `~/.relay/` with a hand-crafted `sessions/sess-x/budget.jsonl` (kind=chat) shows the new block; admin/run-keyed budgets are excluded; missing `sessions/` dir returns empty (no throw); malformed files are skipped with a warning (other files still surface); pure formatter unit-tested; `pnpm build` succeeds (production `dist/` valid).</done>
</task>

<task type="auto">
  <name>Task 12: Phase gate — full verification + docs sync</name>
  <files>README.md, docs/getting-started.md, .changeset/*.md</files>
  <requirements>REQ-1.8, REQ-1.9</requirements>
  <action>
    **Step 1 — full verification suite:**
    ```bash
    pnpm test && pnpm typecheck && pnpm build
    cargo check --workspace --locked && cargo test --workspace
    cd gui && pnpm build && pnpm test
    ```
    All green. Any RED test → loop back to the appropriate Task and fix before continuing.

    **Step 2 — schema-drift sanity:**
    Verify the cross-dashboard contract (AGENTS.md:101-105):
    ```bash
    grep -n "SessionBudget\|tokenUsage" src/domain/*.ts crates/harness-data/src/lib.rs
    grep -n "schemaVersion" src/domain/session-budget.ts crates/harness-data/src/lib.rs
    grep -n "kind" src/domain/session-budget.ts crates/harness-data/src/lib.rs
    ```
    Confirm: `SessionBudget` exists in TS + Rust with matching field names (camelCase ↔ snake_case via `#[serde(rename_all = "camelCase")]`); `schemaVersion` defaults to 1 on both sides; `kind` is present on both with `chat | run | admin` variants; default is `admin`.

    **Step 3 — README sync:**
    Update `README.md` in two places:
    - **Known limits section:** strike "Cost guardrails not yet implemented. Token usage isn't tracked or capped." Replace with a more accurate "Per-session context-window telemetry ships in Phase 1; cost tracking and per-run budget caps are a follow-up."
    - **`~/.relay/` file-layout tree:** add `sessions/<sessionId>/budget.jsonl` under the existing `sessions/` entry (currently autonomous-only — clarify it now includes chat sessions too, with a `kind` discriminator).

    **Step 4 — `docs/getting-started.md` sync:**
    Add a one-paragraph mention of the context-window bar in the "What you'll see" section (or equivalent). Point users at `rly status` for the CLI surface.

    **Step 5 — Changeset:**
    Create `.changeset/phase-1-context-bar.md`:
    ```
    ---
    "@jcast90/relay": minor
    ---

    Per-session context-window telemetry — TUI / GUI / CLI now show a `% of context window consumed` indicator per Claude or Codex chat session. Threshold events fire on the channel feed at 75 / 90 / 95 % — the 90% event is the trigger Phase 2's `rly handoff` will subscribe to. Persisted under `~/.relay/sessions/<sessionId>/budget.jsonl` with a `kind: "chat" | "run" | "admin"` discriminator; survives process restart. TUI-launched chat sessions (via `rly tui`'s direct Claude worker) record telemetry through the same `rly chat record-usage` sink as the GUI.
    ```

    **Step 6 — Phase-2 handoff to plan-phase:**
    Update `.planning/notes/handoff-feature-design.md` with a new "Phase 1 contract" section pointing at `docs/design/context-threshold-events.md`. This is what Phase 2's planner reads to know which event shape to subscribe to.

    **Step 7 — final goal-backward check:** Walk the `must_haves.truths` list. Most are now automated. Specifically:
    1. **"Telemetry survives a process restart"** — automated by `test/budget/tracker-restart-replay.test.ts` (Task 0 test #12). Confirm the test runs in `pnpm test` output.
    2. **"Threshold events at 75/90/95 fire reliably"** — automated by `test/budget/threshold-feed-bridge.test.ts` (multi-tracker test from M5). Confirm it ran.
    3. **"Works for both Claude and Codex sessions"** — automated by `test/agents/cli-agents-claude-usage.test.ts` and `test/agents/cli-agents-codex-usage.test.ts`. Confirm both ran.
    4. **"TUI-launched chat session updates the bar live"** — automated where possible by Task 10b's optional `tui/tests/dispatch_parity.rs`; otherwise manually verify by running `rly tui`, starting a chat, waiting for one model response, then `cat ~/.relay/sessions/<sid>/budget.jsonl` to confirm a `kind: "chat"` line landed.
    5. **"Phase 2's planner has a stable contract"** — `docs/design/context-threshold-events.md` exists and contains the contract including the M8 sharpening.
  </action>
  <verify>
    <automated>pnpm test && pnpm typecheck && pnpm build && cargo check --workspace --locked && cargo test --workspace && cd gui && pnpm build && pnpm test 2>&1 | tail -20</automated>
  </verify>
  <done>All gate commands GREEN; README + docs updated in same PR group as code (per AGENTS.md "Update docs in the same PR"); changeset present; `docs/design/context-threshold-events.md` is the single source of truth for Phase 2's threshold-event contract; `.planning/notes/handoff-feature-design.md` cross-references it; tracker-restart-replay automated test confirms the survives-restart property without manual verification.</done>
</task>

</tasks>

<wave_structure>

**Wave 0 (parallel-safe):** Tasks 0, 1, 2, 6
- Task 0 (test scaffolds): RED tests for everything; bundles into PR-1 with Tasks 2 + 6.
- Task 1 (Codex spike): assumption_check A1; produces `01-SPIKE-A1.md` with machine-readable `BRANCH=` + `STREAM_FLAG=` lines.
- Task 2 (TS shape: THRESHOLDS widening + domain shapes + model table) — same PR-1 as Tasks 0 + 6.
- Task 6 (Rust mirror + harness-data loader) — same PR-1 as Tasks 0 + 2 (cross-dashboard contract per AGENTS.md).

**Wave 1 (parallel-safe; PR-2):** Tasks 3, 4, 5
- Task 3 (adapter usage extraction) — touches `cli-agents.ts`, `domain/agent.ts`. Depends on Task 1's spike output and Task 2's `TokenUsage` type.
- Task 4 (tracker pool + dispatch wire) — touches `orchestrator-v2.ts`, new `session-tracker-pool.ts`. Depends on Tasks 2 + 3 + 6.
- Task 5 (threshold-feed bridge + Phase 2 contract doc) — depends on Task 2 (THRESHOLDS list) + Task 4 (tracker hand-off).

PR-2 LOC re-walked (per L1): Task 3 (~250) + Task 4 (~170) + Task 5 (~220) + design doc (~80) = ~720 LOC. Under budget.

**Contingency (L1):** If PR-2 trends >800 LOC during execution, split:
- **PR-2a:** Task 3 + Task 5 (adapter + bridge + design doc) — independent of Task 4.
- **PR-2b:** Task 4 (orchestrator wiring) — depends on PR-2a's `tokenUsage` field.

**Wave 2 (parallel-safe; PR-3 dashboards):** Tasks 7, 8 (checkpoint), 9, 10b
- Task 7 (GUI bar + chip + shared util extraction) — depends on Task 6 (Tauri command + `kind` filter).
- Task 8 (human checkpoint) — verifies Task 7 visually.
- Task 9 (TUI bar) — depends on Task 6 (`harness_data::load_session_budget`); acceptance depends on Task 10b.
- Task 10b (TUI dispatch parity, H1 fix) — must land with Task 9 to satisfy "TUI-launched chat session updates the bar live."

PR-3 LOC: Task 7 (~250) + Task 9 (~80) + Task 10b (~230, includes shared `relay-paths` crate) = ~560 LOC.

**Contingency:** If PR-3 trends >800 LOC, split:
- **PR-3a:** Task 7 + Task 8 (GUI dashboard) — independent of TUI.
- **PR-3b:** Task 9 + Task 10b (TUI dashboard + dispatch parity + crate hoist).

**Wave 3 (PR-4; surfaces):** Tasks 10, 11
- Task 10 (chat-mode CLI + GUI shell-out) — depends on Tasks 4, 5 (tracker + bridge wiring).
- Task 11 (CLI status surface) — depends on Task 6 (loader for the formatter); reuses `kind: "chat"` filter from Task 6.

PR-4 LOC: Task 10 (~150) + Task 11 (~150) = ~300 LOC.

**Wave 4 (PR-5; gate + docs):** Task 12
- Final verification + README/docs sync + changeset + Phase-2 handoff note.

PR-5 LOC: ~150 LOC.

**PR boundaries (sub-800 LOC discipline) — REVISED per H2:**
- **PR-1:** Wave 0 — Tasks 0 + 1 + 2 + 6 (test scaffolds + spike + TS shape + Rust mirror). Each test compiles against landed types; `pnpm typecheck && cargo check --workspace --locked` BOTH pass independently. ~750 LOC.
- **PR-2:** Wave 1 — Tasks 3 + 4 + 5 (adapter + dispatch + bridge + design doc). ~720 LOC. Contingent split documented above.
- **PR-3:** Wave 2 — Tasks 7 + 8 + 9 + 10b (dashboards + dispatch parity). ~560 LOC. Contingent split documented above.
- **PR-4:** Wave 3 — Tasks 10 + 11 (CLI subcommand + GUI shell-out + status block). ~300 LOC.
- **PR-5:** Wave 4 — Task 12 (docs + changeset + handoff note). ~150 LOC.

Each PR includes its own tests going GREEN (Task 0's scaffolds turn GREEN incrementally as each later wave lands). PR-1's RED tests stay RED at PR-1 merge time; PR-2 turns ~80% of them GREEN; PR-3 turns the rest GREEN.
</wave_structure>

<verification>
**Per-task automated verification:** see each `<verify>` block.

**Phase-level verification (Task 12 gate):**
```bash
# Default (scripted) tier
pnpm test && pnpm typecheck && pnpm build
# Rust workspace
cargo check --workspace --locked && cargo test --workspace
# GUI workspace
cd gui && pnpm build && pnpm test
# Format check (CI parity)
pnpm format:check
```

**Manual / live smoke (NOT in CI — gate before tagging):**
1. Run `claude` directly in a test repo via `rly claude` and confirm the GUI bar updates as you type and the model responds.
2. Run `codex exec` (if installed) the same way; confirm the bar updates after the call resolves.
3. Run `rly tui`, start a chat session against Claude. Send a message. After the response, `cat ~/.relay/sessions/<sid>/budget.jsonl` and confirm a line with `kind: "chat"` and the expected `cumulativeUsed` lands. (H1 acceptance.)
4. Hand-craft a `~/.relay/sessions/sess-test/budget.jsonl` (with `kind: "chat"`) and `cumulativeUsed: 180000` and load `rly tui` — confirm the chat pane shows "ctx 90%" in red.
5. Tail `~/.relay/channels/<chid>/feed.jsonl` while running a session that crosses 90% — confirm exactly one `status_update` entry with `metadata.kind === "context_threshold"` per crossing.
6. Restart GUI and TUI mid-session — confirm both surfaces show the prior cumulative usage (replay invariant; also covered by `tracker-restart-replay.test.ts`).
</verification>

<success_criteria>
- All `must_haves.truths` observable on a live Claude session.
- All `must_haves.artifacts` exist with the right exports/contents.
- All `must_haves.key_links` produce visible behavior end-to-end (adapter → orchestrator → tracker → disk → dashboard reader → render).
- `THRESHOLDS = [50, 60, 75, 85, 90, 95, 100]` in the canonical location.
- `~/.relay/sessions/<sessId>/budget.jsonl` is the single persistence surface for autonomous, orchestrator-run, AND chat sessions, distinguished by `kind: "chat" | "run" | "admin"`.
- Threshold events at 75/90/95 fire EXACTLY ONCE per crossing per session on the channel feed; `metadata.pct` matches `/^\d+\.\d{2}$/`.
- `docs/design/context-threshold-events.md` documents the Phase 2 contract with the D-03 handoff-id rule AND the M8 sharpening that Phase 1 does not enforce 0% in code.
- Cross-dashboard contract (AGENTS.md:101-105) honored: TS `SessionBudget` ↔ Rust `SessionBudget` in the same PR (PR-1).
- TUI-launched chat sessions (via `tui/src/main.rs:2627-2779`) record telemetry to disk via `rly chat record-usage` shell-out; the TUI bar updates live for these sessions (H1 acceptance).
- `pnpm test && pnpm typecheck && pnpm build && cargo test --workspace && cd gui && pnpm build && pnpm test` all GREEN.
- Sub-800 LOC discipline: every PR in the wave structure stays under 800 added LOC; splits documented inline.
- No drive-by reformats; no snapshot tests; no `window.prompt|confirm|alert`; no direct `homedir() + ".relay"` (all through `getRelayDir()` / `harness_root()`).
- `tokenPctSeverity` is exported from `gui/src/lib/tokenSeverity.ts` and consumed by both `AutonomousSessionHeader` and `ContextWindowBar` (no copy-paste).
- `augmented_child_path()` and `cli_bin()` live in `crates/relay-paths` and are consumed by both `tui` and `gui-src-tauri` (single source of truth for the launchd-PATH-strip workaround).
</success_criteria>

<output>
After completion, create `.planning/phases/01-token-usage-telemetry-context-bar/01-SUMMARY.md` (standard filename per L5).

The summary MUST include:
- A1 spike result (BRANCH=A | B | INCONCLUSIVE) and `STREAM_FLAG=<name|NONE>`, plus how Task 3 implemented the documented branch.
- Final THRESHOLDS list and reachable-from-disk confirmation (`grep` against the canonical file).
- The exact `metadata` shape posted to the feed for the 90% threshold (verbatim JSON example).
- The PR-group recommendation actually used (matched the wave structure or split differently — and why; cite L1/PR-2 split or H1/PR-3 split if either was triggered).
- Any test that needed `HARNESS_LIVE=1` (should be NONE; flag if any leaked).
- A pointer to `docs/design/context-threshold-events.md` for Phase 2's planner.
- Confirmation of H1 closure: a sample `~/.relay/sessions/<sid>/budget.jsonl` from a TUI-launched chat session (showing `kind: "chat"` and a non-zero `cumulativeUsed`), with the `cli_bin()` / `augmented_child_path()` shared-crate location noted.
- Confirmation of M3 closure: a sample of three budget files showing each `kind` discriminator (`chat`, `run`, `admin`) and the `list_chat_session_budgets` output asserting only `chat` surfaces.
</output>

<phase_2_handoff_contract>
**This block is read by the Phase 2 planner. Do not modify after merge.**

Phase 2's `rly handoff` planner subscribes to context-threshold events emitted by Phase 1. The contract is:

- **File:** `~/.relay/channels/<channelId>/feed.jsonl`
- **Filter:** `entry.type === "status_update" && entry.metadata?.kind === "context_threshold" && entry.metadata?.threshold === "90"`
- **Stable fields:** `metadata.sessionId`, `metadata.threshold` (string `"75"`/`"90"`/`"95"`), `metadata.pct` (string matching `/^\d+\.\d{2}$/`, e.g. `"91.23"`), `metadata.used`, `metadata.total`, `metadata.model?`, `metadata.schemaVersion === "1"`
- **Handoff session-id contract (D-03 + M8 sharpening):** A handoff creates a NEW sessionId in the destination provider. The intent is that the new tracker starts at 0%. **However, Phase 1 does NOT enforce the 0% start in code** — it only guarantees `firedThresholds` is replayed from disk for the same sessionId. To satisfy the 0% start requirement, **Phase 2 MUST mint unique sessionIds** that have no pre-existing `~/.relay/sessions/<id>/budget.jsonl`. Reusing a sessionId that has a non-zero existing budget will replay state. As a soft guard, `SessionTrackerPool.get` emits `console.warn("[budget] tracker for sessionId X is replaying non-zero state from disk")` if a brand-new sessionId surfaces a non-zero budget — Phase 2 should treat this warning as a contract violation in its CI logs.
- **Schema bumps:** Bumping `metadata.schemaVersion` requires a coordinated update across Phase 1 and Phase 2 codepaths. Breaking-change discipline.
- **Reference doc:** `docs/design/context-threshold-events.md`
- **kind discriminator:** Each `~/.relay/sessions/<id>/budget.jsonl` line includes `kind: "chat" | "run" | "admin"`. Phase 2 SHOULD filter to `kind == "chat"` when surfacing handoff candidates (the `list_chat_session_budgets` Tauri command and `loadActiveSessions` TS helper already do this for their own consumers).

Phase 2's planner SHOULD read `.planning/phases/01-token-usage-telemetry-context-bar/01-SUMMARY.md` after Phase 1 ships to confirm no drift between this contract and what shipped.
</phase_2_handoff_contract>

<goal_backward_verification>

## Goal-Backward Verification (Re-emitted, post-revision)

**Goal:** Live "% of context window consumed" indicator per session, visible in TUI/GUI/CLI status, foundational for Phase 2's 90% nudge, threshold events emitted reliably enough for Phase 2 to subscribe to.

### Step 1 — Goal restated

Per-session context-window telemetry across all three dashboards (TUI, GUI, CLI), populated by both Claude and Codex adapters across all three dispatch paths (orchestrator, GUI chat-event loop, TUI chat-event loop), persisting to `~/.relay/sessions/<sessId>/budget.jsonl`, emitting threshold events at 75/90/95% on the channel feed.

### Step 2 — Observable truths

1. User sees a percent-of-context bar in the **GUI** chat session detail view, live-updating.
2. User sees a percent-of-context bar in the **TUI** chat pane, live-updating, including for sessions launched from the TUI's own `Command::new(claude_bin)` chat dispatcher (H1).
3. User runs `rly status` and sees `Active sessions:` block with `ctx N% (used / total)` lines (filtered to `kind === "chat"`).
4. GUI sidebar shows a "worst session" chip when any active **chat** session is at >= 75% (M4).
5. Telemetry survives a process restart — GUI close/reopen shows the prior cumulative usage (verified by `tracker-restart-replay.test.ts`).
6. Threshold events at 75/90/95 percent appear in the channel feed as `status_update` entries with `metadata.kind == "context_threshold"`.
7. The same feature works for both Claude and Codex sessions.

### Step 3 — Required artifacts

| Path | Provides | Test |
|------|----------|------|
| `src/domain/session-budget.ts` | `SessionBudget` shape + zod schema + `kind` discriminator | `test/domain/session-budget.test.ts` |
| `src/domain/model-context-windows.ts` | `MODEL_CONTEXT_WINDOWS` table + `resolveContextWindow` | inline + `gui/src/lib/modelContextWindows.test.ts` (drift) |
| `src/budget/session-tracker-pool.ts` | One-tracker-per-sessionId pool + M8 soft-warn | `test/budget/session-tracker-pool.test.ts` |
| `src/budget/threshold-feed-bridge.ts` | 75/90/95 → channel feed, with M5 multi-tracker test + M7 pct precision test | `test/budget/threshold-feed-bridge.test.ts` |
| `src/cli/chat-record-usage.ts` | `rly chat record-usage` CLI handler with `--kind` flag | `test/cli/chat-record-usage.test.ts` |
| `src/cli/print-status-context.ts` | `formatActiveSessionsBlock` + `loadActiveSessions` (kind-filtered, error-isolated) | `test/cli/print-status-context.test.ts` |
| `crates/harness-data/src/lib.rs` (extended) | Rust `SessionBudget` + `SessionKind` + `load_session_budget` + `list_session_budgets` | `cargo test session_budget` + `list_chat_session_budgets_filters_admin` |
| `crates/relay-paths/src/lib.rs` (NEW) | Shared `augmented_child_path()` + `cli_bin()` for TUI + GUI | `cargo test -p relay-paths` |
| `gui/src/lib/tokenSeverity.ts` | Shared `tokenPctSeverity` util (extracted; M9-related hidden-assumption fix) | implicit via `ContextWindowBar.test.tsx` + `AutonomousSessionHeader.test.tsx` |
| `gui/src/lib/modelContextWindows.ts` | GUI-side mirror of canonical model table | `gui/src/lib/modelContextWindows.test.ts` (drift) |
| `gui/src/components/ContextWindowBar.tsx` | GUI percent-bar component, severity-colored | `gui/src/components/ContextWindowBar.test.tsx` |
| `tui/src/ui.rs` (extended) + `tui/src/main.rs` (extended) | `severity_color` + `LineGauge` + `result`-arm `usage` capture + shell-out | `cargo test severity_color` + `tui/tests/dispatch_parity.rs` (optional) |
| `docs/design/context-threshold-events.md` | Phase 2 subscription contract (with M8 sharpening) | inline grep in Task 5 verify |
| `test/integration/session-budget-end-to-end.test.ts` | M6 — full chain regression test | runs in `pnpm test` |
| `test/budget/tracker-restart-replay.test.ts` | Survives-restart property automated (Task 12 step 7 #1) | runs in `pnpm test` |

### Step 4 — Required wiring (key links)

| From | To | Via |
|------|-----|-----|
| `cli-agents.ts:processStreamLine` | `AgentResult.tokenUsage` | `result`-arm `obj.usage` capture; cache summed into `inputTokens` |
| `OrchestratorV2.dispatch` | `TokenTracker.record` | `if (result.tokenUsage && run.channelId)` block; hard-asserts model is set |
| `TokenTracker.onThreshold` | `ChannelStore.postEntry` | `attachThresholdFeed` filter `[75, 90, 95]` |
| `gui/src-tauri/src/lib.rs:chat-event` | `rly chat record-usage` | `Command::new(cli_bin()).env("PATH", augmented_child_path())` + `--kind chat` |
| `tui/src/main.rs:2627-2779` (H1) | `rly chat record-usage` | `result`-arm `captured_usage` + `child.wait()` post-spawn, same shell-out pattern |
| `crates/harness-data::load_session_budget` | TUI `LineGauge` + GUI `ContextWindowBar` | `harness_data::load_session_budget(sessionId, total)` per refresh tick |
| `list_chat_session_budgets()` | GUI worst-session chip | filter `kind == "chat"` server-side |
| `loadActiveSessions()` | `rly status` `Active sessions:` block | filter `kind === "chat"` + `existsSync` guard + per-file try/catch |

### Step 5 — Key links (where this is most likely to break)

1. **TUI dispatch parity** (H1) — `tui/src/main.rs` shells out to `rly` with `cli_bin()` + `augmented_child_path()`. Pattern: `grep -n "rly.*record-usage\|cli_bin()" tui/src/main.rs` should return ≥ 1 match. Breakage = bar reads 0% forever for TUI-launched sessions.
2. **kind discriminator round-trip** — TS `SessionBudget.kind` ↔ Rust `SessionKind` must match. Pattern: a `chat`-kinded TS write produces a Rust read with `kind == SessionKind::Chat`. Breakage = chip shows admin sessions.
3. **schemaVersion drift** — Bumping TS to `2` while Rust still defaults to `1` (or vice versa). M1 fixture tests catch this. Breakage = silent type drift.
4. **`metadata.pct` precision** — `toFixed(2)` ↔ Phase 2's `parseFloat`. M7 regex test catches drift. Breakage = subtle numeric round-trip bugs in Phase 2.
5. **Model field on Agent** — `agent.capability.model` undefined silently defaulting to `200_000` would mis-calibrate Opus 4.7 by 5x. Hidden-assumption fix: hard-throw + unit test catches. Breakage class explicitly flagged in AGENTS.md.

### Reachability check

For each must-have artifact, a concrete creation/usage path:

- ✅ `SessionBudget` TS — created in Task 2, tested in Task 0 #7, used in Tasks 4 + 10 + 11.
- ✅ `SessionBudget` Rust — created in Task 6, tested in Task 0 #10 + Task 6 step 4, used in Tasks 7 + 9 + 11.
- ✅ `relay-paths` crate — created in Task 10b, used in Tasks 10b (TUI) + Task 6 (GUI refactor to delegate).
- ✅ `tokenPctSeverity` util — created in Task 7 step 1, used in Tasks 0 #9 + 7 step 5.
- ✅ Threshold events on feed — emitted by Task 5, consumed by Phase 2 (out of scope here, but contract documented).
- ✅ TUI bar — rendered by Task 9, populated for orchestrator runs by Tasks 4 + 6, populated for GUI-dispatched chat by Task 10, populated for TUI-dispatched chat by Task 10b (H1).
- ✅ Survives-restart property — guaranteed by `TokenTracker.firedThresholds` replay (existing); verified by `tracker-restart-replay.test.ts` (Task 0 #12).

All artifacts have a creation path; all wiring is exercised by at least one test or visible behavior. No UNREACHABLE items.

</goal_backward_verification>
</content>
</invoke>