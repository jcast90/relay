# Handoff brief synthesizer + `rly handoff` command

**Status:** Shipped (Phase 2)
**Owner:** `@jcast90`
**Target version:** v0.8.0
**Related code paths:** `src/orchestrator/handoff/{synthesizer,render-markdown,validate,persistence,threshold-listener,files-touched,token-estimate,types}.ts`, `src/cli/handoff.ts`, `src/mcp/channel-tools.ts`, `src/approvals/queue.ts`, `src/domain/handoff.ts`
**Related docs:** [`docs/cli/rly-handoff.md`](../cli/rly-handoff.md), [`docs/design/context-threshold-events.md`](./context-threshold-events.md) (Phase 1 contract)

## Problem

When a user exhausts credits/tokens with one provider mid-task and wants to switch to another (Claude → Codex, or vice-versa), getting the destination agent caught up is painful. Replaying the raw transcript is wasteful, lossy, and hostile to the destination's prompt-size budget. Manual summaries are inconsistent.

Relay already persists rich state in `~/.relay/channels/<channelId>/`: feed events, decision logs with rationale + alternatives, ticket DAGs, run links. That's exactly the corpus a handoff brief should be built from. The hard parts are (1) capturing the departing agent's working memory before its session ends, (2) hooking the 90% nudge into Phase 1's threshold-event stream cleanly, and (3) seeding a new session in a possibly-different provider with that brief.

The same machinery also serves the "resumed after a week" case (laptop closed; come back to a fresh session in the same provider).

## Goals

- **REQ-2.1.** `rly handoff <channelId> --to <value>` exists and is documented in `printTopLevelHelp()`. `--to` resolution is layered: provider-profile id → adapter shorthand (`claude` / `codex`) → channel repo alias.
- **REQ-2.2.** Pure-over-declared-inputs deterministic synthesizer at `src/orchestrator/handoff/` that reads `~/.relay/channels/<id>/` and produces a structured `HandoffBrief` value.
- **REQ-2.3.** New MCP tool `channel_handoff_finalize` lets the departing agent fill four working-memory slots before its session ends.
- **REQ-2.4.** Phase 1's 90% `context_threshold` feed entry is surfaced through the existing `ApprovalsQueue` as `kind: "handoff-prompt"`. Declining is benign.
- **REQ-2.5.** A new session in the destination provider is dispatched with the brief seeded as its first turn — Claude (`--append-system-prompt` + first-turn) and Codex (positional first-turn).
- **REQ-2.6.** Brief artifacts persist at `~/.relay/channels/<id>/handoffs/<briefId>.{md,gap.json}` with `schemaVersion: 1`. First versioned `~/.relay/` artifact.
- **REQ-2.7.** Brief validation enforces token caps, required sections, and secret-pattern detection.
- **REQ-2.8.** `--save` mode persists without dispatching; `--resume <briefId|latest>` re-seeds from a saved brief, supporting "resume after a week".
- **REQ-2.9.** Vitest scripted-mode coverage across synthesizer / validation / MCP tool / threshold listener / CLI; live-network tests in `describe.skip` per AGENTS.md.
- **REQ-2.10.** User-facing CLI reference + design doc shipped per AGENTS.md "Design-doc convention".

REQ-2.1 through REQ-2.6 trace 1:1 to HOFF-01 through HOFF-06 in [`02-RESEARCH.md`](../../.planning/phases/02-handoff-command-brief-synthesizer/02-RESEARCH.md). REQ-2.7 through REQ-2.10 are net-new requirements derived from the locked decisions D-07 through D-09 and AGENTS.md doc convention; they have no HOFF predecessor.

## Non-goals

- **No first-class file-touched tracking.** v1 reconstructs files-touched from `git log --name-only` scoped by ticket commit boundaries (D-02). Uncommitted changes and tickets without commit refs are missing — a v1-lossy footnote surfaces this in the rendered brief.
- **No LLM polish.** The synthesizer is a deterministic join. No model in the loop. Adding an optional polish pass is a future phase.
- **No auto-trigger.** Handoffs are always user-initiated. The 90% nudge is information, not coercion. Even after accepting the nudge, the user runs `rly handoff` themselves.
- **No multi-channel handoff.** One channel at a time. Cross-channel orchestration is out of scope.
- **No auto-archive of briefs.** Briefs accumulate under `handoffs/`; pruning is left to the user / a future phase.

## Mental model

> The synthesizer is a **join**, not an analysis.

We're not inventing the corpus — we're joining files we already own. The brief = `feed.jsonl + decisions/*.json + tickets.json + runs.json + git log` projected through a fixed section ordering, plus four agent-authored slots that fill what's only in working memory.

This framing matters because it dictates the design constraints:

- **No tokens spent at synthesis time.** The skeleton is free. Important when the trigger is precisely "user is running out of tokens".
- **Determinism is cheap.** A fixed order, fixed slots, hand-rolled markdown — no library, no surprise.
- **The departing agent only fills four slots.** Everything else is reconstructed from disk. An agent already at 95% context can still make four short, focused statements; it can't generate a 4K-token transcript summary.

## Architectural decisions

The locked decisions from `.planning/notes/handoff-feature-design.md` and PLAN's `<locked_decisions_from_predecided_open_questions>`:

- **D-01 — Phase 1 contract.** Subscribe to the 90% upward-crossing `context_threshold` feed entry, per-session, single-emit. Single source of truth: `<phase_2_handoff_contract>` block in PLAN.md (mirror in [`docs/design/context-threshold-events.md`](./context-threshold-events.md) when present).
- **D-02 — Files-touched per ticket.** v1 uses `git log --name-only` scoped by ticket commit boundaries. Lossy and accepted as the one declared side effect of the otherwise pure synthesizer (per M3 reframe). Render layer surfaces a v1-lossy footnote in the Files-touched section.
- **D-03 — `--to <value>` resolution.** Single flag, layered fallback: profile id → adapter name → channel repo alias. No separate `--provider` flag.
- **D-04 — Per-section token budgets.** Heuristic for v1 (constants, flagged for tuning): status ≤ 200, mission ≤ 300, ticket DAG ≤ 600, recent decisions ≤ 1500, files touched ≤ 400, working memory ≤ 1500. Total brief soft cap 4,000; hard cap 8,000 (refuse without `--force` in STRICT mode).
- **D-05 — Artifact location.** `~/.relay/channels/<channelId>/handoffs/<briefId>.{md,gap.json}` with `schemaVersion: 1`. First versioned `~/.relay/` artifact. The MCP tool's Zod schema rejects any payload with `schemaVersion !== 1` at runtime (M9).
- **D-06 — Gap-fill mechanism.** New MCP tool `channel_handoff_finalize` that the departing agent voluntarily calls inside its current turn. Brief MUST render successfully without a gap-fill — placeholder fallback `[gap-fill not provided]` with explanatory note. The agent learns to call this tool via system-prompt instruction in the destination session's first turn, proactive detection, or explicit user instruction — NOT via the dashboard-visible feed entry the CLI posts (L5).
- **D-07 — 90% nudge UX.** Reuse AL-7 approval queue. New `ApprovalKind = "handoff-prompt"`. Threshold listener mirrors the precedent at `src/orchestrator/repo-admin-session.ts`. Cross-dashboard rendering surfaces (TUI / GUI / Rust crate) audited in M10 (see [Cross-dashboard audit](#cross-dashboard-audit-m10) below).
- **D-08 — Resume-after-week.** Same `rly handoff` command. `--save` mode (no `--to`) saves the brief to disk without dispatching. `--resume <briefId|latest> --to <dest>` loads the saved `<briefId>.gap.json` AND regenerates the deterministic skeleton from current channel state — the saved `<briefId>.md` is a snapshot, not re-consumed by `buildBrief` (M7). No separate `rly resume` command.
- **D-09 — Brief validation.** Two modes (M2): STRICT (`--to`) checks required sections + total token cap (hard) + secret-pattern. PERMISSIVE (`--save`) checks ONLY secret-pattern. Secret-pattern is hard, no `--force` override, in BOTH modes. Lives at `src/orchestrator/handoff/validate.ts`.

## Implementation plan

See [`02-PLAN.md`](../../.planning/phases/02-handoff-command-brief-synthesizer/02-PLAN.md). The phase shipped across five PRs (Wave 0+1 combined per L2 → Wave 5):

1. **PR-1 (Wave 0+1).** Types, fixtures, synthesizer, render-markdown, validate, files-touched (#219).
2. **PR-2 (Wave 2).** Persistence + `channel_handoff_finalize` MCP tool (#220).
3. **PR-3 (Wave 3).** Threshold listener + `ApprovalKind = "handoff-prompt"` + dispatch wiring (#222).
4. **PR-4 (Wave 4).** `rly handoff` CLI + `--save` / `--resume` modes + Claude/Codex chat-seed argv (#224).
5. **PR-5 (Wave 5).** This doc + CLI reference + integration tests + cross-dashboard audit (this PR).

## Determinism caveats (M3)

`buildBrief` is **pure-over-declared-inputs**, not strictly pure. Two callers:

- **Tests** opt out of the `git log` enrichment with `gitLogEnabled: false`, getting strict bit-identicality. Fixture-driven assertions in `synthesizer.test.ts` rely on this.
- **Production** runs with `gitLogEnabled: true` (default). On real repos, two back-to-back `buildBrief` calls separated by a `git pull` or any new commit can produce different file lists in the Files-touched section.

This is acceptable for v1 because:

- The non-determinism is one declared, scoped side effect (`git log --name-only` in `src/orchestrator/handoff/files-touched.ts`).
- The render layer surfaces a v1-lossy footnote so brief consumers see the limitation without reading the source.
- No `Date.now()`, `Math.random()`, or `process.env` reads happen anywhere in the synthesis path — `now` and the channel store are passed in.

A future v2 may switch to a first-class file-tracking source (per D-02 follow-up) — which would let us drop the caveat entirely.

## Schema versioning

- `HANDOFF_BRIEF_SCHEMA_VERSION = 1` is exported from `src/domain/handoff.ts`.
- Both the persisted `<briefId>.gap.json` and the rendered brief markdown header carry this constant.
- Two read paths fail-closed on a future bump (M9):
  1. `channel_handoff_finalize` MCP tool — Zod schema rejects `schemaVersion !== 1` at runtime.
  2. `readLatestGapFill` — returns `null` (treated as "no gap-fill available", placeholder rendered) when it sees a gap.json with a different schemaVersion.
- A future bump to `schemaVersion: 2` requires a coordinated change across the writer (MCP tool + persistence) and every reader (synthesizer, render, dashboards).

This is the **first versioned `~/.relay/` artifact** — the convention is intentional and documented in CONCERNS.md.

## Cross-dashboard audit (M10)

The PLAN's M10 revision required auditing `tui/`, `gui/src/`, `gui/src-tauri/`, and `crates/harness-data/` for `ApprovalKind` / `ApprovalRecord` switches that the new `"handoff-prompt"` arm widens.

**Audit conclusion (2026-05-09): no widening needed.** None of the four surfaces switches on `kind` values. The relevant types render `kind` as an opaque string label:

| Surface                              | Type / call site                       | Treatment                                                                                                                                                                                                              |
| ------------------------------------ | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crates/harness-data/src/lib.rs:528` | `ApprovalQueueRecord.kind: String`     | Open string. Comment at `lib.rs:483-485` documents this is intentional: _"`payload` is deliberately `serde_json::Value` so dashboards don't need to know every kind ahead of time."_ The same logic applies to `kind`. |
| `gui/src/types.ts:287`               | `ApprovalQueueRecord.kind: string`     | Open string.                                                                                                                                                                                                           |
| `gui/src/components/RightPane.tsx`   | Renders `kind` and `payload` opaquely. | No `kind === "merge-pr"`-style switches.                                                                                                                                                                               |
| `tui/src/ui.rs:2043`                 | `format!("Approval: {}", rec.kind)`    | Renders `kind` as a label. No match arms.                                                                                                                                                                              |

`grep -rn 'merge-pr\|create-ticket\|handoff-prompt' tui/ gui/ crates/harness-data/` returns zero hits — there is no kind-specific renderer anywhere in the dashboards. Widening the TS `ApprovalKind` union to include `"handoff-prompt"` is safe with zero changes to the dashboards.

`rly pending-approvals` (TS, `src/index.ts:1769`) renders `kind` via string interpolation (`kind=${r.kind}`), so the new arm appears correctly with no code change.

If a future change introduces a kind-specific renderer (icon picker, pluralizer, color), it must add a `"handoff-prompt"` arm — the audit conclusion is keyed to the current state of the code.

## Threat model summary

The full STRIDE threat register lives in PLAN.md `<threat_model>`. High-level:

- **Path traversal** via `<channelId>` / `<briefId>` — `assertSafeSegment` + `assertValidBriefId` regex (`/^brief-[0-9]+-[a-z0-9]+$/`) before any disk write.
- **Prompt injection via gap-fill** — accepted with mitigation: gap-fill is markdown the destination agent reads; the destination session inherits the channel's `fullAccess` flag, so restricted channels stay permission-prompted regardless of brief content.
- **Secret leaks in the brief** — four secret-pattern regexes (AWS access-key, OpenAI-style, generic `key=value`, PEM) run in BOTH STRICT and PERMISSIVE modes. Hard error, no `--force` override (D-09). Pattern names reported but matched substrings are never printed.
- **Stale gap.json** — `<briefId>.gap.json` carries `capturedAt`; `readLatestGapFill` ignores entries older than `maxAgeMs` (default 1h). Also rejects `schemaVersion !== 1` (M9 — fail closed).
- **Subprocess env leakage** — all spawning routes through `NodeCommandInvoker`, which strips matching `SECRET_NAME_PATTERN` env vars by default. `passEnv` is explicit per-name (Codex: `OPENAI_*` only; Claude: nothing extra — `launchInteractiveCommand` inherits parent env because chat-seed is a foreground UX command, not a sandboxed job).
- **Schema-version drift** — listener filters on `metadata.schemaVersion === "1"` AS WELL AS the other predicates; a Phase 1 schema-version bump fails closed (no enqueue).

## End-to-end flow: 90% nudge

```
[Phase 1 emitter]
  ↓  posts entry to feed.jsonl with metadata.kind="context_threshold"
  ↓  metadata.threshold="90", metadata.sessionId, metadata.pct, metadata.schemaVersion="1"
  ↓
[Phase 2 threshold-listener.ts]            (default poll: 5s, M8)
  ↓  filters: type==="status_update" && metadata.kind==="context_threshold"
  ↓           && metadata.threshold==="90" && metadata.schemaVersion==="1"
  ↓  dedup: (sessionId, threshold) — D-03 contract
  ↓  Number(entry.metadata.threshold) → payload.thresholdPct  (M1: parsed once)
  ↓  Number(entry.metadata.pct)       → payload.pct
  ↓
[ApprovalsQueue.enqueue]
  ↓  kind: "handoff-prompt"
  ↓  payload: HandoffPromptPayload { thresholdPct, pct, channelId, fromSessionId }
  ↓
[User surface]
  → TUI Approvals tab
  → GUI right-rail approvals card
  → CLI: `rly pending-approvals` / `rly approve <id>`
  ↓  user runs `rly approve <approvalId>`
  ↓
[User runs `rly handoff <channelId> --to <dest>`]
  ↓
[Synthesizer]
  → buildBrief({ channelId, now, channelStore, gapFill?, fromProvider, toHint })
  ↓
[Validate (STRICT mode)]
  → reject on token cap > 8K (no --force) / missing sections / secrets
  ↓
[Persistence — writeBriefArtifact]
  → ~/.relay/channels/<id>/handoffs/<briefId>.md
  → ~/.relay/channels/<id>/handoffs/<briefId>.gap.json
  ↓
[Spawner — buildClaudeChatArgv / buildCodexChatArgv]
  → claude -p --append-system-prompt <brief>     (interactive)
  → codex exec -C <cwd> --sandbox <mode> <brief>  (chat-seed; no orchestrator-pipeline flags, M6)
  ↓
[Destination session]
  → first-turn context = brief markdown
  → ChannelStore.postEntry: status_update with handoff metadata
  → ChannelStore.recordDecision (best-effort, L4)
```

Decline path: `rly reject <approvalId>` is benign — the running session continues normally. The user can still invoke `rly handoff` later, or never. No auto-trigger.

## Specs

Given/When/Then scenarios — one bullet per requirement, scenarios nested under it.

- **REQ-2.1 / REQ-2.2 / REQ-2.5 / REQ-2.6 (happy path).**
  - Given a channel with feed/decisions/tickets, When the user runs `rly handoff <channelId> --to claude`, Then a brief markdown is generated under `~/.relay/channels/<channelId>/handoffs/<briefId>.md` with `**Schema version:** 1` in the header.
  - Given a destination resolves to the Codex adapter, When the spawner is invoked, Then the argv contains `exec`, `--sandbox`, and the brief markdown — and **does NOT** contain `--output-schema`, `-o`, or `--ask-for-approval` (M6).

- **REQ-2.7 (validation).**
  - Given a brief over 8K tokens, When STRICT validation runs (used by `--to`), Then the CLI exits non-zero unless `--force` is passed.
  - Given a brief over 8K tokens, When PERMISSIVE validation runs (used by `--save`), Then the CLI succeeds and emits a soft-cap warning (M2).
  - Given the brief contains a string matching `AKIA[A-Z0-9]+`, When validation runs (STRICT or PERMISSIVE), Then the CLI ALWAYS exits non-zero (no `--force` override).
  - Given the brief contains a string matching `sk-[A-Za-z0-9]+`, When validation runs, Then the CLI exits non-zero in both modes.

- **REQ-2.4 (90% nudge).**
  - Given Phase 1 emits a `context_threshold` feed entry with `threshold === "90"` for `sessionId == "sess-x"`, When the threshold listener observes it, Then exactly one `ApprovalsQueue` record of `kind: "handoff-prompt"` with `payload.thresholdPct === 90` (number) is enqueued.
  - Given the listener has already enqueued for (`sess-x`, 90), When another `threshold === "90"` entry for the same session lands, Then no new approval is enqueued.
  - Given two distinct sessions sess-A and sess-B both crossing 90%, When both have listeners attached, Then BOTH receive an independent approval (no cross-session dedup) — H2b defense-in-depth.
  - Given an `ApprovalsQueue` record of `kind: "handoff-prompt"` exists, When `rly pending-approvals --json` runs, Then the output JSON includes the record AND the rendering does not throw / mark it as `unknown` (M10).

- **REQ-2.8 (`--save` / `--resume`).**
  - Given the user runs `rly handoff <channelId> --save`, When the command completes, Then the brief is on disk AND no destination session is dispatched.
  - Given a saved brief at `<briefId>`, When the user runs `rly handoff <channelId> --resume <briefId> --to claude`, Then ONLY the `<briefId>.gap.json` is read, the deterministic skeleton is regenerated from current channel state, the saved gap.json is preserved, the new brief carries `resumedFrom`, and a new session is dispatched (M7).
  - Given multiple briefs exist, When the user runs `--resume latest`, Then the most-recent `briefId` is selected by listing under `handoffs/`.

- **REQ-2.3 / D-06 (gap-fill).**
  - Given the departing agent calls `channel_handoff_finalize` with the four working-memory slots, When the call succeeds, Then `~/.relay/channels/<id>/handoffs/<briefId>.gap.json` exists with `schemaVersion: 1` and the four slots.
  - Given a `gap.json` on disk with `schemaVersion: 2`, When `readLatestGapFill` runs, Then it returns `null` — fail closed; no silent coercion (M9).
  - Given the departing agent never calls `channel_handoff_finalize`, When `rly handoff` runs after `--wait-gap` timeout, Then the brief still renders with `[gap-fill not provided]` placeholder.
  - Given the gap.json `capturedAt` is older than 1h, When the synthesizer runs, Then the placeholder is used (stale-gap → placeholder, M5).

## Open questions

- **Per-section budgets.** D-04's caps are heuristics. Measure on real channels post-launch (RESEARCH A3) and tune. Sub-bullet candidates: are recent-decisions truncated too aggressively? Is the working-memory cap right? Track in `02-SUMMARY.md`.
- **Files-touched source.** Is `git log --name-only` thin enough that downstream agents miss critical context? If so, a future phase adds first-class file-touch tracking (D-02 follow-up). Track in `02-SUMMARY.md`.
- **GUI surface for handoff approvals.** Today the GUI right rail renders `handoff-prompt` records via the same generic `kind` label as every other approval. A bespoke card with a one-click "open `rly handoff` terminal" action is a future enhancement (RESEARCH Open question 2).
- **Brief auto-archive.** Briefs accumulate under `handoffs/`. A retention policy (e.g. keep last N, or last 30 days) is a future phase (RESEARCH Open question 3).

## Sign-off

_Pending user approval._
