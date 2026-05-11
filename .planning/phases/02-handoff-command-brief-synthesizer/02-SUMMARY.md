# Phase 2 — Handoff command + brief synthesizer — SUMMARY

**Status:** Shipped (2026-05-10)
**Phase plan:** [`02-PLAN.md`](./02-PLAN.md)
**Phase 1 cross-link:** [`docs/design/context-threshold-events.md`](../../../docs/design/context-threshold-events.md) — Phase 1 publishes the threshold-event contract; Phase 2 PR-3 subscribes via `src/orchestrator/handoff/threshold-listener.ts` (the consumer half of the bidirectional contract).

## Goal recap

`rly handoff <channelId> --to <alias|--provider>` produces a structured brief from `~/.relay/` artifacts, lets the departing agent fill in working-memory gaps, and seeds a fresh session in the new provider with the brief — instead of replaying the raw transcript. When Phase 1's 90 % context-window threshold event fires, surface a human-in-the-loop nudge through the existing AL-7 approval queue. Brief is also writable to disk for the "resume after a week" case.

## Wave-by-wave summary

Five PRs landed, matching the wave structure in `02-PLAN.md`. Two waves trended above the original 800 LOC cap — Wave 0+1 combined per the L2 contingency note in `02-PLAN.md` (Wave 0 fixtures + Wave 1 synthesizer had no logical split that left both sub-PRs independently green), and Wave 4 grew because the CLI handler had to plumb three modes (strict / permissive / resume) plus dual Claude/Codex argv builders in one diff to keep the dispatch path coherent.

| Wave | PR | Commit | LOC | Title |
|------|----|--------|-----|-------|
| 0+1 | #219 | `228038e` | +1606 | feat(handoff): scaffold brief synthesizer (Phase 2 PR-1) |
| 2 | #220 | `1c8863a` | +847 / -2 | feat(handoff): channel_handoff_finalize MCP tool + gap-fill persistence (Phase 2 PR-2) |
| 3 | #222 | `5669796` | +551 / -29 | feat(handoff): threshold listener + handoff-prompt approval kind (Phase 2 PR-3) |
| 4 | #224 | `35d9d80` | +1518 / -48 | feat(handoff): rly handoff CLI command + spawn helpers (Phase 2 PR-4) |
| 5 | #226 | `62edac6` | +684 / -39 | docs(handoff): handoff brief design doc + CLI reference + integration tests (Phase 2 PR-5) |

PR-1 (1606 LOC) and PR-4 (1518 LOC) exceeded the standard 800 LOC cap; both were intentional whole-wave bundles per the L2 / L3 contingency notes in the plan. PR-1 bundled Wave 0 fixtures with Wave 1 synthesizer to close the compile gap (types existed but synthesizer didn't until both landed together). PR-4 bundled the CLI handler with the spawn helpers because the strict/permissive/resume dispatch coherence required all three to land in one diff.

## Requirements traceability — REQ-2.x

| Requirement | Satisfied in | Verified by |
|-------------|--------------|-------------|
| **REQ-2.1** `rly handoff` CLI with layered fallback (alias → adapter → profile) | PR-4 (#224) | `test/cli/handoff.test.ts`, `test/orchestrator/handoff/handoff-cli.test.ts` |
| **REQ-2.2** Pure synthesizer at `src/orchestrator/handoff/` (no LLM, no tokenizer dep) | PR-1 (#219) | `test/orchestrator/handoff/synthesizer.test.ts`, `test/orchestrator/handoff/render-markdown.test.ts`, `test/orchestrator/handoff/validate.test.ts` |
| **REQ-2.3** `channel_handoff_finalize` MCP tool (gap-fill persistence via Zod schema) | PR-2 (#220) | `test/mcp/channel-handoff-finalize.test.ts`, `test/orchestrator/handoff/persistence.test.ts` (incl. M9 schemaVersion fail-closed) |
| **REQ-2.4** 90 % nudge via ApprovalsQueue (human-in-the-loop, never auto) | PR-3 (#222) | `test/orchestrator/handoff/threshold-listener.test.ts`, `test/cli/pending-approvals-handoff.test.ts` (M10 dashboard audit) |
| **REQ-2.5** New-session seed for both Claude and Codex | PR-4 (#224) | `test/orchestrator/handoff/handoff-cli.test.ts` (argv-builder assertions for both providers; Codex variant drops orchestrator-pipeline flags per M6) |
| **REQ-2.6** Brief artifacts at `~/.relay/<channelId>/handoffs/<briefId>.{md,gap.json}`, `schemaVersion: 1` | PR-1 (#219) + PR-2 (#220) + PR-4 (#224) | `test/orchestrator/handoff/persistence.test.ts` (atomic md + gap.json pair; tmp-file + rename; path-traversal guard) |
| **REQ-2.7** Brief validation including secret-shape rejection (D-09) | PR-1 (#219) | `test/orchestrator/handoff/validate.test.ts` |
| **REQ-2.8** `--save` mode (permissive, save-only) + `--resume <briefId|latest>` mode (M7: gap.json only) | PR-4 (#224) | `test/orchestrator/handoff/handoff-resume.test.ts` (skeleton regen + `resumedFrom` provenance + `capturedAt` re-tag for D-08) |
| **REQ-2.9** Vitest scripted-mode coverage; live tests sit in `describe.skip` blocks | PR-1 → PR-5 | `pnpm test` (full suite) — all GREEN; live-network suite in `test/integration/handoff/handoff-integration.test.ts` under describe.skip |
| **REQ-2.10** Documentation — design doc + CLI reference following AGENTS.md design-doc convention | PR-5 (#226) | [`docs/design/handoff-brief.md`](../../../docs/design/handoff-brief.md), [`docs/cli/rly-handoff.md`](../../../docs/cli/rly-handoff.md), README updates |

All ten requirements satisfied.

## Phase 1 ↔ Phase 2 threshold-event contract — Phase 2 side

Phase 1 PR-5 SUMMARY (lines 99-110) confirmed the contract from the Phase 1 side. Phase 2's confirmation:

`src/orchestrator/handoff/threshold-listener.ts` subscribes to `~/.relay/channels/<channelId>/feed.jsonl` via `ChannelStore.readFeed` and filters using the documented predicate from [`docs/design/context-threshold-events.md`](../../../docs/design/context-threshold-events.md):

```ts
entry.type === "status_update" &&
entry.metadata.kind === "context_threshold" &&
entry.metadata.schemaVersion === "1" &&
entry.metadata.threshold === "90"
```

The listener:

- Filters on `sessionId` match (the listener is per-session) and `threshold === "90"` (the user-visible nudge; Phase 1 also publishes 75 and 95, but Phase 2 only consumes 90).
- Dedupes in-process by `(sessionId, threshold)` per the D-03 contract.
- Seeds restart-idempotency by reading `approvalsQueue.list(sessionId)` positionally (per H1) and filtering `kind === "handoff-prompt"` in JS, so a process restart doesn't double-fire the nudge.
- Default `pollIntervalMs = 5000` per the M8 sharpening.
- Converts `metadata.pct / used / total` from STRING → NUMBER once at the boundary (Phase 1 stores all metadata values as strings per the `ChannelEntry.metadata: Record<string, unknown>` convention; consumer-owns-the-coercion).

The contract is live and bidirectional. Zero drift between the design doc and what shipped.

## `HandoffPromptPayload` shape

Approval queue records carry `kind: "handoff-prompt"` with the payload shape validated by a hand-rolled validator at the queue boundary (PR-3, `src/approvals/queue.ts`). The TUI (`tui/src/ui.rs`) and GUI (`gui/src/components/RightPane.tsx`) render `record.kind` as an opaque string label and pretty-print payload JSON — neither switches on the `kind` value. The Rust mirror in `crates/harness-data/src/lib.rs::ApprovalQueueRecord.kind` is `String`, not an enum. **M10 cross-dashboard audit conclusion (PR-5):** widening `ApprovalKind` with `"handoff-prompt"` was safe with zero changes to the dashboards. Pinned in code by `test/cli/pending-approvals-handoff.test.ts`.

## Brief schema + section ordering

Per [`docs/design/handoff-brief.md`](../../../docs/design/handoff-brief.md) (Specs section), brief markdown sections in fixed order: Status snapshot → Ticket DAG state → Recent decisions (rationale + alternatives) → Files touched → Gap-fill block (working-memory transfer). Token budgets per section live in `BRIEF_TOKEN_BUDGETS` (D-04). Schema version pinned at `HANDOFF_BRIEF_SCHEMA_VERSION = 1` — the first versioned `~/.relay/` artifact (per CONCERNS.md and D-05). M9 invariant: `schemaVersion !== 1` records yield `null` from `readLatestGapFill`, never silent-coerce to v1.

## Three-mode CLI dispatch

```
rly handoff <channelId> --to <profile|adapter|alias>   # STRICT, dispatches new session
rly handoff <channelId> --save                         # PERMISSIVE, save-only (writes md + gap.json to disk)
rly handoff <channelId> --resume <briefId|latest> --to # M7: re-seeds with gap.json only; md is a snapshot
```

The `--resume` path consumes ONLY `<briefId>.gap.json` from disk; the `<briefId>.md` is a snapshot, never re-fed into `buildBrief`. The deterministic skeleton is regenerated from the channel's current state and the new brief carries `resumedFrom` provenance. To support D-08 ("resume after a week"), the loaded gap-fill's `capturedAt` is re-tagged.

JSON envelope per Q16; feed-entry + best-effort decision-record written per RESEARCH §Q16; dispatch sandbox defaults to `read-only`, `channel.fullAccess` opts into `workspace-write`.

## CI gate results (PR-5)

All gates GREEN on `feat/phase-2-pr-5`:

- `pnpm install` — clean
- `pnpm test` — full suite GREEN (live tests skipped under default `HARNESS_LIVE` unset)
- `pnpm typecheck` — `tsc --noEmit` clean
- `pnpm format:check` — clean
- `pnpm build` — `tsc -p tsconfig.build.json` + migration copier GREEN
- `cargo check --workspace --locked` — clean (no Rust code changed; only the M10 audit confirmed `ApprovalQueueRecord.kind: String` mirror needed no widening)

## Deferred follow-ups

1. **LLM polish pass on the deterministic skeleton.** ROADMAP.md Phase 2 "open questions" called this out: start without it; add only if briefs feel rough in practice. Status today: shipped without polish; reconsider after Phase 4 surfaces add real-world usage signals.
2. **Brief retention policy.** Like Phase 1's `~/.relay/sessions/<id>/budget.jsonl`, briefs accumulate at `~/.relay/<channelId>/handoffs/`. No auto-archive. Captured as a todo (`.planning/todos/pending/phase-2-summary.md` references this for follow-up consideration).
3. **GUI nudge surface.** Today the 90 % nudge lands in the AL-7 approval queue, visible via `rly pending-approvals` and (M10) renders as an opaque string in TUI / GUI. A first-class GUI dialog ("you're at 90 % — hand off?") with a one-click accept would tighten the loop. Out of scope for Phase 2 (the underlying primitive ships); could ride Phase 4's project readiness surface.
4. **Brief-quality smoke.** Acceptance criterion in `ROADMAP.md` ("first response demonstrates context retention; won't re-litigate decisions") is observable but not automated. Live-network suite under `test/integration/handoff/` is the closest thing today (sits in `describe.skip` per REQ-2.9). A scripted brief-quality eval could be added but would need a fixture corpus of "good" briefs first.
5. **Codex Branch B usage extraction.** Phase 1 A1 spike returned INCONCLUSIVE; if Branch B turns out to apply, Phase 2's threshold listener will silently no-op for Codex sessions because no threshold events fire. Tracked in `.planning/todos/pending/codex-a1-spike-rerun.md`. Out of Phase 2 scope.

## Pointer for Phase 4's planner

The brief artifact layout under `~/.relay/<channelId>/handoffs/` and the `HandoffPromptPayload` shape are stable. Phase 4 (project readiness surface) can read both via `crates/harness-data/` for the project-rooted view. If Phase 4 wants to render "unread handoff prompts" as a project-level signal, the data source is `approvalsQueue.list()` filtered by `kind === "handoff-prompt"`.

## Live-network test leakage check

Spec required: any test needing `HARNESS_LIVE=1` should be NONE in the default `pnpm test` invocation. NONE leaked. All Phase 2 scripted tests run under default `pnpm test`. The live-network handoff-integration suite at `test/integration/handoff/handoff-integration.test.ts` sits inside `describe.skip(...)` per REQ-2.9.
