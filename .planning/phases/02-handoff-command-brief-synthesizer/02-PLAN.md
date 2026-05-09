---
phase: 02-handoff-command-brief-synthesizer
plan: 01
type: execute
wave: 1
depends_on: ["01-token-usage-telemetry-context-bar/01"]
files_modified:
  # Wave 0 — fixtures, scaffolds, types (single PR)
  - src/orchestrator/handoff/types.ts
  - src/orchestrator/handoff/token-estimate.ts
  - src/domain/handoff.ts
  - test/orchestrator/handoff/synthesizer.test.ts
  - test/orchestrator/handoff/render-markdown.test.ts
  - test/orchestrator/handoff/validate.test.ts
  - test/orchestrator/handoff/threshold-listener.test.ts
  - test/orchestrator/handoff/handoff-cli.test.ts
  - test/orchestrator/handoff/handoff-resume.test.ts
  - test/orchestrator/handoff/fixtures/channel-min/feed.jsonl
  - test/orchestrator/handoff/fixtures/channel-min/tickets.json
  - test/orchestrator/handoff/fixtures/channel-min/manifest.json
  - test/orchestrator/handoff/fixtures/channel-min/decisions/d-001.json
  - test/orchestrator/handoff/fixtures/channel-min/decisions/d-002.json
  - test/orchestrator/handoff/fixtures/channel-min/runs.json
  # Wave 1 — synthesizer + validation (single PR; per L2, combined with Wave 0 to close the compile gap — see <revision_log> L2)
  - src/orchestrator/handoff/synthesizer.ts
  - src/orchestrator/handoff/render-markdown.ts
  - src/orchestrator/handoff/validate.ts
  - src/orchestrator/handoff/files-touched.ts
  # Wave 2 — MCP gap-fill + persistence (single PR)
  - src/orchestrator/handoff/persistence.ts
  - src/mcp/channel-tools.ts
  - test/mcp/channel-handoff-finalize.test.ts
  - test/orchestrator/handoff/persistence.test.ts
  # Wave 3 — threshold listener + approval-queue extension (single PR)
  - src/approvals/queue.ts
  - src/orchestrator/handoff/threshold-listener.ts
  - src/orchestrator/dispatch.ts
  - src/cli/run-autonomous.ts
  # Wave 4 — `rly handoff` CLI + new-session seed + --save mode (Wave 4a/4b split if diff > 800; see <revision_log> L3)
  - src/cli/handoff.ts
  - src/index.ts
  # Wave 5 — docs + integration tests + cross-dashboard ApprovalKind audit (single PR)
  - docs/design/handoff-brief.md
  - docs/cli/rly-handoff.md
  - README.md
  - test/orchestrator/handoff/handoff-integration.test.ts
  # Cross-dashboard surfaces audited (M10) — files MAY change if `ApprovalKind` switches need widening:
  - tui/  # audit only — no code changes expected
  - gui/src/  # audit only
  - gui/src-tauri/src/lib.rs  # audit only
  - crates/harness-data/src/lib.rs  # audit only
autonomous: true

requirements:
  - REQ-2.1
  - REQ-2.2
  - REQ-2.3
  - REQ-2.4
  - REQ-2.5
  - REQ-2.6
  - REQ-2.7
  - REQ-2.8
  - REQ-2.9
  - REQ-2.10

must_haves:
  truths:
    - "User runs `rly handoff <channelId> --to claude` and a brief markdown file is generated under `~/.relay/channels/<channelId>/handoffs/<briefId>.md` with `schemaVersion: 1`."
    - "After the brief is generated and `--to <provider>` resolves to a profile, a new chat session is dispatched with the brief as its first user-turn for both Claude (`--append-system-prompt` + first-turn) and Codex (positional first-turn)."
    - "When Phase 1's `context_threshold` feed entry fires with `metadata.threshold === \"90\"`, an `ApprovalsQueue` record of `kind: \"handoff-prompt\"` is enqueued for the user; the listener is single-emit per (sessionId, threshold) pair per Phase 1's D-03 contract. The string `metadata.threshold` and `metadata.pct` are converted to numbers exactly once at the listener boundary (`Number(entry.metadata.threshold)`, `Number(entry.metadata.pct)`)."
    - "Departing agent calls MCP tool `channel_handoff_finalize` with the four working-memory slots (currentLineOfAttack, activeHypothesis, abandonedApproaches, openQuestions); the call writes `<briefId>.gap.json` atomically; the next `rly handoff` consumes it."
    - "If the agent never calls `channel_handoff_finalize`, the brief still renders successfully with placeholder text (`[gap-fill not provided]` plus an explanatory note)."
    - "`rly handoff <channelId> --save` produces a brief artifact on disk and does NOT spawn a destination session; subsequent `rly handoff <channelId> --resume <briefId> --to <dest>` (or `--resume latest`) regenerates the deterministic skeleton + reuses the saved gap-fill and seeds a new session."
    - "Brief validation rejects briefs that exceed 8,000 tokens (default cap, STRICT mode used by `--to`) or lack any required section, unless `--force` is passed; secret-pattern detection (`AKIA[A-Z0-9]+`, `sk-[a-zA-Z0-9]+`, generic `(?i)(secret|password|token|api[_-]?key)\\s*[:=]\\s*\\S+`) raises a hard error with no `--force` override. PERMISSIVE mode used by `--save` runs ONLY the secret-pattern check (no 8K cap, no missing-section rejection) — `--save` is for archival; the cap is enforced when the brief is later resumed via `--to`."
    - "All synthesizer, validation, MCP-tool, and threshold-listener tests pass under scripted mode (no `HARNESS_LIVE`); live-network tests are inside `describe.skip` blocks."
  artifacts:
    - path: "src/orchestrator/handoff/synthesizer.ts"
      provides: "`buildBrief({channelId, now, channelStore?, artifactStore?, gapFill?, tokenBudget?, gitLogEnabled?}): Promise<HandoffBrief>` — pure-over-declared-inputs over `~/.relay/` (git log enrichment is the one declared side effect; can be disabled via `gitLogEnabled: false` for strict bit-identicality)"
      contains: "export async function buildBrief"
    - path: "src/orchestrator/handoff/render-markdown.ts"
      provides: "Deterministic `renderBrief(brief: HandoffBrief): string` (string-concat, no markdown lib)"
      contains: "export function renderBrief"
    - path: "src/orchestrator/handoff/validate.ts"
      provides: "`validateBrief(brief, opts): ValidationResult` enforcing length/sections/secret-patterns; opts includes `mode: \"strict\" | \"permissive\"` per M2"
      contains: "export function validateBrief"
    - path: "src/orchestrator/handoff/persistence.ts"
      provides: "Atomic write of `<briefId>.{md,gap.json}` under `~/.relay/channels/<id>/handoffs/`"
      contains: "writeBriefArtifact"
    - path: "src/orchestrator/handoff/threshold-listener.ts"
      provides: "`attachHandoffThresholdListener(channelStore, approvalsQueue, channelId, sessionId)` watching the channel feed for `context_threshold` entries with `threshold === \"90\"`; default `pollIntervalMs` 5000 (M8)"
      contains: "export function attachHandoffThresholdListener"
    - path: "src/cli/handoff.ts"
      provides: "`handleHandoffCommand` — CLI handler implementing REQ-2.1, REQ-2.5, REQ-2.8 (--to / --save / --resume modes)"
      contains: "export async function handleHandoffCommand"
    - path: "src/mcp/channel-tools.ts"
      provides: "`channel_handoff_finalize` MCP tool definition + dispatch (REQ-2.3); Zod schema rejects `schemaVersion !== 1` explicitly (M9)"
      contains: "channel_handoff_finalize"
    - path: "src/approvals/queue.ts"
      provides: "Extended `ApprovalKind` union including `\"handoff-prompt\"` and `HandoffPromptPayload`"
      contains: "handoff-prompt"
    - path: "src/domain/handoff.ts"
      provides: "Shared TS types — `HandoffBrief`, `GapFillBlock`, `BriefSection`, `HandoffPromptPayload`, `HANDOFF_BRIEF_SCHEMA_VERSION = 1`"
      contains: "HANDOFF_BRIEF_SCHEMA_VERSION"
    - path: "docs/design/handoff-brief.md"
      provides: "Brief schema + section ordering reference (REQ-2.10) following `agents.md` design-doc convention"
      contains: "## Specs"
    - path: "docs/cli/rly-handoff.md"
      provides: "User-facing CLI reference for `rly handoff` (REQ-2.10)"
      contains: "rly handoff"
  key_links:
    - from: "src/orchestrator/handoff/synthesizer.ts"
      to: "src/channels/channel-store.ts"
      via: "ChannelStore.getChannel / readFeed / readChannelTickets / listDecisions / readRunLinks"
      pattern: "channelStore\\.(getChannel|readFeed|readChannelTickets|listDecisions|readRunLinks)"
    - from: "src/orchestrator/handoff/threshold-listener.ts"
      to: "src/channels/channel-store.ts (feed.jsonl)"
      via: "Polling readFeed for entries where metadata.kind === 'context_threshold' && metadata.threshold === '90' (Phase 1 contract)"
      pattern: "context_threshold"
    - from: "src/orchestrator/handoff/threshold-listener.ts"
      to: "src/approvals/queue.ts"
      via: "ApprovalsQueue.enqueue({ kind: 'handoff-prompt', payload })"
      pattern: "kind:\\s*['\"]handoff-prompt['\"]"
    - from: "src/cli/handoff.ts"
      to: "src/agents/cli-agents.ts"
      via: "Spawning destination CLI — Claude `--append-system-prompt` + first-turn; Codex positional first-turn"
      pattern: "--append-system-prompt|codex\\s+exec"
    - from: "src/cli/handoff.ts"
      to: "src/orchestrator/handoff/persistence.ts"
      via: "writeBriefArtifact(channelId, briefId, markdown, gapFillJson)"
      pattern: "writeBriefArtifact"
    - from: "src/mcp/channel-tools.ts"
      to: "src/orchestrator/handoff/persistence.ts"
      via: "writeGapFill(channelId, briefId, payload) on `channel_handoff_finalize` invocation"
      pattern: "writeGapFill|channel_handoff_finalize"
    - from: "src/index.ts"
      to: "src/cli/handoff.ts"
      via: "CLI dispatch — `case \"handoff\":` in argv switch"
      pattern: "case ['\"]handoff['\"]"
---

<revision_log>
**Iteration 2 — 2026-05-09.** Responding to `02-CHECK.md` (2 HIGH, 10 MEDIUM, 7 LOW). Summary of edits, in order of finding ID:

- **H1 (ApprovalsQueue.list API mismatch).** Rewrote Task 3.1 Step 2 to use the actual signature `approvalsQueue.list(sessionId)` (positional) and filter `rec.kind === "handoff-prompt"` in JS. Dropped the `entryId`-half of the dedup story; restart-idempotency seed now dedupes strictly on `(sessionId, threshold)` extracted from `payload.thresholdPct` per D-03. Tightened `<verification>` step 5 grep to Phase-2-authored paths only (excluded pre-existing `src/approvals/queue.ts`).
- **H2a (SUMMARY filename).** Updated `<output>` block to use the standard short form `02-SUMMARY.md` to mirror Phase 1's revised convention.
- **H2b (handoff-id contract test).** Added a defense-in-depth test to `threshold-listener.test.ts` Step 5: two trackers with distinct sessionIds both crossing 90% must enqueue independent approvals. Sync-point note added inside `<phase_2_handoff_contract_inherited_from_phase_1>`.
- **M1 (string→number conversion site).** Pinned to the listener boundary: `Number(entry.metadata.threshold)` and `Number(entry.metadata.pct)` parsed once in Step 2 of Task 3.1; the must_haves truth #3 also calls this out.
- **M2 (`--save` validation gate).** Picked PERMISSIVE: `--save` runs only the secret-pattern check (no 8K cap, no missing-section). `validateBrief` now takes `mode: "strict" | "permissive"`. Documented in the validate-brief behavior bullets and Task 4.1 mode dispatch.
- **M3 (synthesizer purity).** Reframed `<objective>`, must_haves artifact note, and Task 1.1 behavior bullet to "pure-over-declared-inputs." Added `gitLogEnabled?: boolean` opt to `BuildBriefOptions` (default `true`). Non-bit-identicality on real channels is documented in the design doc (Task 5.1).
- **M4 (D-02 footnote in render).** Added explicit footnote line to render-markdown.ts Files-touched section: `> *(v1: files-touched is reconstructed from git log; uncommitted changes and tickets without commit references are missing. Tracked: D-02.)*`.
- **M5 (stale-gap → placeholder integration).** Added 15-line `it("renders placeholder when gap.json is older than 1h", ...)` to synthesizer.test.ts Step 5 of Task 0.1.
- **M6 (Codex chat-spawn flags).** Added explicit justification in Task 4.1 spawn helper: drop orchestrator-pipeline flags (`--output-schema`, `-o`, `--ask-for-approval`); sandbox stays `read-only` unless channel `fullAccess`; model from `profile.defaultModel`. Extracted `buildCodexChatArgv` helper for testability.
- **M7 (`--resume` reads only gap.json).** Clarified Task 4.1 mode dispatch step 3: `<briefId>.md` is a snapshot, not re-consumed; only `<briefId>.gap.json` feeds back into `buildBrief`. Added optional footer line to render: `*Resumed from brief-XXX (originally generated YYYY-MM-DD)*`.
- **M8 (poll interval default).** Changed default `pollIntervalMs` to 5000 (5s); tests override with 50ms. Added code comment justifying the tradeoff in the listener.
- **M9 (schemaVersion round-trip test).** Added `it("preserves schemaVersion: 2 on round-trip (does not silently coerce to 1)", ...)` to persistence.test.ts. Tightened MCP tool's Zod schema (Task 2.1 Step 2) to reject `schemaVersion !== 1` at runtime.
- **M10 (ApprovalKind cross-dashboard widening).** Added a Wave 5 audit step over `tui/`, `gui/src/`, `gui/src-tauri/`, `crates/harness-data/` for `ApprovalKind` / `ApprovalRecord` switches; widen each (with placeholder rendering) OR document fall-through. Added `rly pending-approvals --json` test asserting handoff-prompt approvals render correctly.
- **L1 (REQ-2.x ↔ HOFF-XX mapping).** Added the mapping inline in the `<verification>` requirements coverage matrix.
- **L2 (Wave 0 compile gap).** Combined Wave 0 + Wave 1 into a single PR (mirrors Phase 1's chosen approach). Wave 0 now lands the failing tests AND the implementations together so `pnpm typecheck` passes from the first commit.
- **L3 (Wave 4 LOC pre-split).** Pre-planned as Wave 4a (CLI handler + mode dispatch) and Wave 4b (spawn helpers + index.ts wiring). Documented in Task 4.1 action.
- **L4 (recordDecision best-effort test).** Added 20-line `it("recordDecision throws → handoff still succeeds", ...)` to handoff-cli.test.ts Step 3 of Task 4.1.
- **L5 (`metadata.handoffPrompt` not agent-visible).** Documented in Task 4.1 step 1 that the feed entry is dashboard-visible, NOT agent-visible. Agent learns about gap-fill via system-prompt instruction in destination session's first turn, proactive detection, or user instruction — not via the feed entry.
- **L6 (listener self-loop disjointness).** Added explicit code-comment requirement in Task 3.1 Step 2: "Listener's own posts (`metadata.handoffPrompt: true`) are NOT matched by the context_threshold predicate — no self-loop."
- **L7 (Tauri-spawn version pin).** Added note in Task 4.1: "TS spawner is independent of Tauri command; idiom referenced AS OF Phase 2 execution (any later refactor of `gui/src-tauri/src/lib.rs:start_chat` does not affect `src/cli/handoff.ts` callers)."
</revision_log>

<objective>
Ship the `rly handoff` command and the deterministic brief synthesizer that powers it. The phase delivers, end-to-end, the user story locked in `.planning/notes/handoff-feature-design.md`: when a session is approaching its context limit (or whenever the user wants), they run `rly handoff <channelId> --to <dest>`, the orchestrator joins the channel's existing artifacts (feed, decisions with rationale + alternatives, ticket DAG, files touched, run links) into a structured markdown brief, asks the departing agent to fill four working-memory slots via a new MCP tool, validates the result, persists it under `~/.relay/channels/<channelId>/handoffs/`, and dispatches a fresh session in the destination provider with the brief as its first turn — instead of replaying the raw transcript.

The phase also subscribes (read-only) to Phase 1's `context_threshold` feed events and surfaces the 90% nudge through the existing AL-7 approval queue. A `--save` mode produces the brief without dispatching, and `--resume <briefId>` re-seeds from a saved brief, enabling the "resume after a week" workflow.

Purpose: Today there is no clean way to transfer in-progress agent context between providers (Claude ↔ Codex) or across multi-day pauses. Replaying the raw transcript is wasteful, lossy, and hostile to the destination's prompt-size budget. Relay already persists the right corpus — channel feed, decisions with rationale + alternatives, ticket DAG, run links — and the synthesizer turns that corpus into a focused, provider-portable, ~3-4K-token brief.

**Synthesizer purity (revised per M3).** `buildBrief` is **pure-over-declared-inputs**: it consumes `~/.relay/` data plus an explicit `now` and an injectable `channelStore` / `artifactStore`, and never reads `process.env`, `Date.now()`, or `Math.random()` directly. There is one declared side effect: the v1 files-touched enrichment shells out via `git log` (D-02). On real channels two back-to-back `buildBrief` calls separated by a `git pull` could differ — this is acceptable for v1 and documented in `docs/design/handoff-brief.md`. Tests opt out of git enrichment with `gitLogEnabled: false` for strict bit-identicality assertions.

Output:
- New `rly handoff <channelId>` CLI command (modes: `--to <dest>` / `--save` / `--resume <briefId>`).
- Pure-over-declared-inputs deterministic brief synthesizer at `src/orchestrator/handoff/`.
- New MCP tool `channel_handoff_finalize` for the departing-agent gap-fill.
- 90% nudge listener wired via `ApprovalsQueue` (new `ApprovalKind = "handoff-prompt"`).
- Brief artifacts at `~/.relay/channels/<id>/handoffs/<briefId>.{md,gap.json}` with `schemaVersion: 1` (first versioned `~/.relay/` artifact — intentional, per CONCERNS.md).
- Vitest coverage in scripted mode for synthesizer / validation / MCP tool / threshold listener / CLI.
- User-facing docs at `docs/cli/rly-handoff.md` and design doc at `docs/design/handoff-brief.md`.
- Cross-dashboard audit (Wave 5) confirming `ApprovalKind` widening either renders correctly OR falls through gracefully on TUI / GUI / Rust crate surfaces (per M10).
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/ROADMAP.md
@AGENTS.md
@CLAUDE.md
@.planning/notes/handoff-feature-design.md
@.planning/phases/02-handoff-command-brief-synthesizer/02-RESEARCH.md
@.planning/phases/01-token-usage-telemetry-context-bar/01-PLAN.md
@.planning/codebase/ARCHITECTURE.md
@.planning/codebase/STRUCTURE.md
@.planning/codebase/INTEGRATIONS.md
@.planning/codebase/CONCERNS.md
@.planning/codebase/CONVENTIONS.md
@.planning/codebase/TESTING.md
@src/channels/channel-store.ts
@src/domain/decision.ts
@src/domain/ticket.ts
@src/domain/channel.ts
@src/domain/session.ts
@src/approvals/queue.ts
@src/mcp/channel-tools.ts
@src/cli/chat-context.ts
@src/cli/session-store.ts
@src/cli/launcher.ts
@src/cli/paths.ts
@src/orchestrator/repo-admin-session.ts
@src/agents/cli-agents.ts
@src/agents/factory.ts
@src/agents/provider-profile-lookup.ts
@src/budget/token-tracker.ts
@src/storage/file-store.ts
@src/index.ts

<phase_2_handoff_contract_inherited_from_phase_1>
**This contract is inherited verbatim from Phase 1 PLAN's `<phase_2_handoff_contract>` block (do not modify after merge):**

- **File subscribed to:** `~/.relay/channels/<channelId>/feed.jsonl`
- **Filter:** `entry.type === "status_update" && entry.metadata?.kind === "context_threshold" && entry.metadata?.threshold === "90"`
- **Stable fields:** `metadata.sessionId`, `metadata.threshold` (string `"75"`/`"90"`/`"95"`), `metadata.pct` (string, e.g. `"91.23"`), `metadata.used`, `metadata.total`, `metadata.model?`, `metadata.schemaVersion === "1"`
- **Handoff session-id contract (D-03):** A handoff creates a NEW sessionId in the destination provider. Its tracker starts at 0% and never re-emits the source session's thresholds. Phase 2 must treat each (sessionId, threshold) pair as independent (i.e. dedup by `(sessionId, threshold)`, not by `threshold` alone).
- **String→number boundary (M1):** `metadata.threshold` and `metadata.pct` are STRINGS on the wire. The listener parses both as numbers exactly once: `Number(entry.metadata.threshold)` for `HandoffPromptPayload.thresholdPct`, `Number(entry.metadata.pct)` for the rendered pct in the prompt content. No other code path coerces them.
- **Schema bumps:** Bumping `metadata.schemaVersion` requires coordinated update across both phases.
- **Reference doc:** `docs/design/context-threshold-events.md` (created by Phase 1 Task 5; if absent at execution time, this contract block is the source of truth).

**Sync-point note (per H2b).** If Phase 1 ships without its M5 fix (per-session handoff-id test on the threshold-feed bridge), Phase 2 owns the dedup-by-(sessionId, threshold) contract test in its own suite. Defense in depth: Phase 2's `threshold-listener.test.ts` adds an `it("two distinct sessionIds both at 90% enqueue independent approvals", ...)` regardless of Phase 1's coverage. See Task 3.1 Step 5.

Phase 2's threshold listener (`src/orchestrator/handoff/threshold-listener.ts`) does NOT touch any other Phase 1 internals. It does NOT import from `src/budget/`. It reads the feed via `ChannelStore.readFeed`, filters on the metadata fields above, and calls `ApprovalsQueue.enqueue`. Phase 1 owns telemetry; Phase 2 owns the handoff UX.
</phase_2_handoff_contract_inherited_from_phase_1>

<locked_decisions_from_predecided_open_questions>
The orchestrator authorized planning to proceed with these answers — encode as locked decisions. Do NOT relitigate.

- **D-01 (Phase 1 contract):** Subscribe to the 90% upward-crossing event, per-session, single-emit. Source of truth = `<phase_2_handoff_contract>` block above. If `docs/design/context-threshold-events.md` doesn't exist at execution time, defer to the contract block.
- **D-02 (files-touched per ticket):** v1 uses `git log --name-only` scoped by ticket commit boundaries — accepted as lossy AND as the one declared side effect of the otherwise pure synthesizer (per M3 reframe). Document in PLAN/code as "v1, revisit if briefs feel thin" (per RESEARCH Q6, A4). NO schema change in Phase 2; a future phase can add first-class file tracking. Implementation lives in `src/orchestrator/handoff/files-touched.ts`. The render layer surfaces a v1-lossy footnote in the Files-touched section so brief consumers see the limitation without reading the source code (per M4).
- **D-03 (`--to <value>` resolution):** Single flag with layered fallback — provider-profile id → adapter name (`claude` / `codex`) → channel repo alias. NO separate `--provider` flag. Resolution order per RESEARCH Q15.
- **D-04 (per-section token budgets):** Heuristic for v1 — encode as constants and flag for tuning. Caps:
  - Status snapshot ≤ 200 tokens
  - Mission ≤ 300 tokens
  - Ticket DAG ≤ 600 tokens
  - Recent decisions ≤ 1500 tokens
  - Files touched ≤ 400 tokens
  - Working memory ≤ 1500 tokens (uncapped from departing agent — soft cap via MCP tool inputSchema maxLengths)
  - Total brief soft cap: 4,000 tokens (warn). Hard cap: 8,000 tokens (refuse without `--force`) — hard cap applies in STRICT validation mode (`--to`); PERMISSIVE mode (`--save`) skips the cap (per M2).
- **D-05 (artifact location):** `~/.relay/channels/<channelId>/handoffs/<briefId>.{md,gap.json}` with `schemaVersion: 1`. First versioned `~/.relay/` artifact (CONCERNS.md flagged absence — introducing convention here is in-scope). The MCP tool's Zod schema rejects any payload with `schemaVersion !== 1` at runtime (per M9), so a future bump requires a coordinated change.
- **D-06 (gap-fill mechanism):** New MCP tool `channel_handoff_finalize` that the departing agent voluntarily calls inside its current turn. Brief MUST render successfully without a gap-fill (placeholder fallback `[gap-fill not provided]` with explanatory note for the destination session). The agent learns to call this tool via system-prompt instruction in the destination session's first turn, proactive detection, or explicit user instruction — NOT via the feed entry the CLI posts (which is dashboard-visible only, per L5).
- **D-07 (90% nudge UX):** Reuse AL-7 approval queue. Add `ApprovalKind = "handoff-prompt"`. Threshold listener mirrors the precedent at `src/orchestrator/repo-admin-session.ts:459`. Cross-dashboard rendering surfaces (TUI / GUI / Rust crate) audited in Wave 5 per M10.
- **D-08 (resume-after-week):** Same `rly handoff` command with `--save` mode (no `--to`) — saves brief to disk without dispatching. `rly handoff <channelId> --resume <briefId> --to <dest>` (or `--resume latest`) loads the saved `<briefId>.gap.json` AND regenerates the deterministic skeleton from current channel state (the saved `<briefId>.md` is a snapshot, not re-consumed by `buildBrief` — per M7). NO separate `rly resume` command. Composes cleanly — same synthesizer.
- **D-09 (brief validation):** Validate before seeding. Two modes (per M2): STRICT (`--to`) checks required sections + total token budget under cap (hard) + secret-pattern; PERMISSIVE (`--save`) checks ONLY secret-pattern. Secret-pattern is hard, no `--force` override, in BOTH modes. Lives at `src/orchestrator/handoff/validate.ts`.
</locked_decisions_from_predecided_open_questions>

<interfaces>
<!-- Key types and contracts the executor needs. Extracted from the codebase. -->
<!-- Use these directly — no codebase exploration needed. -->

From `src/domain/decision.ts`:
```ts
export interface Decision {
  decisionId: string;
  channelId: string;
  runId: string | null;
  ticketId: string | null;
  title: string;
  description: string;
  rationale: string;
  alternatives: string[];
  decidedBy: string;
  decidedByName: string;
  linkedArtifacts: string[];
  createdAt: string;
  type?: string;
  metadata?: Record<string, unknown>;
}
```

From `src/domain/ticket.ts` (TicketLedgerEntry — abridged):
```ts
export interface TicketLedgerEntry {
  ticketId: string;
  title: string;
  specialty: string;
  status: "pending" | "blocked" | "ready" | "executing" | "verifying" | "retry" | "completed" | "failed";
  dependsOn: string[];
  assignedAgentId?: string;
  assignedAgentName?: string;
  assignedAlias?: string;
  verification?: VerificationStatus;
  lastClassification?: { rationale?: string; nextAction?: string };
  attempt: number;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
}
// Helpers (all live in src/domain/ticket.ts):
//   getReadyTickets(ledger)         (line ~153)
//   validateTicketDag(tickets)      (line ~167)  — returns { order, cycles }
//   linearizeTickets(tickets)       (line ~225)
```

From `src/channels/channel-store.ts` (read APIs the synthesizer uses):
```ts
class ChannelStore {
  getChannel(channelId: string): Promise<Channel | null>;
  readFeed(channelId: string, limit?: number): Promise<ChannelEntry[]>;
  readChannelTickets(channelId: string): Promise<TicketLedgerEntry[]>;       // line ~802
  listDecisions(channelId: string): Promise<Decision[]>;                      // line ~1032 (newest-first)
  readRunLinks(channelId: string): Promise<ChannelRunLink[]>;
  postEntry(channelId: string, entry: NewChannelEntry): Promise<ChannelEntry>; // line ~597 (atomic, append-only)
}
```

From `src/approvals/queue.ts` (current state — Phase 2 extends; ACTUAL signatures pinned per H1):
```ts
export type ApprovalKind = "merge-pr" | "create-ticket";

export interface MergePrPayload { /* ... */ }
export interface CreateTicketPayload { /* ... */ }

// Discriminated union (Phase 2 extends with handoff-prompt variant):
export type ApprovalRequest =
  | { kind: "merge-pr"; payload: MergePrPayload }
  | { kind: "create-ticket"; payload: CreateTicketPayload };

interface ListOptions { status?: ApprovalStatus }  // NO `kind` filter — caller filters in JS

class ApprovalsQueue {
  enqueue(input: { sessionId: string; kind: ApprovalKind; payload: ... }): Promise<ApprovalRecord>;
  // ACTUAL list signature (src/approvals/queue.ts:312):
  list(sessionId: string, options?: ListOptions): Promise<ApprovalRecord[]>;
  // status flips: pending → approved | rejected (terminal)
}
```

From `src/cli/paths.ts`:
```ts
export function getRelayDir(): string;  // canonical resolver — ALWAYS use this for ~/.relay/ paths
```

From `src/storage/file-store.ts`:
```ts
export function assertSafeSegment(segment: string, label: string): void;  // path-traversal guard
```

From `src/cli/chat-context.ts`:
```ts
export function buildSystemPrompt(opts: { channelId: string; ... }): string;  // line ~107 — reuse for the destination session's system prompt
```

From `src/agents/cli-agents.ts` (spawn idioms — RESEARCH §13):
- Claude (chat path):
  ```
  claude -p --output-format stream-json --verbose \
    --append-system-prompt "<system>" \
    [--resume <sid>] \
    "<first-turn-message>"
  ```
- Codex orchestrator-pipeline path (`src/agents/cli-agents.ts:277-298` — the LIVE invocation today):
  ```
  codex exec -C <cwd> --skip-git-repo-check --sandbox <read-only|workspace-write> \
    --output-schema <schema> -o <out> [--ask-for-approval never] [--model <m>] "<prompt>"
  ```
- Codex chat-seed path that Phase 2 introduces (M6 justification — see Task 4.1 Step 1):
  ```
  codex exec -C <cwd> --skip-git-repo-check --sandbox read-only \
    [--model <profile.defaultModel>] "<brief-markdown>"
  ```
  *Drops:* `--output-schema`, `-o`, `--ask-for-approval`. Sandbox stays `read-only` unless the channel has `fullAccess` (then `workspace-write`). Model from `profile.defaultModel` if set, else Codex default.

From Phase 1 (inherited contract — see `<phase_2_handoff_contract_inherited_from_phase_1>` above):
- Channel-feed entry shape Phase 2 subscribes to:
  ```
  {
    "type": "status_update",
    "fromAgentId": null,
    "fromDisplayName": "system",
    "content": "Context window at 91% (90% threshold).",
    "metadata": {
      "kind": "context_threshold",
      "schemaVersion": "1",
      "threshold": "90",          // STRING — "75" | "90" | "95"
      "pct": "91.23",             // STRING
      "used": "180000",           // STRING
      "total": "200000",          // STRING
      "sessionId": "sess-...",
      "model": "claude-sonnet-4"  // optional
    }
  }
  ```
  Phase 2's listener converts `threshold` and `pct` to numbers exactly once at the listener boundary (see M1 in `<revision_log>`).

New types Phase 2 introduces (`src/domain/handoff.ts`):
```ts
export const HANDOFF_BRIEF_SCHEMA_VERSION = 1 as const;

export interface HandoffBrief {
  schemaVersion: typeof HANDOFF_BRIEF_SCHEMA_VERSION;
  briefId: string;            // brief-<unix-ms>-<rand> per buildEntryId convention
  channelId: string;
  channelName: string;
  generatedAt: string;        // ISO
  fromProvider: string | null;
  fromSessionId: string | null;
  toHint: string | null;      // free-text label for "to" (rendered in header)
  resumedFrom?: { briefId: string; originalGeneratedAt: string };  // M7 — populated when --resume used
  sections: {
    statusSnapshot: BriefSection;
    mission: BriefSection;
    ticketDag: BriefSection;
    recentDecisions: BriefSection;
    filesTouched: BriefSection;
    workingMemory: BriefSection;
  };
  tokenEstimate: number;
}

export interface BriefSection {
  heading: string;
  body: string;
  estimatedTokens: number;
  truncated?: boolean;
}

export interface GapFillBlock {
  schemaVersion: typeof HANDOFF_BRIEF_SCHEMA_VERSION;
  briefId: string;
  channelId: string;
  capturedAt: string;          // ISO — used for staleness gating (>1h ⇒ ignored)
  capturedBySessionId: string | null;
  currentLineOfAttack: string;
  activeHypothesis: string;
  abandonedApproaches: string[];
  openQuestions: string[];
}

export interface HandoffPromptPayload {
  schemaVersion: 1;
  channelId: string;
  sessionId: string;
  thresholdPct: number;        // 90 — converted from STRING `metadata.threshold` exactly once at the listener boundary (M1)
  used: number;
  total: number;
  promptText?: string;         // optional pre-rendered nudge
  // NB: deliberately no `entryId` field — restart-idempotency seed dedupes on
  // (sessionId, thresholdPct) per H1 fix; the in-memory `Set<entryId>` is for
  // same-process polling only and does not need to round-trip through payload.
}

export interface BuildBriefOptions {
  channelId: string;
  now: Date;
  channelStore?: ChannelStore;
  artifactStore?: LocalArtifactStore;
  gapFill?: GapFillBlock | null;
  tokenBudget?: typeof BRIEF_TOKEN_BUDGETS;
  repoCwds?: string[];
  randomSeed?: string;
  /** Disable git-log enrichment for strict bit-identicality tests (M3). Default true. */
  gitLogEnabled?: boolean;
  /** Set when --resume is used (M7); rendered as a footer line. */
  resumedFrom?: { briefId: string; originalGeneratedAt: string };
}
```
</interfaces>
</context>

<tasks>

<!-- ============================================================ -->
<!-- WAVE 0+1 (combined per L2) — Tests + Scaffolds + Domain Types + Synthesizer (single PR) -->
<!-- L2 fix: Phase 1's revision combined Wave 0 + Wave 1 to close the typecheck gap. -->
<!-- Phase 2 mirrors that approach: tests AND implementations land together so -->
<!-- `pnpm typecheck` passes from the first commit. The two tasks below MUST land -->
<!-- in one PR, gated as a single review unit. Estimated combined LOC ~750. -->
<!-- ============================================================ -->

<task type="auto" tdd="true">
  <name>Task 0.1 (Wave 0+1, combined per L2): Domain types + token-estimate + Wave-0 test scaffolds (failing initially, then turned green by Task 1.1 in same PR)</name>
  <requirements>REQ-2.2, REQ-2.6, REQ-2.7, REQ-2.9</requirements>
  <files>
    src/domain/handoff.ts,
    src/orchestrator/handoff/types.ts,
    src/orchestrator/handoff/token-estimate.ts,
    test/orchestrator/handoff/synthesizer.test.ts,
    test/orchestrator/handoff/render-markdown.test.ts,
    test/orchestrator/handoff/validate.test.ts,
    test/orchestrator/handoff/threshold-listener.test.ts,
    test/orchestrator/handoff/handoff-cli.test.ts,
    test/orchestrator/handoff/handoff-resume.test.ts,
    test/orchestrator/handoff/fixtures/channel-min/feed.jsonl,
    test/orchestrator/handoff/fixtures/channel-min/tickets.json,
    test/orchestrator/handoff/fixtures/channel-min/manifest.json,
    test/orchestrator/handoff/fixtures/channel-min/decisions/d-001.json,
    test/orchestrator/handoff/fixtures/channel-min/decisions/d-002.json,
    test/orchestrator/handoff/fixtures/channel-min/runs.json
  </files>
  <behavior>
    - `HANDOFF_BRIEF_SCHEMA_VERSION` is exported as `1` and is `as const`.
    - `HandoffBrief`, `GapFillBlock`, `BriefSection`, `HandoffPromptPayload`, `BuildBriefOptions` types compile against the shapes in `<interfaces>` above. `BuildBriefOptions` includes `gitLogEnabled?: boolean` (M3) and `resumedFrom?` (M7).
    - `estimateTokens(s: string): number` returns `Math.ceil(s.length / 4)` (4-chars-per-token heuristic per RESEARCH Q2; no tokenizer dep).
    - `estimateTokens("")` returns 0; `estimateTokens("0123456789")` returns 3 (10 chars / 4 ⇒ 2.5 ⇒ ceil ⇒ 3).
    - All seven Wave-0 test files import from yet-to-exist modules (`src/orchestrator/handoff/{synthesizer,render-markdown,validate}.ts`, `src/orchestrator/handoff/threshold-listener.ts`, `src/cli/handoff.ts`) and currently fail to import — RED state per TDD. (After Task 1.1 lands in the same PR, the synthesizer/render/validate tests turn green; the listener/CLI/resume tests stay RED until Waves 3 and 4.)
    - Each test file enumerates the success criteria for the task it gates (one `describe` per behavior bullet on that task).
    - The fixture channel directory has the canonical `~/.relay/channels/<id>/`-shaped layout: `manifest.json`, `feed.jsonl` (10 entries with mixed types: `message`, `status_update`, one entry with `metadata.kind === "context_threshold"` + `metadata.threshold === "90"` + `metadata.pct === "91.23"`), `tickets.json` (3 tickets — T-1 completed, T-2 executing depends-on T-1, T-3 blocked depends-on T-2), `decisions/d-001.json` and `d-002.json` (one with `alternatives: []`, one with two alternatives + full rationale), `runs.json` with two run links.
  </behavior>
  <action>
    Per D-04, D-05, RESEARCH §Brief Shape and §Risks (Q19-Q20).

    **Step 1 — `src/domain/handoff.ts`:**
    Create the file with the exports shown in `<interfaces>` above (`HANDOFF_BRIEF_SCHEMA_VERSION`, `HandoffBrief`, `BriefSection`, `GapFillBlock`, `HandoffPromptPayload`, `BuildBriefOptions`). Add a JSDoc on `HANDOFF_BRIEF_SCHEMA_VERSION` noting "First versioned `~/.relay/` artifact — see CONCERNS.md and `.planning/notes/handoff-feature-design.md` D-05." Mirror `schemaVersion: 1` literally; do not parameterize. Note in the JSDoc on `HandoffPromptPayload` that `thresholdPct` is the parsed-number form of Phase 1's STRING `metadata.threshold` (M1).

    **Step 2 — `src/orchestrator/handoff/types.ts`:**
    Re-export the types from `src/domain/handoff.ts` (this is the orchestrator-side import path the synthesizer / render / validate use). Also export `BRIEF_TOKEN_BUDGETS` per D-04:
    ```ts
    export const BRIEF_TOKEN_BUDGETS = {
      statusSnapshot: 200,
      mission: 300,
      ticketDag: 600,
      recentDecisions: 1500,
      filesTouched: 400,
      workingMemory: 1500,
      totalSoftCap: 4000,
      totalHardCap: 8000,
    } as const;
    // TODO(post-launch tuning): measure on real channels and tighten — see RESEARCH Q2/A3.
    ```

    **Step 3 — `src/orchestrator/handoff/token-estimate.ts`:**
    Implement and export `estimateTokens(s: string): number = Math.ceil(s.length / 4)`. Do NOT add a tokenizer dependency. Add a JSDoc explaining the heuristic and citing RESEARCH §Standard Stack ("Hand-roll token estimation").

    **Step 4 — Fixture channel:**
    Create the seven fixture files under `test/orchestrator/handoff/fixtures/channel-min/`. Use realistic-looking but synthetic IDs (`ch-fixmin-0001`, `t-001`, `t-002`, `t-003`, `d-001`, `d-002`, `sess-fixsrc-0001`, `run-fix-0001`, `run-fix-0002`). Match the on-disk shapes exactly as the existing `ChannelStore` writes them (cross-reference `src/channels/channel-store.ts` writers for `manifest.json`, `tickets.json`, `decisions/<id>.json`, `runs.json`, `feed.jsonl`). The `feed.jsonl` MUST contain exactly one entry of `type: "status_update"` with `metadata.kind === "context_threshold"`, `metadata.threshold === "90"`, `metadata.pct === "91.23"`, `metadata.sessionId === "sess-fixsrc-0001"`, `metadata.schemaVersion === "1"` — this is the Phase 1 contract entry the threshold-listener test feeds on.

    **Step 5 — Failing test scaffolds:**
    Each Wave-0 test file uses Vitest's `describe` / `it` with `it.todo` or `expect(...).toBe(...)` against not-yet-implemented modules. The intent: every Wave 1-5 task lands ITS test green AND keeps prior tests green. Concretely:
    - `synthesizer.test.ts` — tests buildBrief over the fixture channel: returns brief with all six sections, `schemaVersion === 1`, `briefId` matches `/^brief-[0-9]+-[a-z0-9]+$/`, `tokenEstimate === sum of section.estimatedTokens`. Determinism test: two consecutive calls with the same `now` AND `gitLogEnabled: false` produce identical briefs (deep-equal). **Add (M5):**
      ```ts
      it("renders [gap-fill not provided] placeholder when gap.json is older than 1h", async () => {
        const now = new Date("2026-05-09T12:00:00.000Z");
        const staleGap: GapFillBlock = {
          schemaVersion: 1,
          briefId: "brief-1746000000000-stale1",
          channelId: "ch-fixmin-0001",
          capturedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString(), // 2h ago
          capturedBySessionId: "sess-fixsrc-0001",
          currentLineOfAttack: "should not appear",
          activeHypothesis: "should not appear",
          abandonedApproaches: ["should not appear"],
          openQuestions: ["should not appear"],
        };
        const brief = await buildBrief({ channelId: "ch-fixmin-0001", now, gapFill: staleGap, gitLogEnabled: false, channelStore: fixtureStore });
        expect(brief.sections.workingMemory.body).toContain("[gap-fill not provided]");
        expect(brief.sections.workingMemory.body).not.toContain("should not appear");
      });
      ```
    - `render-markdown.test.ts` — `renderBrief(brief)` produces markdown with the heading order from RESEARCH Q1 (Status snapshot → Mission → Ticket DAG → Recent decisions → Files touched → Working memory), header includes `**Schema version:** 1`, footer includes `*Generated by `rly handoff`...`*`. Add an assertion that the Files-touched section ends with the M4 footnote line `> *(v1: files-touched is reconstructed from git log; uncommitted changes and tickets without commit references are missing. Tracked: D-02.)*`.
    - `validate.test.ts` — `validateBrief(brief, { mode: "strict", maxTokens })` returns `{ ok: true }` when under cap; `{ ok: false, errors: [...] }` for missing required sections; `{ ok: false, errors: [...] }` when token estimate exceeds hard cap; `{ ok: false, errors: [...] }` when a body contains a string matching `AKIA[A-Z0-9]+` (secret pattern, no `--force` override). Add: `validateBrief(brief, { mode: "permissive" })` with a too-long brief and a missing section returns `{ ok: true }` (PERMISSIVE skips both, per M2); same call with a secret-pattern body returns `{ ok: false }` (secret-pattern is hard in BOTH modes).
    - `threshold-listener.test.ts` — wires a tmp `~/.relay/`, posts the fixture `context_threshold` entry with `threshold === "90"`, asserts an `ApprovalsQueue` record of `kind: "handoff-prompt"` lands; asserts that posting a `threshold === "75"` entry does NOT enqueue; asserts re-posting an identical 90% entry for the SAME `sessionId` does NOT re-enqueue (per Phase 1 D-03 dedup contract). Asserts `payload.thresholdPct === 90` (NUMBER, not string `"90"`) — pinpoints M1 conversion. **Add (H2b — defense in depth):** an `it("two distinct sessionIds both crossing 90% enqueue independent approvals", ...)` that posts two `context_threshold` entries with `metadata.sessionId === "sess-A"` and `metadata.sessionId === "sess-B"` respectively, attaches one listener per session, awaits the poll interval, and asserts BOTH approvals exist (one per session) and neither dedupes against the other.
    - `handoff-cli.test.ts` — invokes `handleHandoffCommand` against the fixture channel with mock spawner; asserts brief artifacts at `<tmp>/channels/<id>/handoffs/<briefId>.{md,gap.json}`; asserts a feed entry of `type: "status_update"` with `metadata.handoff === true` is appended; asserts the spawner was called with the brief markdown as the first-turn argument. (L4 case is added by Task 4.1 Step 3.)
    - `handoff-resume.test.ts` — `--save` mode: assert the brief file lands AND no spawner was called. `--resume <briefId>` mode: pre-place a saved gap.json + brief, invoke with `--resume`, assert the new brief regenerates the deterministic skeleton (different `generatedAt`, but same `gapFill`) AND a new session is dispatched. Assert that ONLY the gap.json is read by `buildBrief` (not the brief.md); the new brief carries `resumedFrom: { briefId, originalGeneratedAt }` per M7.

    These tests are written against module surfaces that do not yet exist. They MUST fail at this commit (RED) initially; Task 1.1 in the same PR turns the synthesizer/render/validate tests green. Listener/CLI/resume tests remain RED until Wave 3 / Wave 4.

    **Step 6 — Verify RED state then GREEN-after-1.1 state:**
    Run `pnpm test test/orchestrator/handoff/` once before Task 1.1 lands and confirm import-time failures dominate. After Task 1.1 lands in the same PR, re-run and confirm synthesizer/render/validate tests pass while listener/cli/resume scaffolds remain RED with clear pending markers.
  </action>
  <verify>
    <automated>pnpm typecheck 2>&1 | tail -20 && pnpm test test/orchestrator/handoff/ 2>&1 | tail -50; echo "EXPECTED after Task 1.1 lands in same PR: synthesizer/render-markdown/validate green; threshold-listener/handoff-cli/handoff-resume RED (pending Waves 3+4)."</automated>
  </verify>
  <done>
    `src/domain/handoff.ts`, `src/orchestrator/handoff/types.ts`, and `src/orchestrator/handoff/token-estimate.ts` compile under `pnpm typecheck`. All seven Wave-0 test files exist. After Task 1.1 lands in the same PR, synthesizer/render/validate tests pass; listener/cli/resume tests remain RED with clear pending markers (turn green in Wave 3/4). Fixture channel exists at `test/orchestrator/handoff/fixtures/channel-min/` with all seven files matching `ChannelStore` writer shapes. `BRIEF_TOKEN_BUDGETS` constants encode D-04 caps with a TODO for post-launch tuning. `BuildBriefOptions` includes `gitLogEnabled?: boolean` and `resumedFrom?` per M3 / M7. No new runtime dependencies added.
  </done>
</task>

<!-- ============================================================ -->
<!-- WAVE 1 — Synthesizer + Validation (lands in same PR as Task 0.1 per L2) -->
<!-- ============================================================ -->

<task type="auto" tdd="true">
  <name>Task 1.1 (Wave 0+1, combined per L2): Pure-over-declared-inputs brief synthesizer + render + validation + files-touched (git log)</name>
  <requirements>REQ-2.2, REQ-2.7, REQ-2.9</requirements>
  <files>
    src/orchestrator/handoff/synthesizer.ts,
    src/orchestrator/handoff/render-markdown.ts,
    src/orchestrator/handoff/validate.ts,
    src/orchestrator/handoff/files-touched.ts
  </files>
  <behavior>
    - `buildBrief(options: BuildBriefOptions): Promise<HandoffBrief>` is **pure-over-declared-inputs** (per M3): same `now` + same disk state + `gitLogEnabled: false` ⇒ identical brief (deep-equal). With `gitLogEnabled: true` (default), the function additionally shells out via `git log` for files-touched enrichment — that is the one declared side effect, accepted per D-02. No `process.env`, `Date.now()`, `Math.random()` calls inside.
    - `briefId` is generated as `brief-<unix-ms-from-now>-<6-char-base36>`. The 6 random chars are derived from a hash of `(channelId, now.getTime())` so the function stays pure under fixed inputs (test injection via `randomSeed?` arg keeps determinism).
    - Sections rendered in order from RESEARCH Q1: Status snapshot → Mission → Ticket DAG → Recent decisions → Files touched → Working memory.
    - Status snapshot lists: tier (from channel.tier), channel kind, repos (from `channel.repoAssignments`), active runs (from `readRunLinks`, count + IDs of runs without `endedAt`), last activity (newest feed entry's `createdAt`).
    - Mission renders `channel.description` truncated to 1KB if longer (per Q2 cap of 300 tokens).
    - Ticket DAG: render up to 30 most-recent tickets in dependency-topo order (using `validateTicketDag` from `src/domain/ticket.ts`); if cycle present, fall back to `linearizeTickets` and add a footer warning. Markdown table with columns: ID, Title, Status, Specialty, Depends on, Updated.
    - Recent decisions: last 5 decisions with full rationale + alternatives; older decisions one-line summary (newest-first per `listDecisions` output). Render `(none recorded)` when `alternatives` is empty per RESEARCH Q3.
    - Files touched: when `gitLogEnabled !== false`, delegates to `getFilesTouchedByTicket(channelId, ticketId, repoCwds)` from `src/orchestrator/handoff/files-touched.ts`. v1 implementation runs `git log --name-only --pretty=format:%H` against each repo's cwd looking for commits whose subject mentions the ticketId; collects unique file paths. If `git` is missing OR `gitLogEnabled === false`, returns `[]` and the section renders `(no files-touched data)`. The function MUST be safe on a fresh repo (no commits) and on a path that isn't a git repo. **Render a M4 footnote** at the end of the Files-touched section regardless of whether files were found: `> *(v1: files-touched is reconstructed from git log; uncommitted changes and tickets without commit references are missing. Tracked: D-02.)*`.
    - Working memory section: if `gapFill` provided AND `gapFill.capturedAt` within 1 hour of `now`, render the four slots; else render `[gap-fill not provided]` with explanatory note: `> The departing agent did not author working-memory context. The destination session will need to re-derive line-of-attack from the deterministic sections above.`
    - Truncation is newest-first (preserve recent context) and per-section. When a section overflows its budget, drop oldest items and set `section.truncated = true`. Section heading is unchanged.
    - `renderBrief(brief)`: deterministic string-concat. Header includes `**Channel id:** <id>`, `**Generated at:** <iso>`, `**From:** <fromProvider or "unknown">`, `**To:** <toHint or "(unspecified)">`, `**Schema version:** 1`. **If `brief.resumedFrom` is set (M7),** include a header line: `**Resumed from:** brief-XXX (originally generated YYYY-MM-DD)`. Footer: `*Generated by ` + backtick + `rly handoff` + backtick + `. Sections above the divider are deterministic from ` + backtick + `~/.relay/` + backtick + `. The "Working memory" block was authored by <agent-or-placeholder> at <timestamp>.*`. NO markdown library — pure template-literal string concat per RESEARCH §Don't Hand-Roll.
    - `validateBrief(brief, opts)` where `opts: { mode: "strict" | "permissive"; maxTokens?: number; allowSecretsBypass?: false }` (per M2): returns `{ ok: true }` or `{ ok: false; errors: string[]; warnings: string[] }`.
      - In STRICT mode (used by `--to`): hard errors on (1) total `tokenEstimate` > `maxTokens` (default `BRIEF_TOKEN_BUDGETS.totalHardCap = 8000`) — message `"Brief exceeds hard cap (<n> > <max>). Re-run with --force to override."`; (2) any required section missing; (3) any `section.body` matching the secret-pattern regex set.
      - In PERMISSIVE mode (used by `--save`): hard errors ONLY on (3) the secret-pattern set. Token-cap and missing-section conditions become warnings (or are skipped) — rationale: `--save` is for archival; the cap is enforced when the brief is later resumed via `--to`.
      - Secret-pattern regex set (BOTH modes):
        - `/AKIA[A-Z0-9]{16}/` (AWS access key)
        - `/sk-[a-zA-Z0-9]{20,}/` (OpenAI / similar)
        - `/(?:secret|password|token|api[_-]?key)\s*[:=]\s*\S{8,}/i` (generic key=value)
        - `/-----BEGIN [A-Z ]+PRIVATE KEY-----/` (PEM)
       - Secret-pattern errors do NOT have a `--force` override (D-09).
       - Warnings (non-blocking, BOTH modes): `tokenEstimate > BRIEF_TOKEN_BUDGETS.totalSoftCap` (4000) — `"Brief above soft cap; consider trimming."`; `gapFill` is older than 1 hour relative to `brief.generatedAt`; any section has `truncated === true`.
  </behavior>
  <action>
    Per D-02, D-04, D-09, M2, M3, M4, M7, RESEARCH §Synthesizer and §Q20.

    **Step 1 — `src/orchestrator/handoff/files-touched.ts`:**
    Implement `getFilesTouchedByTicket(channelId, ticketId, repoCwds, opts: { enabled?: boolean })`. When `enabled === false`, return `[]` immediately with no git invocation. Otherwise spawn `git -C <cwd> log --name-only --pretty=format:%H%n%s -n 200` (200-commit cap) per repo, parse the output, find commit blocks whose subject (line after the SHA) contains the ticketId substring, collect the file paths from those blocks. Dedup. Return an array. Spawning MUST go through `NodeCommandInvoker` (`src/agents/command-invoker.ts`) per RESEARCH §Security — pass `passEnv: []` (no env needed). On non-zero exit OR `ENOENT` (git missing) OR cwd-not-a-git-repo, return `[]` silently. **Add a header JSDoc citing D-02 AND M3:** "v1 implementation; revisit if briefs feel thin (RESEARCH Q6/A4). NOTE: this is the ONE declared side effect of the otherwise pure-over-declared-inputs `buildBrief`. Two back-to-back calls separated by `git pull` can produce different file lists. Tests opt out via `gitLogEnabled: false`." Cap result at 30 files per ticket (newest-first preserved by git's reverse-chrono order — slice last).

    **Step 2 — `src/orchestrator/handoff/synthesizer.ts`:**
    Implement `buildBrief` per the behavior bullets. The function injects `channelStore` and `artifactStore` for tests (default to `new ChannelStore()` / `new LocalArtifactStore()` when unset). It MUST NOT call `Date.now()`, `Math.random()`, or `process.env` directly — `now` is passed in; randomness for `briefId` is derived from a stable hash of inputs. Use `node:crypto::createHash("sha256")` over `${channelId}:${now.toISOString()}` and slice the first 6 hex chars (lowercased) for the random suffix. Pass `gitLogEnabled` through to `getFilesTouchedByTicket`.

    Add a top-of-file JSDoc citing M3: "**Pure-over-declared-inputs.** The function consumes `~/.relay/` data plus an explicit `now` and an injectable `channelStore` / `artifactStore`. The one declared side effect is the v1 files-touched enrichment, which can be disabled via `options.gitLogEnabled = false` for strict bit-identicality assertions. See `docs/design/handoff-brief.md` §Determinism caveats."

    Render each section with budget enforcement:
    1. Build the section body string.
    2. `estimatedTokens = estimateTokens(body)`.
    3. If `estimatedTokens > budget`, truncate the body's data input (e.g. drop oldest decisions, drop oldest tickets) and re-build until under budget OR until the section is empty + placeholder. Set `truncated = true` when truncation occurred.
    4. Assemble `BriefSection { heading, body, estimatedTokens, truncated }`.

    For ticket DAG topo-order, adapt RESEARCH §Code Examples: build the synthetic ticket-spec shape `validateTicketDag` expects (carrying only the fields it cares about). On cycle, fall back to `linearizeTickets` and append a warning footer to the ticket-DAG section: `> Warning: ticket dependency cycle detected; rendered in linear order.`

    Total `tokenEstimate` is the sum of `section.estimatedTokens`. NO markdown is rendered here — that's `render-markdown.ts`'s job.

    **Step 3 — `src/orchestrator/handoff/render-markdown.ts`:**
    Implement `renderBrief(brief: HandoffBrief): string`. Pure string-concat. Use template literals; do NOT import a markdown library (RESEARCH §Don't Hand-Roll). The header MUST literally include `**Schema version:** 1`. **If `brief.resumedFrom` is defined (M7),** add a header line `**Resumed from:** ${brief.resumedFrom.briefId} (originally generated ${formatDate(brief.resumedFrom.originalGeneratedAt)})`. Each section MUST be rendered under an H2 heading matching the order in the behavior bullets. The horizontal rule `---` separates sections-above (deterministic) from the agent-authored "Working memory" block per RESEARCH Q1. **Files-touched section MUST end with the M4 footnote line:** `> *(v1: files-touched is reconstructed from git log; uncommitted changes and tickets without commit references are missing. Tracked: D-02.)*`. Footer block lists generation provenance.

    **Step 4 — `src/orchestrator/handoff/validate.ts`:**
    Implement `validateBrief(brief, opts)` with the `mode: "strict" | "permissive"` discriminator (M2). The signature is:
    ```ts
    export function validateBrief(
      brief: HandoffBrief,
      opts: { mode: "strict" | "permissive"; maxTokens?: number }
    ): { ok: boolean; errors: string[]; warnings: string[] };
    ```
    Compose secret-pattern checks as a single function over each `section.body`. In STRICT mode, errors are returned as a flat string list in the order: token-cap → missing-section → secret-leak. In PERMISSIVE mode, only secret-leak errors are returned (token-cap and missing-section conditions either become warnings or are skipped — pick warnings for token-cap so post-resume callers see the signal). Warnings are returned in their own list — they do not gate `ok`. The `--force` flag at the CLI layer is permitted to override the token-cap error and the missing-section error in STRICT mode, but NEVER the secret-leak error in EITHER mode (D-09). Validation does not throw — it returns the result object so the CLI can format errors.

    **Step 5 — Wave 0+1 tests turn green:**
    Re-run `pnpm test test/orchestrator/handoff/synthesizer.test.ts test/orchestrator/handoff/render-markdown.test.ts test/orchestrator/handoff/validate.test.ts`. All three should now pass; the remaining four Wave-0 scaffolds remain RED until later waves.

    **Step 6 — No drive-by reformats** (AGENTS.md). Touch only the four files in `<files>`.
  </action>
  <verify>
    <automated>pnpm typecheck && pnpm test test/orchestrator/handoff/synthesizer.test.ts test/orchestrator/handoff/render-markdown.test.ts test/orchestrator/handoff/validate.test.ts 2>&1 | tee /tmp/wave1-tests.log; grep -E "Tests +[0-9]+ passed" /tmp/wave1-tests.log</automated>
  </verify>
  <done>
    Three Wave-0 test files (synthesizer, render-markdown, validate) pass under `pnpm test` in scripted mode. `buildBrief` is **pure-over-declared-inputs** (M3): deterministic over fixed inputs when `gitLogEnabled: false`; with git enabled, the only non-determinism source is documented (D-02 footnote in render output per M4, JSDoc on `files-touched.ts`, design-doc note in Wave 5). `renderBrief` produces stable markdown with `**Schema version:** 1` header and the M4 footnote in the Files-touched section; renders the `**Resumed from:** ...` header line when `brief.resumedFrom` is set (M7). `validateBrief` operates in STRICT or PERMISSIVE mode (M2) and correctly classifies token-overage / missing-section / secret-pattern errors and gap-staleness / soft-cap / truncation warnings. `getFilesTouchedByTicket` returns `[]` on missing-git / not-a-repo / unmatched-ticket / `gitLogEnabled === false` without throwing. PR LOC < 800 (combined Wave 0+1 estimate: ~750 LOC across seven impl/scaffold files; well under L2's discipline limit).
  </done>
</task>

<!-- ============================================================ -->
<!-- WAVE 2 — MCP gap-fill tool + persistence (single PR) -->
<!-- ============================================================ -->

<task type="auto" tdd="true">
  <name>Task 2.1 (Wave 2): channel_handoff_finalize MCP tool + brief persistence layer</name>
  <requirements>REQ-2.3, REQ-2.6, REQ-2.9</requirements>
  <files>
    src/orchestrator/handoff/persistence.ts,
    src/mcp/channel-tools.ts,
    test/mcp/channel-handoff-finalize.test.ts,
    test/orchestrator/handoff/persistence.test.ts
  </files>
  <behavior>
    - `writeBriefArtifact({ channelId, briefId, markdown, gapFill }): Promise<{ mdPath, gapJsonPath }>` writes both files atomically (tmp-file + rename per `src/channels/channel-store.ts::writeChannel`).
    - `writeGapFill({ channelId, briefId, payload }): Promise<{ gapJsonPath }>` writes only the gap.json (the MCP tool's path — brief md is written later by the synthesizer when `rly handoff` runs).
    - `readLatestGapFill(channelId, opts: { maxAgeMs?: number, now: Date }): Promise<GapFillBlock | null>` lists `~/.relay/channels/<id>/handoffs/*.gap.json`, picks newest by `capturedAt`, returns `null` if older than `maxAgeMs` (default 1 hour) — staleness gating per RESEARCH Pitfall 3. **Returns `null` on any record whose `schemaVersion !== 1`** (per M9 — fail closed, do not silently coerce).
    - All three functions use `getRelayDir()` from `src/cli/paths.ts` and `assertSafeSegment(channelId, "channelId")` + `assertSafeSegment(briefId, "briefId")` (path-traversal guard).
    - `briefId` regex: `/^brief-[0-9]+-[a-z0-9]+$/` — enforced inside `assertValidBriefId(briefId)` helper exported from the same file. Invalid id ⇒ thrown error.
    - MCP tool `channel_handoff_finalize` is registered in `getChannelToolDefinitions()` and dispatched in `callChannelTool()`. Input schema matches RESEARCH §Q9 (`channelId`, `currentLineOfAttack` ≤ 4000 chars, `activeHypothesis` ≤ 2000, `abandonedApproaches` array of strings ≤ 1000 each, `openQuestions` array of strings ≤ 500 each; `sessionId` optional). **The Zod schema MUST explicitly include and reject any payload with `schemaVersion !== 1`** (per M9 — `z.literal(1).optional()` shape, defaulting to 1 if omitted). Tool returns `{ ok: true, briefId, gapJsonPath, schemaVersion: 1 }` on success.
    - Tool generates a `briefId` if not supplied (matches the synthesizer's id format) — `now` is read via the existing pattern in `src/mcp/channel-tools.ts` (orchestrator clock; not test-injected here because MCP tools run in the live runtime, but the underlying `writeGapFill` is test-injectable via dependency).
    - Tool writes the gap.json with `schemaVersion: 1`, `capturedAt: new Date().toISOString()`, `briefId`, `channelId`, `capturedBySessionId: args.sessionId ?? null`, and the four payload fields.
    - Calling the tool twice for the same channel writes TWO distinct gap.json files (different `briefId`s) — never overwrites. The synthesizer always reads the newest non-stale one.
  </behavior>
  <action>
    Per D-05, D-06, M9, RESEARCH §Q9, §Q10, §Departing Agent Gap-Filling.

    **Step 1 — `src/orchestrator/handoff/persistence.ts`:**
    Implement `writeBriefArtifact`, `writeGapFill`, `readLatestGapFill`, `assertValidBriefId`, and `buildBriefId(now, salt)` (mirrors synthesizer's id generation; export so the MCP tool reuses it). All disk writes follow tmp-rename:
    ```ts
    const tmpPath = `${finalPath}.tmp.${process.pid}.${Date.now()}.${counter++}`;
    await writeFile(tmpPath, content, "utf8");
    await rename(tmpPath, finalPath);
    ```
    Use `mkdir(handoffsDir, { recursive: true })` before any write. The handoffs directory is `join(getRelayDir(), "channels", channelId, "handoffs")` — both segments pass through `assertSafeSegment` first.

    `readLatestGapFill` reads the directory, filters files matching `/^brief-[0-9]+-[a-z0-9]+\.gap\.json$/`, parses each, **filters out any record with `schemaVersion !== 1`** (per M9 — rationale comment in code: "Future schemaVersion bumps require coordinated upgrade; until then, fail closed."), picks the one with the newest `capturedAt`, and gates by staleness. JSON parse errors on individual files are skipped (don't kill the read).

    **Step 2 — Extend `src/mcp/channel-tools.ts`:**
    In `getChannelToolDefinitions()`, append the `channel_handoff_finalize` tool object verbatim from RESEARCH §Q9 (with the `additionalProperties: false` and `required` arrays). Description: `"Capture working-memory context before this session ends. Call this when context is near its limit OR when the user has accepted a handoff prompt. The four blocks are persisted as the agent-authored section of the next handoff brief."`

    In `callChannelTool()`, add a `case "channel_handoff_finalize":` arm that:
    1. Validates inputs via Zod (mirror existing tool patterns in `channel-tools.ts`). The Zod schema for the optional `schemaVersion` field uses `z.literal(1).optional()` — any other value is rejected with a clear error message (M9).
    2. Calls `assertSafeSegment(args.channelId, "channelId")`.
    3. Generates a `briefId` via `buildBriefId(new Date(), args.channelId)`.
    4. Calls `writeGapFill(...)` with the assembled payload (always writes `schemaVersion: 1`).
    5. Returns the tool result envelope.

    **Step 3 — `test/mcp/channel-handoff-finalize.test.ts`:**
    Use `mkdtemp(join(tmpdir(), "relay-handoff-mcp-"))` for `~/.relay/` isolation per AGENTS.md. Test cases:
    - happy path: input the four slots ⇒ assert returned `briefId` matches regex; assert gap.json exists at `<tmp>/channels/<id>/handoffs/<briefId>.gap.json`; assert parsed JSON matches the input + `schemaVersion: 1` + `capturedAt` is ISO.
    - missing required field ⇒ Zod validation rejects.
    - oversized `currentLineOfAttack` (> 4000 chars) ⇒ Zod rejects.
    - **schemaVersion: 2 in input ⇒ Zod rejects with a message naming the field (M9).**
    - path-traversal channelId (`../../etc`) ⇒ `assertSafeSegment` throws.
    - two consecutive calls for the same channel ⇒ two distinct gap.json files exist (no overwrite).

    **Step 4 — `test/orchestrator/handoff/persistence.test.ts`:**
    - `writeBriefArtifact` writes both files atomically; the .tmp.* intermediate is renamed (assert no `.tmp.` files remain after the call).
    - `readLatestGapFill` returns `null` when directory missing.
    - `readLatestGapFill` returns the newest gap.json by `capturedAt` (write three with different timestamps; assert).
    - `readLatestGapFill` returns `null` when the newest is older than `maxAgeMs` (default 1h).
    - **`readLatestGapFill` returns `null` when the on-disk record has `schemaVersion: 2` (M9 round-trip):**
      ```ts
      it("preserves schemaVersion: 2 on round-trip (does not silently coerce to 1)", async () => {
        const gapJsonPath = join(channelHandoffsDir, "brief-1746789123456-z9z9z9.gap.json");
        await writeFile(
          gapJsonPath,
          JSON.stringify({
            schemaVersion: 2, // intentional future-bump probe
            briefId: "brief-1746789123456-z9z9z9",
            channelId,
            capturedAt: new Date(now.getTime() - 30_000).toISOString(),
            capturedBySessionId: null,
            currentLineOfAttack: "v2 should be rejected",
            activeHypothesis: "",
            abandonedApproaches: [],
            openQuestions: [],
          }),
        );
        const loaded = await readLatestGapFill(channelId, { now });
        expect(loaded).toBeNull();
      });
      ```
    - `assertValidBriefId` throws on `brief-no-suffix`, `BRIEF-001-x` (uppercase), `brief-001` (no random suffix), accepts `brief-1746789123456-a1b2c3`.

    **Step 5 — README MCP list update (cross-dashboard contract from AGENTS.md):**
    Append `channel_handoff_finalize` to the README's "MCP tools" list. Also re-run `rly inspect-mcp` (mentally) — the tool definitions should be the source of truth; the README count must match.

    **Step 6 — Wave 2 tests turn green; Wave 0/1 stay green.**
  </action>
  <verify>
    <automated>pnpm typecheck && pnpm test test/mcp/channel-handoff-finalize.test.ts test/orchestrator/handoff/persistence.test.ts test/orchestrator/handoff/synthesizer.test.ts test/orchestrator/handoff/render-markdown.test.ts test/orchestrator/handoff/validate.test.ts 2>&1 | tee /tmp/wave2-tests.log; grep -E "Tests +[0-9]+ passed" /tmp/wave2-tests.log</automated>
  </verify>
  <done>
    `channel_handoff_finalize` is a registered MCP tool that persists a versioned gap.json under `~/.relay/channels/<id>/handoffs/<briefId>.gap.json` with atomic tmp-rename writes. `writeBriefArtifact`, `writeGapFill`, `readLatestGapFill` handle the brief filesystem layer. Path-traversal is guarded by `assertSafeSegment`. Stale gap.json (>1h) is filtered out. **`schemaVersion !== 1` records are rejected at BOTH the Zod input layer (MCP tool) AND the disk-read layer (`readLatestGapFill`) — fail closed (M9).** README MCP-tools list reflects the new tool. PR LOC < 800 (estimate: ~450 LOC including the M9 round-trip test). Wave 0/1 tests stay green.
  </done>
</task>

<!-- ============================================================ -->
<!-- WAVE 3 — Threshold listener + ApprovalKind extension (single PR) -->
<!-- ============================================================ -->

<task type="auto" tdd="true">
  <name>Task 3.1 (Wave 3): ApprovalKind extension + 90% threshold listener wired to dispatch</name>
  <requirements>REQ-2.4, REQ-2.9</requirements>
  <files>
    src/approvals/queue.ts,
    src/orchestrator/handoff/threshold-listener.ts,
    src/orchestrator/dispatch.ts,
    src/cli/run-autonomous.ts
  </files>
  <behavior>
    - `ApprovalKind` is widened to `"merge-pr" | "create-ticket" | "handoff-prompt"`. The discriminated `ApprovalRequest` union grows a `{ kind: "handoff-prompt"; payload: HandoffPromptPayload }` arm.
    - `attachHandoffThresholdListener({ channelStore, approvalsQueue, channelId, sessionId, pollIntervalMs?, abortSignal? }): { unsubscribe: () => void }` polls `channelStore.readFeed(channelId, 50)` at `pollIntervalMs` intervals. **Default `pollIntervalMs` is 5000 (5 seconds) per M8** — context crossings are minutes-scale, not sub-second; tests override with `pollIntervalMs: 50`. Filters entries where:
      - `entry.type === "status_update"`
      - `entry.metadata?.kind === "context_threshold"`
      - `entry.metadata?.threshold === "90"` (STRING comparison — Phase 1 emits as string)
      - `entry.metadata?.sessionId === sessionId`  (filter by THIS session)
      - `entry.entryId` not yet seen (in-memory `Set<entryId>`)
    - On match, the listener:
      1. Adds the entryId to the seen-set (in-memory dedup for same-process polling).
      2. Builds a `HandoffPromptPayload` from `entry.metadata`. **Per M1, conversions happen here, exactly once:** `thresholdPct = Number(entry.metadata.threshold)` (string `"90"` → number `90`); `pct = Number(entry.metadata.pct)` (string `"91.23"` → number `91.23`); `used = Number(entry.metadata.used)`; `total = Number(entry.metadata.total)`.
      3. Calls `approvalsQueue.enqueue({ sessionId, kind: "handoff-prompt", payload })`.
      4. Posts a feed entry of `type: "status_update"` with `metadata.handoffPrompt: true, sessionId, threshold: 90` so dashboards reflect the prompt (RESEARCH §Q11 step 1).
    - The listener dedupes by in-memory `entryId` set (same-process) AND by `(sessionId, threshold)` derived from existing `ApprovalsQueue` records on attach (cross-restart). After restart, even though the in-memory `Set<entryId>` is empty, re-reading the feed will not double-enqueue because the `(sessionId, threshold)` cross-check from existing approvals filters duplicates.
    - The listener is wired in two places: (a) chat dispatch (`src/orchestrator/dispatch.ts`) when a chat session has a `channelId`; (b) the autonomous-loop runner (`src/cli/run-autonomous.ts`) when starting an autonomous session that owns a channel. Both paths attach on session-start and `unsubscribe()` on session-end. The listener tolerates `unsubscribe()` being called multiple times.
    - The listener uses `ChannelStore.readFeed` polling — it does NOT import from `src/budget/`. The Phase 1 contract is read via the channel feed, per the inherited `<phase_2_handoff_contract>` block.
    - **Self-loop disjointness (L6):** the listener's own posts carry `metadata.handoffPrompt: true` (NOT `metadata.kind: "context_threshold"`). The poll predicate filters on `metadata.kind === "context_threshold"`, so the listener cannot match its own posts. A code comment makes this explicit.
  </behavior>
  <action>
    Per D-01, D-07, H1, M1, M8, L6, RESEARCH §Q11, §Q12, §Code Examples ("Subscribing to Phase 1's threshold event"). NOTE: research recommends in-process EventEmitter from Phase 1's tracker; the user-decision block (D-01) anchors on the FEED contract instead — feed-watching is the authoritative subscription. We use feed-polling for cross-process safety and to avoid coupling to Phase 1's TokenTracker instance lifecycle.

    **Step 1 — `src/approvals/queue.ts`:**
    Widen `ApprovalKind` to include `"handoff-prompt"`. Add the `HandoffPromptPayload` import (from `src/domain/handoff.ts`). Extend the `ApprovalRequest` union with the third arm. Update `enqueue`, internal payload type guards, and JSON serialization shape so the new kind round-trips through `~/.relay/approvals/<sessionId>/queue.jsonl`. Do NOT touch existing `merge-pr` / `create-ticket` logic. **Do NOT add a `kind` filter to `list()` — `ListOptions` stays `{ status? }` (per H1; the actual signature is `list(sessionId: string, options?: ListOptions)`); callers filter by `kind` in JS.**

    Add a Zod-or-equivalent validator for `handoff-prompt` payloads matching `HandoffPromptPayload` shape. Reject unknown payload shapes loudly.

    **Step 2 — `src/orchestrator/handoff/threshold-listener.ts`:**
    Implement `attachHandoffThresholdListener` per the behavior bullets. Use `setInterval(() => poll(), pollIntervalMs)` with `unref()` so the listener doesn't hold the process open. **Default `pollIntervalMs = 5000` (M8); add a code comment:** `// 5s default: context crossings are minutes-scale (token budgets are 100K-1M), not sub-second. Tests pass pollIntervalMs: 50 to keep wall-clock under 200ms. Tradeoff: a 5s lag between Phase 1 emitting a context_threshold and the user seeing the prompt is acceptable; reducing this to 1s would 5× the readdir/readFile load on a 5-session orchestrator with no UX benefit.`

    **Add a code comment justifying L6 self-loop disjointness:** `// Listener's own posts (metadata.handoffPrompt: true) are NOT matched by the context_threshold predicate above (which requires metadata.kind === "context_threshold"). The two predicates are disjoint by construction — there is no self-loop, and we can post freely without filtering our own writes.`

    The poll function:
    1. Reads the last 50 feed entries.
    2. Filters per the four metadata predicates above.
    3. **For each match not in `seen` AND not in `seenThresholds` (per H1):** parse numbers per M1, build the payload, enqueue an approval, post the dashboard feed entry, add to BOTH in-memory dedup sets.
    4. Returns silently on `readFeed` errors (best-effort; log via `console.warn("[handoff-threshold-listener] ...")`).
    AbortSignal handling: if `abortSignal.aborted`, clear the interval. The returned `unsubscribe` clears the interval (no need to clean the dedup sets — they go out of scope on listener teardown).

    **Restart-idempotency seed (H1 fix):**
    Init dedup state by reading **`approvalsQueue.list(sessionId)` (positional sessionId — actual signature)** at attach time:
    ```ts
    // H1: ApprovalsQueue.list signature is `list(sessionId: string, options?: ListOptions)`
    // where ListOptions is `{ status? }` only — NO `kind` filter. Filter by kind in JS.
    const existing = await approvalsQueue.list(sessionId);
    const seenThresholds = new Set<number>();
    for (const rec of existing) {
      if (rec.kind !== "handoff-prompt") continue;
      // D-03 contract: dedup on (sessionId, threshold). The sessionId is fixed (this listener
      // is per-session), so we only need to track which thresholds we've already enqueued for it.
      // payload.thresholdPct is the parsed-number form (per M1).
      const payload = rec.payload as HandoffPromptPayload;
      if (typeof payload?.thresholdPct === "number") {
        seenThresholds.add(payload.thresholdPct);
      }
    }
    // The in-memory `seen` set of entryIds is separately maintained for same-process polling
    // and is intentionally empty after restart — the seenThresholds cross-check makes restart
    // safe without persisting entryIds.
    ```
    The `HandoffPromptPayload` interface deliberately has NO `entryId` field (per H1 — keeps the payload contract narrow; restart dedup is by `(sessionId, threshold)` only).

    **Step 3 — Wire into `src/orchestrator/dispatch.ts`:**
    In the chat-session dispatch path (where `tracker` is constructed today per Phase 1's plan), after constructing the tracker AND after the channelId is known, attach the threshold listener:
    ```ts
    if (run.channelId) {
      const handoffSubscription = attachHandoffThresholdListener({
        channelStore,
        approvalsQueue,
        channelId: run.channelId,
        sessionId: run.sessionId,
      });
      // Stash alongside the existing trackerPool unsubscribe (similar to Phase 1's attachThresholdFeed pattern).
      run.cleanups.push(() => handoffSubscription.unsubscribe());
    }
    ```
    Adapt to actual variable names from `dispatch.ts` after reading the file. The cleanup MUST run before the tracker pool is closed (mirror Phase 1 Task 5 ordering).

    **Step 4 — Wire into `src/cli/run-autonomous.ts`:**
    Same pattern. When the autonomous loop starts a session that has a channelId, attach + register cleanup.

    **Step 5 — Wave 0 `threshold-listener.test.ts` turns green:**
    The Wave 0 test scaffolds for this listener now pass. The test:
    - Creates a tmp `~/.relay/`; instantiates `ChannelStore` and `ApprovalsQueue`.
    - Creates a channel; posts a Phase-1-shaped `context_threshold` entry with `threshold === "90"` and `sessionId === "sess-x"`.
    - Calls `attachHandoffThresholdListener({ channelStore, approvalsQueue, channelId, sessionId: "sess-x", pollIntervalMs: 50 })`.
    - Awaits 200ms.
    - Asserts `(await approvalsQueue.list("sess-x")).filter(r => r.kind === "handoff-prompt")` has exactly one record with the expected payload shape AND `payload.thresholdPct === 90` (NUMBER, not string `"90"` — pinpoints M1).
    - Posts another identical entry (same metadata but new entryId) ⇒ asserts STILL one approval (dedup by `(sessionId, threshold)`).
    - Posts a `threshold === "75"` entry ⇒ asserts STILL one approval (filtered).
    - Calls `unsubscribe()` and confirms no leak by re-posting and waiting another 200ms — count remains 1.

    **Add (H2b — defense in depth):** an `it("two distinct sessionIds both crossing 90% enqueue independent approvals", ...)`:
    ```ts
    it("two distinct sessionIds both crossing 90% enqueue independent approvals", async () => {
      const subA = attachHandoffThresholdListener({ channelStore, approvalsQueue, channelId, sessionId: "sess-A", pollIntervalMs: 50 });
      const subB = attachHandoffThresholdListener({ channelStore, approvalsQueue, channelId, sessionId: "sess-B", pollIntervalMs: 50 });
      // Post a 90% entry for sess-A
      await channelStore.postEntry(channelId, {
        type: "status_update", fromAgentId: null, fromDisplayName: "system",
        content: "Context window at 91% (90% threshold).",
        metadata: { kind: "context_threshold", schemaVersion: "1", threshold: "90", pct: "91.0", used: "182000", total: "200000", sessionId: "sess-A" },
      });
      // Post a 90% entry for sess-B
      await channelStore.postEntry(channelId, {
        type: "status_update", fromAgentId: null, fromDisplayName: "system",
        content: "Context window at 92% (90% threshold).",
        metadata: { kind: "context_threshold", schemaVersion: "1", threshold: "90", pct: "92.0", used: "184000", total: "200000", sessionId: "sess-B" },
      });
      await new Promise(r => setTimeout(r, 200));
      const apprA = (await approvalsQueue.list("sess-A")).filter(r => r.kind === "handoff-prompt");
      const apprB = (await approvalsQueue.list("sess-B")).filter(r => r.kind === "handoff-prompt");
      expect(apprA).toHaveLength(1);
      expect(apprB).toHaveLength(1);
      expect((apprA[0].payload as HandoffPromptPayload).sessionId).toBe("sess-A");
      expect((apprB[0].payload as HandoffPromptPayload).sessionId).toBe("sess-B");
      subA.unsubscribe();
      subB.unsubscribe();
    });
    ```

    **Step 6 — Idempotency under restart:**
    Add a small test (in the same file) that simulates restart: enqueue an approval, then re-attach the listener (fresh in-memory `seen` set), and assert the listener doesn't double-enqueue when re-reading the same feed entries. The `seenThresholds` init from `approvalsQueue.list(sessionId)` (Step 2, H1 fix) handles this.

    **Step 7 — Decline path is benign (D-07 / RESEARCH §Acceptance):**
    The listener's responsibility ends at enqueue. The user `rly approve <id>` / `rly reject <id>` paths are existing AL-7 surfaces — no changes needed. Document in a code comment that "rejected handoff-prompt approvals are no-op terminal states; the user simply continues their session."

    Wave 0/1/2 tests stay green.
  </action>
  <verify>
    <automated>pnpm typecheck && pnpm test test/orchestrator/handoff/threshold-listener.test.ts test/orchestrator/handoff/synthesizer.test.ts test/orchestrator/handoff/render-markdown.test.ts test/orchestrator/handoff/validate.test.ts test/orchestrator/handoff/persistence.test.ts test/mcp/channel-handoff-finalize.test.ts 2>&1 | tee /tmp/wave3-tests.log; grep -E "Tests +[0-9]+ passed" /tmp/wave3-tests.log</automated>
  </verify>
  <done>
    `ApprovalKind` includes `"handoff-prompt"`. `attachHandoffThresholdListener` polls the channel feed (default 5s — M8), dedupes by `(sessionId, threshold)` with the H1-correct `approvalsQueue.list(sessionId)` API, parses STRING→NUMBER at the boundary exactly once per M1, and is wired into chat dispatch + autonomous loop. The listener is single-emit per crossing per session lifetime, even across orchestrator restarts. Two distinct sessionIds both at 90% enqueue independent approvals (H2b defense in depth). Self-loop disjointness is documented in a code comment (L6). Phase 1 internals are NOT imported (no `src/budget/` import in Phase 2 code). Wave 0-3 tests all green. PR LOC < 800 (estimate: ~520 LOC).
  </done>
</task>

<!-- ============================================================ -->
<!-- WAVE 4 — `rly handoff` CLI + new-session seed + --save mode -->
<!-- Pre-planned per L3 as Wave 4a (CLI handler + mode dispatch) and Wave 4b -->
<!-- (spawn helpers + index.ts wiring). The two sub-PRs land sequentially -->
<!-- if the combined diff exceeds 800 LOC; otherwise both arms can ship in -->
<!-- one PR. Decision deferred to first commit's diff-stat measurement. -->
<!-- ============================================================ -->

<task type="auto" tdd="true">
  <name>Task 4.1 (Wave 4 — pre-split as 4a/4b per L3): `rly handoff` CLI handler — modes (--to / --save / --resume), provider seeding (Claude + Codex), feed entry, JSON output</name>
  <requirements>REQ-2.1, REQ-2.5, REQ-2.6, REQ-2.7, REQ-2.8, REQ-2.9</requirements>
  <files>
    src/cli/handoff.ts,
    src/index.ts
  </files>
  <behavior>
    - `rly handoff <channelId> --to <value>` — happy path. Resolves `<value>` per D-03 layered fallback, generates brief, validates in STRICT mode (M2), writes artifacts, posts feed entry, dispatches new session, prints stdout per RESEARCH §Q16.
    - `rly handoff <channelId> --save` (no `--to`) — D-08 save-only mode. Generates + persists brief; does NOT dispatch. Validates in PERMISSIVE mode (M2 — secret-pattern only). Prints brief path + token estimate.
    - `rly handoff <channelId> --resume <briefId> --to <value>` — D-08 resume mode. **Reads ONLY `<briefId>.gap.json` from disk (per M7 — the `<briefId>.md` is a snapshot, not re-consumed).** REGENERATES the deterministic skeleton from current channel state (current ticket DAG, current decisions — per RESEARCH Q17 "deterministic state has moved on"), keeps the saved gap-fill, writes a NEW briefId, populates `brief.resumedFrom = { briefId: <originalBriefId>, originalGeneratedAt }`, dispatches new session.
    - `rly handoff <channelId> --resume latest --to <value>` — same, but resolves to the newest existing brief in the channel's handoffs/ dir.
    - `--max-tokens <n>` — overrides the validate-brief hard cap (default 8000) in STRICT mode. `--force` — bypasses non-secret validation errors per D-09 (STRICT mode only — PERMISSIVE has nothing non-secret to bypass). `--json` — switches stdout to a single-line JSON envelope per RESEARCH §Q16.
    - Resolution order for `--to <value>` (D-03 / RESEARCH §Q15):
      1. `ProviderProfileStore.getProfile(value)` — provider profile id.
      2. Adapter name match: `value === "claude"` ⇒ default Claude profile; `value === "codex"` ⇒ default Codex profile.
      3. Channel repo alias match: `channel.repoAssignments.find(a => a.alias === value)` — use that repo's primary provider (channel's `providerProfileId` or fallback default).
      4. Else: error with the three places to look (per RESEARCH §Q15 error string).
    - Spawning is provider-aware:
      - **Claude:** `claude -p --output-format stream-json --verbose --append-system-prompt "<buildSystemPrompt(channelId, ...)>" "<brief markdown>"` via `launchInteractiveCommand` from `src/cli/launcher.ts`. Capture returned session id and persist to `ChatSession.claudeSessionIds[alias]` via `SessionStore`.
      - **Codex chat-seed (per M6, distinct from `src/agents/cli-agents.ts:277-298` orchestrator-pipeline path):** `codex exec -C <cwd> --skip-git-repo-check --sandbox <read-only|workspace-write> [--model <profile.defaultModel>] "<brief markdown>"` via `NodeCommandInvoker`. **Drops the orchestrator-pipeline flags** `--output-schema`, `-o`, and `--ask-for-approval` because the chat-seed path has no JSON contract back to the orchestrator (the new session is interactive, not a one-shot). Sandbox stays `read-only` unless the channel has `fullAccess` (then `workspace-write`). Model from `profile.defaultModel` if set, else Codex default. Codex has no streaming / no resume; capture stdout for the response. **Extract a `buildCodexChatArgv(profile, channel, briefMarkdown, cwd)` helper for testability** (per M6).
    - Both spawn paths route through `NodeCommandInvoker` for env sanitization (RESEARCH §Security).
    - **Cross-implementation note (L7):** the TS spawner is independent of the Tauri command at `gui/src-tauri/src/lib.rs:start_chat`. Any later refactor of `start_chat` does not affect `src/cli/handoff.ts` callers. The two paths converge only at the `claude -p` / `codex exec` argv level. Documented in code comment.
    - The CLI path posts a feed entry per RESEARCH §Q16 with `type: "status_update"`, `metadata.handoff: true, briefId, fromProvider, toProvider, toProfileId, fromSessionId, toSessionId`.
    - The CLI prompts the running departing agent to call `channel_handoff_finalize` (best effort) BEFORE generating the brief, by waiting up to 30s for a fresh gap.json (configurable via `--wait-gap <ms>`). If no gap.json arrives in time, render with placeholder (D-06 — brief MUST render successfully without gap-fill). **The feed entry the CLI posts (with `metadata.handoffPrompt: true`) is dashboard-visible only — NOT visible to the agent's prompt context (per L5).** The agent learns about the gap-fill request via (a) a system-prompt instruction added to the destination session's first turn, (b) proactive call by the agent on detecting context exhaustion, or (c) explicit user instruction in chat. The feed entry is a side channel for the dashboard, not a back-channel to the running agent.
    - Validation runs AFTER assembly. STRICT mode (`--to`): hard error WITHOUT `--force` ⇒ exit non-zero, print errors. PERMISSIVE mode (`--save`): only secret-pattern can fail; other validation conditions are warnings. Secret-pattern error: ALWAYS exit non-zero, no `--force` override, print which section + which pattern matched (do NOT print the matched substring — defense in depth).
    - `--json` mode emits exactly one line of JSON to stdout per RESEARCH §Q16:
      ```
      {"ok":true,"channelId":"...","briefId":"...","briefPath":"...","fromSessionId":"...","toSessionId":"...","toProvider":"...","tokenEstimate":3412}
      ```
      On failure: `{"ok":false,"errors":[...],"warnings":[...]}`.
    - Help text added to `printTopLevelHelp()` in `src/index.ts`.
  </behavior>
  <action>
    Per D-03, D-06, D-08, D-09, M2, M6, M7, L4, L5, L7, RESEARCH §Q13-Q17. Read the current `src/index.ts` argv-dispatch section first to match the precedent for top-level `rly` commands (e.g. `chat`, `running`, `pending-approvals`).

    **Wave 4 split decision (L3):** When this task is implemented, measure the diff-stat after Step 1+2 land in the working branch:
    - If combined diff ≤ 800 LOC: ship Wave 4 as one PR.
    - If combined diff > 800 LOC: split into Wave 4a (`src/cli/handoff.ts` — CLI handler, argv parsing, mode dispatch, validation wiring; ~500 LOC) and Wave 4b (`src/cli/handoff.ts` spawn helpers + `src/index.ts` switch wiring + `buildCodexChatArgv` extraction; ~300 LOC). Wave 4a's tests cover argv-parse + validate-and-write paths with a stub spawner; Wave 4b's tests cover the spawn argv assembly + index.ts dispatch.

    **Step 1 — `src/cli/handoff.ts`:**
    Implement `handleHandoffCommand({ argv, stdout, stderr, env, channelStore?, approvalsQueue?, providerProfileStore?, spawner? })`. The function is dependency-injected per testability: `channelStore`, `approvalsQueue`, `providerProfileStore`, `spawner` all default to live constructors but are overridable in tests.

    Argv parsing is hand-rolled per `src/index.ts` precedent (no new arg-parser dep). Recognize: positional `<channelId>` (required), `--to <value>`, `--save` (boolean), `--resume <briefId|latest>`, `--max-tokens <n>`, `--force`, `--wait-gap <ms>` (default 30000), `--json`. Mutually exclusive: `--save` and `--to`. Required combinations: at least one of `--to | --save`; `--resume` requires either `--to` or `--save`.

    Mode dispatch:
    1. **--save**: `buildBrief` ⇒ `validateBrief(brief, { mode: "permissive" })` (M2 — secret-pattern only) ⇒ `writeBriefArtifact` ⇒ post feed entry (type `status_update`, `metadata.handoff: true, briefId, mode: "save"`) ⇒ print path/token estimate (or JSON envelope). Before `buildBrief`, if a live agent + `--wait-gap` > 0, post a feed entry asking for `channel_handoff_finalize` (`type: "status_update"`, `metadata.handoffPrompt: true`) and poll `readLatestGapFill(channelId, { maxAgeMs: waitGap, now })` every 500ms until found or timeout. **Document inline (L5):** "This feed entry is dashboard-visible only; the running agent does NOT receive it. We rely on (a) system-prompt instructions in destination session, (b) the agent's own context-exhaustion detection, or (c) the user telling the agent to call `channel_handoff_finalize`."
    2. **--to**: as above (with STRICT validation per M2), then resolve destination, then spawn new session, then update feed entry metadata with `toSessionId`. Same `--wait-gap` behavior as `--save`.
    3. **--resume <briefId>**: per M7 — read ONLY `<briefId>.gap.json` from disk via `readGapFillByBriefId(channelId, briefId)`. The `<briefId>.md` is NOT read; the deterministic skeleton is regenerated from current channel state. Pass the loaded gap-fill into `buildBrief({ ..., gapFill, resumedFrom: { briefId: <originalBriefId>, originalGeneratedAt: <from gap.capturedAt> } })`. Validate (STRICT or PERMISSIVE based on whether `--to` is set) ⇒ write NEW brief ⇒ continue per --to or --save.
    4. **--resume latest**: resolve to newest brief in `handoffs/`, then continue per #3.

    Destination resolution (`resolveDestination(value, channel, providerProfileStore)`) implements the four-step layered fallback. The error message for "unknown --to value" is the verbatim string from RESEARCH §Q15.

    Spawning helper `spawnDestinationSession(adapter, profile, briefMarkdown, channel, cwd)`:
    - Claude: build system prompt via `buildSystemPrompt`; call `launchInteractiveCommand("claude", ["-p", "--output-format", "stream-json", "--verbose", "--append-system-prompt", systemPrompt, briefMarkdown], { cwd, env: <inherit-via-passEnv> })`; parse the streaming session id from stream-json; create `ChatSession` via `SessionStore.createSession`, persist `claudeSessionIds[alias] = capturedSid`.
    - Codex (per M6 — extract `buildCodexChatArgv` helper):
      ```ts
      export function buildCodexChatArgv(
        profile: ProviderProfile | null,
        channel: Channel,
        briefMarkdown: string,
        cwd: string,
      ): string[] {
        const sandbox = channel.fullAccess ? "workspace-write" : "read-only";
        const args = ["exec", "-C", cwd, "--skip-git-repo-check", "--sandbox", sandbox];
        if (profile?.defaultModel) {
          args.push("--model", profile.defaultModel);
        }
        // M6: deliberately omits orchestrator-pipeline flags (--output-schema, -o,
        // --ask-for-approval). Chat-seed path has no JSON contract back to the
        // orchestrator — the new session is interactive, not a one-shot.
        args.push(briefMarkdown);
        return args;
      }
      ```
      Then call `NodeCommandInvoker.spawn("codex", buildCodexChatArgv(profile, channel, briefMarkdown, cwd), { passEnv: ["OPENAI_API_KEY"] })`; capture stdout; create `ChatSession`, persist no claude sids (Codex has no resume).
    - Both: append a `user` message to the new session via `SessionStore.appendMessage` (the brief markdown) so the chat history shows the seed.
    - Both: return `{ newSessionId, output, providerName }`.

    **L7 doc comment** above `spawnDestinationSession`: `// Independent of gui/src-tauri/src/lib.rs:start_chat (Tauri-side spawn idiom AS OF Phase 2 execution). Any later refactor of start_chat does not affect this code path; the two converge only at the `claude -p` / `codex exec` argv level.`

    Feed entry on completion (RESEARCH §Q16 example):
    ```ts
    await channelStore.postEntry(channelId, {
      type: "status_update",
      fromAgentId: null,
      fromDisplayName: "system",
      content: `Handoff: ${channelId} → ${dest.label} (brief ${briefId}, session ${newSessionId}).`,
      metadata: {
        handoff: true,
        briefId,
        fromProvider: srcAdapter ?? "unknown",
        toProvider: dest.adapter,
        toProfileId: dest.profileId ?? null,
        fromSessionId: srcSessionId ?? null,
        toSessionId: newSessionId,
        mode: argv.save ? "save" : (argv.resume ? "resume" : "to"),
      },
    });
    ```

    Optionally also call `channelStore.recordDecision(...)` with `title: "Session handed off to <dest>"`, `rationale: "User invoked rly handoff"`, `alternatives: []` so the audit trail is durable (per RESEARCH §Q16 last sentence). Mark this as best-effort — failure to record the decision should NOT fail the handoff (covered by L4 test).

    **Step 2 — `src/index.ts` dispatch:**
    Find the existing argv-switch (look for `case "channel":` / `case "chat":`). Add `case "handoff":` ⇒ `await handleHandoffCommand({ argv: rest, stdout: process.stdout, stderr: process.stderr, env: process.env })`. Update `printTopLevelHelp()` to list:
    ```
    handoff <channelId> [--to <profile|adapter|alias>] [--save] [--resume <briefId|latest>] [--max-tokens <n>] [--force] [--wait-gap <ms>] [--json]
        Generate a handoff brief from channel artifacts and (optionally) seed a new session in the destination provider.
        See docs/cli/rly-handoff.md.
    ```

    **Step 3 — Wave 0 `handoff-cli.test.ts` and `handoff-resume.test.ts` turn green:**
    - `handoff-cli.test.ts` exercises `handleHandoffCommand` against the fixture channel with a stub `spawner` that records its calls. Assertions:
      - `--to claude` happy path ⇒ brief artifacts exist; spawner called with `"claude"` adapter and `briefMarkdown` as the first-turn arg; feed entry posted with `metadata.handoff === true && metadata.toProvider === "claude"`; stdout includes the brief path; exit code 0.
      - `--to codex` ⇒ spawner called with `"codex"` adapter; argv assembled by `buildCodexChatArgv` does NOT include `--output-schema`, `-o`, or `--ask-for-approval` (M6 assertion); stdout contains expected token-estimate.
      - `--to <unknown>` ⇒ exit non-zero; error message includes "Pass a provider profile id".
      - secret-pattern in fixture decision ⇒ exit non-zero with secret-error; `--force` does NOT bypass (in BOTH STRICT and PERMISSIVE — M2).
      - `--json` ⇒ stdout is a single JSON line with `ok:true`.
      - `--wait-gap 100` with no gap-fill arriving ⇒ brief renders with placeholder workingMemory section (D-06 fallback).
      - **L4 case (recordDecision best-effort):**
        ```ts
        it("recordDecision throws → handoff still succeeds", async () => {
          const failingChannelStore = wrapStoreWithFailingRecordDecision(realChannelStore);
          const result = await handleHandoffCommand({
            argv: ["ch-fixmin-0001", "--to", "claude"],
            stdout: stdoutBuf, stderr: stderrBuf, env: testEnv,
            channelStore: failingChannelStore, providerProfileStore, spawner: stubSpawner,
          });
          expect(result.exitCode).toBe(0);
          expect(stderrBuf.toString()).toMatch(/recordDecision failed.*continuing/i);
          expect(stubSpawner.calls).toHaveLength(1); // brief still dispatched
        });
        ```
    - `handoff-resume.test.ts`:
      - `--save` ⇒ artifacts exist; spawner NOT called; feed entry has `metadata.mode === "save"`; PERMISSIVE validation accepts a too-long brief without `--force` (M2).
      - `--resume <briefId> --to claude` with a pre-placed gap.json ⇒ new briefId different from the resume target; same `gapFill.currentLineOfAttack`; spawner called; **the original `<briefId>.md` was NOT read** (use a `readSpy` on `fs.promises.readFile` to assert; M7); the new brief includes `**Resumed from:** <originalBriefId>` in the rendered markdown.
      - `--resume latest --to claude` ⇒ resolves to the newest brief in handoffs/.

    **Step 4 — Brief size and path-traversal sanity:**
    Add a small assertion in `handleHandoffCommand` that `assertSafeSegment(channelId)` runs at entry — defense in depth even though `ChannelStore` already guards.

    **Step 5 — All previous waves' tests stay green.**
  </action>
  <verify>
    <automated>pnpm typecheck && pnpm test test/orchestrator/handoff/ test/mcp/channel-handoff-finalize.test.ts 2>&1 | tee /tmp/wave4-tests.log; grep -E "Tests +[0-9]+ passed" /tmp/wave4-tests.log; pnpm build 2>&1 | tail -10</automated>
  </verify>
  <done>
    `rly handoff <channelId> --to <value>` works end-to-end with a stub spawner under scripted-mode tests. All three modes (`--to`, `--save`, `--resume`) pass their dedicated test file. STRICT/PERMISSIVE validation modes (M2) work as specified. `buildCodexChatArgv` helper exists, drops orchestrator-pipeline flags (M6), and is unit-testable. `--resume` reads ONLY `gap.json` (M7); the new brief carries `resumedFrom` provenance. recordDecision failure does not fail the handoff (L4 test green). Provider-resolution layered fallback (D-03) errors loudly on no-match. Spawn paths use `NodeCommandInvoker` for env sanitization. Feed entry + (best-effort) Decision record are posted. Wave 0/1/2/3 tests stay green. `pnpm build` succeeds. PR LOC < 800 (Wave 4a + 4b combined estimate: ~750 LOC; if a single PR exceeds, split per L3).
  </done>
</task>

<!-- ============================================================ -->
<!-- WAVE 5 — Docs + integration tests + cross-dashboard ApprovalKind audit (single PR) -->
<!-- ============================================================ -->

<task type="auto">
  <name>Task 5.1 (Wave 5): Design doc, CLI reference doc, README updates, ApprovalKind cross-dashboard audit (M10), live-network integration tests in describe.skip</name>
  <requirements>REQ-2.10, REQ-2.9, REQ-2.4</requirements>
  <files>
    docs/design/handoff-brief.md,
    docs/cli/rly-handoff.md,
    README.md,
    test/orchestrator/handoff/handoff-integration.test.ts
    <!-- Plus any TUI/GUI/Rust files identified in Step 0 audit -->
  </files>
  <action>
    Per REQ-2.10, M10, and AGENTS.md "Design-doc convention" (`docs/design/<feature>.md` with the prescribed section order).

    **Step 0 — `ApprovalKind` cross-dashboard audit (M10) — RUN FIRST:**
    Before writing docs, audit the cross-dashboard surfaces for `ApprovalKind` / `ApprovalRecord` switches that the new `"handoff-prompt"` arm widens:
    ```bash
    rg -n "ApprovalKind|ApprovalRecord|approval.*kind|merge-pr|create-ticket" tui/ gui/src/ gui/src-tauri/ crates/harness-data/src/
    ```
    For each match site, decide:
    - **Widen + render:** if it's a renderer (TUI table, GUI list-item, Rust kind-switch on a dashboard struct), add a `"handoff-prompt"` arm with a placeholder rendering `"Handoff prompt — context at <pct>%"` (or equivalent).
    - **Document fall-through:** if it's a kind-agnostic surface (e.g. `rly approve` / `rly reject` already work on any kind), add a code comment that the new kind is intentionally not enumerated and falls through.

    Specifically check:
    - `crates/harness-data/src/lib.rs` — search for `ApprovalKind` / `ApprovalRecord` mirror types. If the Rust crate enumerates kinds (likely for typed-JSON dashboards), widen the enum and add a TUI/GUI render branch.
    - `gui/src/` — search for `kind === "merge-pr"` style switches in React components (likely under a `pending-approvals` or similar route).
    - `gui/src-tauri/src/lib.rs` — search for `ApprovalRecord` use; the Tauri command surface usually mirrors the TS shape.
    - `tui/` — search for any renderer that switches on `kind`.

    Add `tui/`, `gui/src/`, `gui/src-tauri/src/lib.rs`, `crates/harness-data/src/lib.rs` to the `files_modified` frontmatter list (already done in this revision) — files MAY change if widening is needed.

    **Add a `rly pending-approvals --json` test** (in `test/orchestrator/handoff/handoff-integration.test.ts` or a new `test/cli/pending-approvals-handoff.test.ts`) that:
    - Enqueues a `handoff-prompt` approval via `ApprovalsQueue.enqueue`.
    - Invokes the existing `pending-approvals` CLI handler with `--json`.
    - Asserts the output JSON includes the handoff-prompt record AND the rendering does not throw / mark it as `unknown`.

    **Step 1 — `docs/design/handoff-brief.md`:**
    Sections in order per AGENTS.md:
    - Status header (Status: Shipped / Owner: <author> / Target version: per release / Related code paths: list of `src/orchestrator/handoff/*`, `src/cli/handoff.ts`, `src/mcp/channel-tools.ts`, `src/approvals/queue.ts`, `src/domain/handoff.ts`).
    - `## Problem` — copy/condense from RESEARCH §Summary.
    - `## Goals` — REQ-2.1 through REQ-2.10 paraphrased.
    - `## Non-goals` — D-02 (no first-class file tracking), no LLM polish, no auto-trigger, no multi-channel handoff, no auto-archive of briefs.
    - `## Mental model` — the synthesizer is a join, not an analysis (RESEARCH §Don't Hand-Roll key insight).
    - `## Architectural decisions` — list D-01 through D-09 verbatim with rationale.
    - `## Implementation plan` — point to this PLAN.md.
    - `## Determinism caveats (M3)` — explicit subsection: "`buildBrief` is **pure-over-declared-inputs**, not strictly pure. The v1 files-touched enrichment shells out via `git log --name-only` (per `src/orchestrator/handoff/files-touched.ts`). On real repos, two back-to-back `buildBrief` calls separated by a `git pull` or any new commit can produce different file lists. This is acceptable for v1; tests opt out via `gitLogEnabled: false`. Future v2 may switch to a first-class file-tracking source (per D-02 follow-up)."
    - `## Specs` — Given/When/Then scenarios, one bullet per requirement:
      - "Given a channel with feed/decisions/tickets, When the user runs `rly handoff <channelId> --to claude`, Then a brief markdown is generated under `~/.relay/channels/<channelId>/handoffs/<briefId>.md` with `**Schema version:** 1`."
      - "Given a brief over 8K tokens, When STRICT validation runs (used by `--to`), Then the CLI exits non-zero unless `--force` is passed."
      - "Given a brief over 8K tokens, When PERMISSIVE validation runs (used by `--save`), Then the CLI succeeds and emits a soft-cap warning."
      - "Given the brief contains a string matching `AKIA[A-Z0-9]+`, When validation runs (STRICT or PERMISSIVE), Then the CLI ALWAYS exits non-zero (no `--force` override)."
      - "Given Phase 1 emits a `context_threshold` feed entry with `threshold === \"90\"` for `sessionId == \"sess-x\"`, When the threshold listener observes it, Then exactly one `ApprovalsQueue` record of `kind: \"handoff-prompt\"` with `payload.thresholdPct === 90` (number) is enqueued."
      - "Given the listener has already enqueued for (`sess-x`, 90), When another `threshold === \"90\"` entry for the same session lands, Then no new approval is enqueued."
      - "Given two distinct sessions sess-A and sess-B both crossing 90%, When both have listeners attached, Then BOTH receive an independent approval (no cross-session dedup)."
      - "Given the user runs `rly handoff <channelId> --save`, When the command completes, Then the brief is on disk AND no destination session is dispatched."
      - "Given a saved brief at `<briefId>`, When the user runs `rly handoff <channelId> --resume <briefId> --to claude`, Then ONLY the `<briefId>.gap.json` is read, the deterministic skeleton is regenerated from current channel state, the saved gap.json is preserved, the new brief carries `resumedFrom`, and a new session is dispatched."
      - "Given the departing agent calls `channel_handoff_finalize`, When the call succeeds, Then `~/.relay/channels/<id>/handoffs/<briefId>.gap.json` exists with `schemaVersion: 1` and the four working-memory slots."
      - "Given a `gap.json` on disk with `schemaVersion: 2`, When `readLatestGapFill` runs, Then it returns `null` (fail closed; no silent coercion)."
      - "Given the departing agent never calls `channel_handoff_finalize`, When `rly handoff` runs after `--wait-gap` timeout, Then the brief still renders with `[gap-fill not provided]` placeholder."
    - `## Open questions` — A3 (per-section budgets — measure on real channels post-launch), A4 (files-touched — git log v1, revisit if thin), GUI surface for handoff approvals (RESEARCH Open question 2), brief auto-archive (RESEARCH Open question 3).
    - `## Sign-off` — empty placeholder for the user.

    **Step 2 — `docs/cli/rly-handoff.md`:**
    User-facing CLI reference. Sections:
    - Synopsis (full argv grammar).
    - Description (one paragraph: what it does, when to use it).
    - Modes: `--to <value>` (default-style, STRICT validation), `--save` (PERMISSIVE validation), `--resume <briefId|latest>`.
    - Flags: `--max-tokens`, `--force` (with the secret-pattern caveat), `--wait-gap`, `--json`.
    - `--to` resolution order (the four-step fallback).
    - Examples:
      - Hand off a Claude session to Codex: `rly handoff ch-abc123 --to codex`.
      - Save without dispatching: `rly handoff ch-abc123 --save`.
      - Resume after a week: `rly handoff ch-abc123 --resume latest --to claude`.
      - Force a too-long brief: `rly handoff ch-abc123 --to claude --force`.
    - Output: human + `--json` envelopes.
    - File layout: `~/.relay/channels/<channelId>/handoffs/<briefId>.{md,gap.json}`.
    - Validation modes: STRICT (`--to`) checks all three (token cap + missing sections + secrets); PERMISSIVE (`--save`) checks ONLY secrets — rationale: archival mode defers cap enforcement to resume time.
    - Related: link to `docs/design/handoff-brief.md` and the Phase 1 contract doc (`docs/design/context-threshold-events.md`).

    **Step 3 — README.md updates** (cross-dashboard contract per AGENTS.md):
    - `~/.relay/` file-layout tree: add `handoffs/` directory under `channels/<id>/`.
    - MCP tools list: confirm `channel_handoff_finalize` is listed (added in Wave 2).
    - CLI reference list: add `rly handoff` with one-line description.
    - **Approvals section (M10):** if widening was needed in Step 0, document the new `handoff-prompt` kind in any approvals reference.

    **Step 4 — `test/orchestrator/handoff/handoff-integration.test.ts`:**
    Live-network integration tests inside `describe.skip("[live] handoff integration", ...)`. Cases:
    - End-to-end: with `HARNESS_LIVE=1` and a real `claude` binary, run `rly handoff <real-channel> --to claude` and assert the new session can answer a probe question about the brief's status snapshot ("what tickets are blocked?"). RESEARCH §Q19 — proves first-response context retention.
    - End-to-end: with `HARNESS_LIVE=1` and a real `codex` binary, equivalent.
    - These are NOT enabled in CI per AGENTS.md — `describe.skip` is the convention. They run on-demand.
    Add a comment block at the top of the file referencing AGENTS.md "Testing conventions" and the integration CI workflow path (`.github/workflows/integration.yml`).

    **Step 5 — Final gate:**
    Run the full validation:
    ```
    pnpm test && pnpm typecheck && pnpm build
    ```
    Then check Rust:
    ```
    cargo check --workspace
    ```
    **If Step 0 widened any Rust enum or GUI/TUI switch, expect Rust changes** — verify they compile cleanly. If `cargo check` fails it indicates either an audit miss or an unrelated drive-by edit — investigate before merging.

    **Step 6 — Commit hygiene:**
    Per AGENTS.md, this final PR carries the docs and integration tests AND the M10 cross-dashboard widening. PR description references RESEARCH.md, PLAN.md, and the M10 audit results. Sub-800 LOC (estimate: ~500 LOC of docs + integration tests + dashboard widening; if widening is heavier than expected, split the dashboard work into Wave 5b).
  </action>
  <verify>
    <automated>pnpm test && pnpm typecheck && pnpm build && cargo check --workspace 2>&1 | tail -30</automated>
  </verify>
  <done>
    `docs/design/handoff-brief.md` exists with all required sections per AGENTS.md design-doc convention; `## Specs` enumerates Given/When/Then scenarios for every REQ-2.x AND for the M2/M3/M7/M9/H2b additions; `## Determinism caveats` documents the M3 reframe. `docs/cli/rly-handoff.md` is a complete user-facing reference including the STRICT/PERMISSIVE distinction. README updated for `~/.relay/` layout + MCP tools + CLI list. **M10 cross-dashboard audit complete:** `ApprovalKind` widening either renders correctly on TUI / GUI / Rust crate surfaces OR fall-through is documented; `rly pending-approvals --json` test asserts handoff-prompt approvals render correctly. Integration tests exist in `describe.skip` blocks. Full validation gate green: `pnpm test && pnpm typecheck && pnpm build && cargo check --workspace`. PR LOC < 800 (split into 5a docs + 5b dashboard widening if combined > 800).
  </done>
</task>

<!-- ============================================================ -->
<!-- End-of-phase TDD review checkpoint -->
<!-- ============================================================ -->

<task type="checkpoint:human-verify" gate="blocking">
  <what-built>
    All five PRs (Wave 0+1 combined → Wave 5) merged. The phase delivers:
    - `rly handoff <channelId> --to <value>` CLI command with three modes (--to / --save / --resume).
    - **Pure-over-declared-inputs** deterministic brief synthesizer at `src/orchestrator/handoff/` (M3 reframe).
    - `channel_handoff_finalize` MCP tool for the departing-agent gap-fill, with `schemaVersion !== 1` rejected at runtime (M9).
    - 90% nudge wired through the `ApprovalsQueue` (new `ApprovalKind = "handoff-prompt"`); cross-dashboard audited (M10).
    - Brief artifacts persisted at `~/.relay/channels/<id>/handoffs/<briefId>.{md,gap.json}` with `schemaVersion: 1`.
    - Two validation modes (M2): STRICT for `--to`, PERMISSIVE for `--save`.
    - `--resume` reads ONLY the saved gap.json (M7); brief carries `resumedFrom` provenance.
    - Full vitest coverage in scripted mode; live-network tests in `describe.skip`.
    - Design + CLI reference docs.
  </what-built>
  <how-to-verify>
    1. Run `pnpm test && pnpm typecheck && pnpm build && cargo check --workspace` — all green.
    2. Run `rly inspect-mcp` (or grep `channel-tools.ts` definitions) and confirm `channel_handoff_finalize` is registered.
    3. Run `rly --help` and confirm `handoff` is listed.
    4. Manually exercise the happy path against a real channel (or a fixture channel restored to `~/.relay/`):
       ```
       rly handoff <some-channel-id> --save
       ```
       Confirm a brief markdown lands at `~/.relay/channels/<id>/handoffs/brief-*.md` with `**Schema version:** 1` in the header AND a sibling `.gap.json`. Confirm the Files-touched section shows the M4 footnote.
    5. Inspect the brief — does it include all six sections (Status snapshot / Mission / Ticket DAG / Recent decisions / Files touched / Working memory)?
    6. With `HARNESS_LIVE=1` set and Claude installed, manually run `rly handoff <real-channel> --to claude` against a real channel that's been doing actual work. Confirm the new Claude session opens AND its first response demonstrates context retention (knows current line of attack, doesn't re-litigate decisions).
    7. With Codex installed, repeat with `--to codex`. Confirm `--output-schema` / `-o` are NOT in the spawned argv (M6).
    8. Confirm declining a 90% prompt (`rly reject <approval-id>`) is benign — the running session continues normally.
    9. Confirm the brief artifact at `~/.relay/channels/<id>/handoffs/<briefId>.md` is human-readable Markdown.
    10. Run `rly pending-approvals --json` after triggering a 90% threshold; confirm a handoff-prompt record renders correctly (M10).
    11. Manually write a `gap.json` with `schemaVersion: 2` to a handoffs/ directory; run `rly handoff --to claude` and confirm the brief renders with the placeholder (M9 fail-closed behavior).
  </how-to-verify>
  <resume-signal>Type "approved" or describe issues</resume-signal>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| User CLI → orchestrator | `rly handoff` argv parsed by `handleHandoffCommand`. Untrusted: `<channelId>`, `--to <value>`, `--resume <briefId>`. Validated via `assertSafeSegment` and regex (`assertValidBriefId`). |
| Departing agent → MCP server | The agent calls `channel_handoff_finalize` with four free-text slots. Slots are agent-authored content seeded into a future destination session — treated as untrusted (could be used for prompt injection of the next agent). Zod schema enforces length caps AND rejects `schemaVersion !== 1` (M9). |
| Channel feed (Phase 1 emitter) → threshold listener | The listener trusts only the metadata-key/value contract from Phase 1's `<phase_2_handoff_contract>`. Other feed entries pass through unfiltered. STRING→NUMBER conversion happens once at the listener boundary (M1). |
| Synthesizer reads → destination session prompt | Brief markdown is concatenated into the new session's first turn. Channel feed/decision content is Relay-authored (trusted) but agent-authored gap-fill is untrusted (mitigation: V5 secret-pattern check; the new session inherits the channel's `fullAccess` flag — restricted channels stay permission-prompted regardless). |
| Subprocess spawning | Claude / Codex CLI spawning routes through `NodeCommandInvoker` for env sanitization. Brief is passed as an argv positional, not a stdin pipe — keeps argv length bounded by validation. Codex chat-seed uses `buildCodexChatArgv` helper which deliberately omits orchestrator-pipeline flags (M6). |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-02-01 | Tampering | `<briefId>` as filesystem path segment | mitigate | `assertSafeSegment(briefId)` + regex `/^brief-[0-9]+-[a-z0-9]+$/` (`assertValidBriefId`) before any disk write. (RESEARCH §Security row 1.) |
| T-02-02 | Tampering | `<channelId>` from CLI argv | mitigate | Pre-existing `assertSafeSegment(channelId)` from `src/storage/file-store.ts` runs at handoff entry AND inside `ChannelStore`. Defense in depth. |
| T-02-03 | Tampering / Injection | Agent-authored gap-fill (working-memory slots) leaked into destination session prompt — could carry "ignore previous instructions" patterns | accept (with mitigation) | Gap-fill is markdown the destination agent reads. The destination session inherits the channel's `fullAccess` flag — restricted channels keep permission-prompted mode regardless of brief content. Content-scanning the gap-fill is out of scope (no worse than any user message today). RESEARCH §Security row 2. |
| T-02-04 | Information disclosure | Secret leaks (AWS key / API key / PEM) in channel decisions or feed entries land in the brief | mitigate | `validateBrief` runs four secret-pattern regexes (AWS access-key, OpenAI-style, generic key=value, PEM) in BOTH STRICT and PERMISSIVE modes (M2). Hard error — no `--force` override (D-09). Pattern names are reported but matched substrings are NEVER printed (defense in depth). |
| T-02-05 | Information disclosure | Stale gap.json from a prior handoff leaks into new context | mitigate | `<briefId>.gap.json` carries `capturedAt` timestamp; `readLatestGapFill` ignores entries older than `maxAgeMs` (default 1 hour). Also rejects `schemaVersion !== 1` (M9 — fail closed). RESEARCH Pitfall 3. |
| T-02-06 | Information disclosure | Subprocess (Claude/Codex) inherits parent env including `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc., and leaks via tool calls | mitigate | All spawning routes through `NodeCommandInvoker` (`src/agents/command-invoker.ts`) which strips matching `SECRET_NAME_PATTERN` env vars by default. `passEnv` is explicit per-name (Codex: `OPENAI_API_KEY` only; Claude: `ANTHROPIC_API_KEY` only). RESEARCH §Security row 4. |
| T-02-07 | Repudiation | Two concurrent `rly handoff` invocations on the same channel — which one ran first? | accept | Each handoff has its own `briefId`; both post feed entries (visible in dashboards). Atomic tmp-rename writes prevent file collisions. RESEARCH Pitfall 5. Cross-process mutex deferred until Postgres backend ships. |
| T-02-08 | Denial of service | Channel with 6+ months of activity produces a 50K-token brief that fails to seed | mitigate | `validateBrief` hard-caps at 8K tokens (default, STRICT mode); `--max-tokens` overrides; per-section caps (D-04) truncate newest-first; warnings on truncation. PERMISSIVE mode (`--save`) emits a warning instead of hard-failing. RESEARCH Pitfall 4. |
| T-02-09 | Denial of service | Threshold listener fires on every poll (1Hz) for a busy channel | mitigate | **Polling default raised to 5s per M8** (was 1s); reads only last 50 feed entries (constant work); `Set<entryId>` + `seenThresholds` dedup keeps work O(new entries since last poll); listener uses `unref()` to avoid holding the process open. |
| T-02-10 | Elevation of privilege | Path traversal via crafted `--resume <briefId>` argument | mitigate | `assertValidBriefId(briefId)` regex match before any filesystem read. `assertSafeSegment` runs on the resolved path. |
| T-02-11 | Spoofing | Threshold listener mis-attributes a `context_threshold` event from session A to session B | mitigate | Listener filters by `metadata.sessionId === sessionId` AND dedupes by `(sessionId, threshold)` per Phase 1 D-03 contract. The contract block in `<phase_2_handoff_contract>` mandates that subscribers treat each (sessionId, threshold) pair independently. **Defense-in-depth test (H2b)** asserts two distinct sessionIds enqueue independent approvals. |
| T-02-12 | Tampering | Phase 1 `metadata.schemaVersion` bumps breaking the listener silently | mitigate | The listener filters on `metadata.schemaVersion === "1"` AS WELL AS the other predicates. A schema-version drift fails closed (no enqueue). Phase 1's `<phase_2_handoff_contract>` mandates coordinated bumps. |
| T-02-13 | Tampering | A future `gap.json` schemaVersion bump silently coerces to v1 on read, corrupting the brief | mitigate | **Per M9:** `readLatestGapFill` AND the MCP tool's Zod schema both reject `schemaVersion !== 1` explicitly. Round-trip test in persistence.test.ts proves the gate. |

</threat_model>

<verification>
## Phase-level checks

1. **All requirements covered:** Requirements coverage matrix below (with REQ-2.x ↔ HOFF-XX mapping per L1).
2. **All tests green in scripted mode:** `pnpm test` exits 0; no test inadvertently sets `HARNESS_LIVE=1`.
3. **Typecheck + build clean:** `pnpm typecheck && pnpm build` exit 0.
4. **No Rust drift (unless M10 widening required it):** `cargo check --workspace` exits 0. If M10 audit added `handoff-prompt` to a Rust enum in `crates/harness-data/`, expect those changes; otherwise no Rust changes.
5. **Phase 1 contract intact (H1 — tightened to Phase-2-authored paths only):** Phase 2-authored source has zero imports from `src/budget/`. Verify with:
   ```bash
   grep -rE "from ['\"][^'\"]*\\.\\./budget" \
     src/orchestrator/handoff/ \
     src/cli/handoff.ts \
     src/mcp/channel-tools.ts \
     -- 2>/dev/null
   # Also check the diffs (NOT the whole file) added to:
   #   src/orchestrator/dispatch.ts
   #   src/cli/run-autonomous.ts
   # via: git diff main -- src/orchestrator/dispatch.ts src/cli/run-autonomous.ts | grep -E "^\\+.*from.*budget"
   ```
   Should return nothing. **Excluded from this grep (per H1):** `src/approvals/queue.ts` (pre-existing file; widening it does not introduce a budget import). Including it added noise in the original plan.
6. **MCP-tools list authoritative:** `rly inspect-mcp` (or read of `getChannelToolDefinitions`) shows `channel_handoff_finalize`.
7. **README cross-checks:** README's `~/.relay/` tree shows `handoffs/`; CLI list shows `rly handoff`; MCP tools list shows `channel_handoff_finalize`.
8. **Sub-800-LOC PR discipline:** Each of Wave 0+1 (combined per L2), Wave 2, Wave 3, Wave 4 (or 4a/4b per L3), Wave 5 (or 5a/5b if M10 widening is heavy) lands as one PR with diff-stats under 800 LOC.
9. **Cross-dashboard audit (M10):** `ApprovalKind` widening either renders correctly OR fall-through is documented in code comments on each surface. `rly pending-approvals --json` test asserts handoff-prompt records render.

## Requirements coverage matrix (with L1 HOFF mapping)

| Requirement | HOFF origin (RESEARCH.md) | Covered by tasks |
|-------------|---------------------------|------------------|
| REQ-2.1 (`rly handoff` CLI with layered fallback) | HOFF-01 | Task 4.1 |
| REQ-2.2 (Pure synthesizer at `src/orchestrator/handoff/`) | HOFF-02 | Task 0.1, Task 1.1 |
| REQ-2.3 (`channel_handoff_finalize` MCP tool) | HOFF-03 | Task 2.1 |
| REQ-2.4 (90% nudge via ApprovalsQueue) | HOFF-04 | Task 3.1, Task 5.1 (M10 audit) |
| REQ-2.5 (New-session seed for Claude + Codex) | HOFF-05 | Task 4.1 |
| REQ-2.6 (Brief artifacts at `~/.relay/.../handoffs/`, `schemaVersion: 1`) | HOFF-06 | Task 0.1, Task 2.1, Task 4.1 |
| REQ-2.7 (Brief validation incl. secrets) | net-new from CONTEXT (D-09) | Task 0.1, Task 1.1, Task 4.1 |
| REQ-2.8 (`--save` mode, `--resume` mode) | net-new from CONTEXT (D-08) | Task 4.1 |
| REQ-2.9 (Vitest scripted-mode coverage; live in describe.skip) | net-new from CONTEXT | Task 0.1, Task 1.1, Task 2.1, Task 3.1, Task 4.1, Task 5.1 |
| REQ-2.10 (Documentation — design + CLI reference) | net-new from CONTEXT (AGENTS.md design-doc convention) | Task 5.1 |

L1 note: REQ-2.1 through REQ-2.6 trace 1:1 to HOFF-01 through HOFF-06 in `02-RESEARCH.md`. REQ-2.7 through REQ-2.10 are net-new requirements derived from the locked decisions (D-07 through D-09) and AGENTS.md doc convention; they have no HOFF predecessor.

## Source coverage audit

**GOAL** (ROADMAP.md Phase 2 Goal): "produce structured brief from `~/.relay/` artifacts, lets the departing agent fill in working-memory gaps, and seeds a fresh session in the new provider with the brief — instead of replaying the raw transcript." → COVERED by REQ-2.1 (CLI) + REQ-2.2 (synthesizer) + REQ-2.3 (gap-fill MCP tool) + REQ-2.5 (new-session seed) — all four delivered across Tasks 1.1, 2.1, 4.1.

**REQ** (REQ-2.1 through REQ-2.10): Mapped above. All ten REQ-IDs appear in at least one task's `requirements` field.

**RESEARCH** (02-RESEARCH.md):
- Brief shape (Q1) → Task 1.1 (renderBrief).
- Token budgets (Q2) → Task 0.1 (BRIEF_TOKEN_BUDGETS) + Task 1.1 (truncation) + Task 4.1 (validate).
- Decision shape (Q3) → Task 1.1 (recentDecisions section).
- Ticket DAG (Q4) → Task 1.1 (ticketDag section).
- Read API (Q5) → Task 1.1 (uses ChannelStore directly).
- Files touched (Q6) → Task 1.1 (`files-touched.ts` git log v1, per D-02 + M3 + M4).
- Synthesizer location (Q7) → Task 0.1 + Task 1.1.
- "Wrap up" mechanism (Q8-Q9) → Task 2.1 (MCP tool — voluntary call inside live turn).
- Gap-fill storage (Q10) → Task 2.1 (`persistence.ts`).
- Threshold subscription (Q11) → Task 3.1 (feed-polling, NOT EventEmitter — D-01 anchors on feed contract; default 5s per M8; conversion at boundary per M1).
- Approval-queue surface (Q12) → Task 3.1 + Task 5.1 (M10 cross-dashboard audit).
- New-session seeding (Q13-Q14) → Task 4.1 (Codex chat-seed argv per M6).
- `--to` flag (Q15) → Task 4.1.
- CLI output (Q16) → Task 4.1.
- Resume workflow (Q17) → Task 4.1 (`--save` PERMISSIVE per M2 / `--resume` reads gap.json only per M7).
- Schema versioning (Q18) → Task 0.1 (`HANDOFF_BRIEF_SCHEMA_VERSION = 1`) + Task 2.1 (M9 round-trip + Zod gate).
- Risk mitigations (Q19) → Threat model section + Task 1.1 (truncation) + Task 4.1 (`--max-tokens`).
- Validate-brief (Q20) → Task 1.1 (STRICT/PERMISSIVE per M2).

**CONTEXT** (predecided D-01 through D-09): Mapped explicitly in `<locked_decisions_from_predecided_open_questions>`. Each D-XX cited in the relevant task's `<action>` block.

No source items are missing from the plan. No items are deferred without explicit Deferred Ideas marking.

## Goal-backward verification (re-emitted post-revision)

The Phase 2 ROADMAP acceptance criteria (lines 48-52 of `ROADMAP.md`) are checked against the revised plan output:

(a) **`rly handoff <channelId> --to claude` produces a brief from `~/.relay/` artifacts and seeds a new Claude session that demonstrates context retention on its first response.**
- COVERED by Task 4.1 (CLI handler with `--to` mode + Claude spawn idiom) + Task 1.1 (synthesizer + render). STRICT validation (M2) gates the seed. Demonstrated by `handoff-cli.test.ts` happy-path assertion in scripted mode AND by `handoff-integration.test.ts` live-network test (Wave 5, in `describe.skip`).

(b) **Codex destination works equivalently within Codex's idiom constraints.**
- COVERED by Task 4.1 (Codex chat-seed argv assembled by `buildCodexChatArgv` per M6 — drops orchestrator-pipeline flags `--output-schema`, `-o`, `--ask-for-approval`). Tested in `handoff-cli.test.ts` (`--to codex`) AND live in `handoff-integration.test.ts`.

(c) **The 90% nudge surfaces via the existing approval queue and routes to `rly handoff` on accept; declining is benign.**
- COVERED by Task 3.1 (threshold listener with H1-correct `approvalsQueue.list(sessionId)` API + ApprovalKind extension + M1 string→number conversion at boundary + M8 5s default poll). The listener enqueues; existing AL-7 surfaces (`rly approve` / `rly reject`) handle the user response. Decline path is documented as no-op terminal — the running session continues. Tested in `threshold-listener.test.ts` including H2b defense-in-depth (two sessions, independent approvals). Cross-dashboard surfaces audited in Task 5.1 (M10).

(d) **`rly handoff --save` writes a brief to disk without dispatching, ready for later resume.**
- COVERED by Task 4.1 (`--save` mode with PERMISSIVE validation per M2). `--resume <briefId|latest>` re-seeds, reading ONLY `gap.json` (per M7) and regenerating the deterministic skeleton from current channel state. The new brief carries `resumedFrom` provenance. Tested in `handoff-resume.test.ts`.

(e) **Phase 1's threshold-event contract is the only Phase 1 dependency — no other Phase 1 internals are touched.**
- ENFORCED by the threshold listener using ONLY `ChannelStore.readFeed` + the metadata predicates from `<phase_2_handoff_contract>`. Verified post-merge with the H1-tightened grep over Phase-2-authored paths only (verification step 5 above).

(f) **First versioned `~/.relay/` artifact convention is established and fail-closed.**
- COVERED by Task 0.1 (`HANDOFF_BRIEF_SCHEMA_VERSION = 1` constant) + Task 2.1 (Zod schema rejects `schemaVersion !== 1` at MCP input + `readLatestGapFill` rejects at disk-read; round-trip test in `persistence.test.ts` per M9). Future bumps require coordinated change.

(g) **Cross-dashboard `ApprovalKind` widening is safe.**
- COVERED by Task 5.1 Step 0 (M10 audit) — TUI/GUI/Rust crate surfaces are either widened with placeholder rendering OR fall-through is documented. `rly pending-approvals --json` test asserts handoff-prompt records render correctly.
</verification>

<success_criteria>
- All five PRs (Wave 0+1 combined per L2 → Wave 5) shipped, each ≤ 800 LOC (Wave 4 may split into 4a/4b per L3; Wave 5 may split into 5a/5b if M10 widening is heavy).
- Full validation gate green: `pnpm test && pnpm typecheck && pnpm build && cargo check --workspace`.
- All seven Wave-0 test files exist; six of them assert real behavior (synthesizer / render / validate / threshold-listener / cli / resume); the seventh (persistence) covers the disk layer.
- `rly handoff` is a documented top-level CLI command (in `printTopLevelHelp` and `docs/cli/rly-handoff.md`).
- `channel_handoff_finalize` is a registered MCP tool (in `getChannelToolDefinitions` and README MCP-tools list); rejects `schemaVersion !== 1` (M9).
- Brief artifacts at `~/.relay/channels/<id>/handoffs/<briefId>.{md,gap.json}` with `schemaVersion: 1` (first versioned `~/.relay/` artifact); fail-closed on future bumps.
- 90% nudge flows: Phase 1 emits feed entry → Phase 2 listener (default 5s poll per M8, STRING→NUMBER at boundary per M1) enqueues `kind: "handoff-prompt"` → user runs `rly approve <id>` → user invokes `rly handoff <channelId> --to <dest>`. Each step independently testable. H2b defense-in-depth test asserts two-session independence.
- Phase 1 dependency surface is one file (`feed.jsonl`) and one metadata-key/value contract — verified by zero `src/budget/` imports in **Phase-2-authored** paths (per H1 tightened grep).
- No Rust crate changes UNLESS M10 audit identified `ApprovalKind` widening; in that case Rust changes compile cleanly.
- Two validation modes (M2): STRICT (`--to`) and PERMISSIVE (`--save`); secret-pattern hard in BOTH; tests cover both.
- Live-network integration tests live in `describe.skip` per AGENTS.md testing convention.
- Design doc (`docs/design/handoff-brief.md`) + CLI reference (`docs/cli/rly-handoff.md`) shipped per AGENTS.md design-doc convention; design doc includes `## Determinism caveats` (M3).
- Cross-dashboard audit (M10) complete; `rly pending-approvals --json` test green.
</success_criteria>

<output>
After completion, create `.planning/phases/02-handoff-command-brief-synthesizer/02-SUMMARY.md` (short form per H2a — mirrors Phase 1's revised convention) capturing:
- Final brief shape and rendered token estimate from a real channel (post-launch measurement, per RESEARCH A3).
- Whether the git-log files-touched approach (D-02) produced useful brief sections, or whether briefs feel thin and a richer source is needed in a future phase.
- Whether the 30s `--wait-gap` default proved sufficient or needs tuning.
- Whether the 5s `pollIntervalMs` default (per M8) was right or needs tuning under real load.
- Whether any Phase 1 contract drift (`metadata.schemaVersion` bump, threshold value change) was observed during execution and how it was reconciled.
- Confirmation that no Phase 1 internals were imported (the H1-tightened `grep` audit from `<verification>` step 5).
- Whether STRICT vs PERMISSIVE validation modes (M2) felt right in practice, or if `--save` should also enforce the cap.
- Result of the M10 cross-dashboard audit: which surfaces were widened, which fall through.
- Pointer to `docs/design/handoff-brief.md` for downstream consumers (Phase 3+ may build on the brief artifact).
</output>
