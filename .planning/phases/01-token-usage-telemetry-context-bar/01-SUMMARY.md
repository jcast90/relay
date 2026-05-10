# Phase 1 — Token-usage telemetry + context bar — SUMMARY

**Status:** Shipped (2026-05-09)
**Phase plan:** [`01-PLAN.md`](./01-PLAN.md)
**Phase 2 cross-link:** [`docs/design/handoff-brief.md`](../../../docs/design/handoff-brief.md) — first consumer of the Phase 1 contract.

## Goal recap

Live `% of context window consumed` per session, visible in TUI / GUI / CLI for all three dispatch paths (orchestrator, GUI chat-event loop, TUI chat-event loop), populated by both Claude and Codex adapters, persisted at `~/.relay/sessions/<sessId>/budget.jsonl`, emitting threshold events at 75 / 90 / 95 % on the channel feed for Phase 2's `rly handoff` planner to subscribe to.

## Wave-by-wave summary

Five PRs landed, matching the wave structure in `01-PLAN.md`. No mid-flight wave splits were triggered (PR-2 stayed under 800 LOC, PR-3 stayed under 800 LOC).

| Wave | PR | Commit | LOC | Title |
|------|----|--------|-----|-------|
| 0 | #218 | `b3c4f06` | +1735 | feat(budget): Phase 1 PR-1 — SessionBudget schema + RED test scaffolds + A1 spike |
| 1 | #223 | `5c8698b` | +763 / -136 | feat(budget): adapter usage + tracker pool + threshold-feed bridge (Phase 1 PR-2) |
| 2 | #225 | `6a4875c` | +1003 / -256 | feat(budget): GUI/TUI context-window bars + relay-paths shared crate (Phase 1 PR-3) |
| 3 | #227 | `e5bb357` | +274 / -40 | feat(budget): Phase 1 PR-4 — chat-mode usage hook + rly status active sessions |
| 4 | (this PR) | (pending) | docs-only | docs(budget): Phase 1 telemetry final gate — README + SUMMARY + Phase 2 cross-link |

PR-3 trended slightly above the original 560 LOC estimate (1003 added / 256 removed) because the `relay-paths` crate hoist pulled in helpers (`augmented_child_path`, `cli_bin`) from `gui-src-tauri` along with their tests. Per the L1 contingency note the wave was kept whole because no logical split point would have left both sub-PRs independently green.

## Requirements traceability — REQ-1.x

| Requirement | Satisfied in | Verified by |
|-------------|--------------|-------------|
| **REQ-1.1** Per-session token-usage signal in orchestrator | PR-2 (#223) | `test/agents/cli-agents-claude-usage.test.ts`, `test/agents/cli-agents-codex-usage.test.ts`, `test/orchestrator/orchestrator-v2-token-usage.test.ts` |
| **REQ-1.2** Persist `~/.relay/sessions/{id}/budget.jsonl` | PR-1 (#218) + PR-2 (#223) | `test/budget/session-tracker-pool.test.ts`, `test/budget/tracker-restart-replay.test.ts`, `test/integration/session-budget-end-to-end.test.ts` |
| **REQ-1.3** Threshold events at 75 / 90 / 95 on channel feed | PR-2 (#223) | `test/budget/threshold-feed-bridge.test.ts` (incl. M5 multi-tracker + M7 pct-precision) |
| **REQ-1.4** TUI percent bar (works for TUI-launched chat) | PR-3 (#225) | `cargo test severity_color` + manual smoke: TUI chat session writes `kind: "chat"` budget line via `rly chat record-usage` shell-out |
| **REQ-1.5** GUI percent bar + worst-session chip (kind=chat filtered) | PR-3 (#225) | `gui/src/components/ContextWindowBar.test.tsx`, `gui/src/lib/modelContextWindows.test.ts` (M9 drift) |
| **REQ-1.6** CLI `rly status` + session listings | PR-4 (#227) | `test/cli/print-status-context.test.ts` |
| **REQ-1.7** Stable `SessionBudget` schema TS + Rust mirror (with `kind`) | PR-1 (#218) | `test/domain/session-budget.test.ts` + `cargo test session_budget` (incl. schemaVersion: 1 and v2 round-trip per M1) |
| **REQ-1.8** Tests — vitest + cargo + integration | PR-1 → PR-4 | `pnpm test`, `cargo test --workspace`, `cd gui && pnpm test` — all GREEN |
| **REQ-1.9** Threshold-event contract for Phase 2 | PR-2 (#223) | [`docs/design/context-threshold-events.md`](../../../docs/design/context-threshold-events.md) — confirmed live and consumed by Phase 2 PR-3 (#222) `src/orchestrator/handoff/threshold-listener.ts` |

All nine requirements satisfied.

## A1 spike result

```
BRANCH=INCONCLUSIVE
STREAM_FLAG=NONE
CODEX_VERSION=not installed
SCHEMA_PATH=fallback-empty-schema
USAGE_PRESENT=unknown
```

`codex` CLI was not installed in the executor environment when PR-1 ran the spike (`.planning/phases/01-token-usage-telemetry-context-bar/01-SPIKE-A1.md`). Per the M2 mitigation, Task 3 in PR-2 implemented **Branch A only** (top-level `response.usage` parse from the `--output-schema` response file) and emits one stderr warning (`[budget] Codex usage extraction unavailable; bar will not update for this session.`) when `parsed.usage` is undefined post-Codex-run. The orchestrator (Task 4) guards every record with `if (result.tokenUsage)`, so a missing usage is a no-op for downstream consumers — the bar stays at 0 % and no threshold event fires.

**Deferred follow-up:** when `codex` is installed in CI, re-run the spike (commands documented at the bottom of `01-SPIKE-A1.md`), overwrite the first 5 lines with the resolved branch, and — if the spike returns Branch B — Task 3 needs a second Codex code path.

## Final THRESHOLDS list — reachability

```
$ grep -n "^export const THRESHOLDS" src/budget/token-tracker.ts
17:export const THRESHOLDS = [50, 60, 75, 85, 90, 95, 100] as const;
```

The widening from `[50, 60, 85, 95, 100]` → `[50, 60, 75, 85, 90, 95, 100]` is additive (preserves `60` for `RepoAdminSession`'s memory-shed subscriber, per D-01). The threshold-feed bridge filters down to `[75, 90, 95]` for the channel-feed surface — chat-session noise is bounded.

## Threshold-feed entry shape (90 % example)

Verbatim JSON shape posted to `~/.relay/channels/<chid>/feed.jsonl` when a session crosses 90 %:

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

`metadata.pct` is pinned to `/^\d+\.\d{2}$/` by `test/budget/threshold-feed-bridge.test.ts` (M7). All `metadata` values are strings (`ChannelEntry.metadata: Record<string, unknown>` convention; numeric round-trips are the consumer's job — Phase 2's listener does `Number(...)` once when populating `HandoffPromptPayload`).

## H1 closure — TUI-launched chat session parity

PR-3 (#225) hoisted `augmented_child_path()` and `cli_bin()` out of `gui/src-tauri/src/lib.rs` into a shared `crates/relay-paths` crate, then wired the TUI chat worker (`tui/src/main.rs:2627-2779`, the H1 fix point) to capture `obj.usage` on the `Some("result")` arm and fire-and-forget `rly chat record-usage` via `Command::new(cli_bin()).env("PATH", augmented_child_path())` after `child.wait()` resolves.

`grep -n "rly.*record-usage\|cli_bin()" tui/src/main.rs` returns >= 1 match. The TUI bar updates live for these sessions.

## M3 closure — `kind` discriminator round-trip

`list_chat_session_budgets` (Tauri command + TS `loadActiveSessions`) filters `kind === "chat"` server-side, so the GUI worst-session chip and `rly status` active-sessions block surface ONLY chat-kinded entries. M4 test (`admin-*` budget file does NOT appear) is GREEN.

## Phase 2 contract confirmation

Phase 2 PR-3 (#222) shipped `src/orchestrator/handoff/threshold-listener.ts`, which subscribes to the documented filter:

```ts
entry.type === "status_update" &&
entry.metadata.kind === "context_threshold" &&
entry.metadata.schemaVersion === "1" &&
entry.metadata.threshold === "90"
```

with `(sessionId, threshold)` dedup per the D-03 contract. Phase 2 PR-5 (#226) cross-links this contract from [`docs/design/handoff-brief.md`](../../../docs/design/handoff-brief.md), and Phase 1 PR-5 (this PR) now cross-links back from [`docs/design/context-threshold-events.md`](../../../docs/design/context-threshold-events.md) Sign-off section. **The contract is live and bidirectional.**

## Live-network test leakage check

Spec required: any test needing `HARNESS_LIVE=1` should be NONE. NONE leaked. All Phase 1 tests run under the default scripted `pnpm test` invocation.

## CI gate results (PR-5)

All five gates GREEN locally on `feat/phase-1-pr-5`:

- `pnpm install` — clean
- `pnpm test` — 1098 passed, 28 skipped
- `pnpm typecheck` — `tsc --noEmit` clean
- `pnpm format:check` — clean
- `cargo check --workspace --locked` — clean
- `cd gui && pnpm build` — clean

## Deferred follow-ups

1. **A1 re-spike when `codex` is installed in CI.** The Branch A vs. Branch B determination is still INCONCLUSIVE. If Branch B turns out to apply, Task 3's adapter parser needs a second code path (JSONL stream consumer for `turn.completed.usage`). Until then, Codex chat sessions silently no-op the budget tracker — the orchestrator guard (`if (result.tokenUsage)`) keeps this safe but the bar reads 0 % forever for Codex.
2. **`--model` plumbing through chat record-usage shell-outs.** Today the GUI chat-event loop and the TUI chat worker pass `--model <name>` only when the model field is in scope at the call site. Two specific call sites in `tui/src/main.rs` and `gui/src-tauri/src/lib.rs` plumb it best-effort; if model isn't available the recorder defaults to the canonical model-context-windows table's 200 000 fallback with a stderr warning. The hidden-assumption hard-throw on `agent.capability.model` only applies in the orchestrator dispatch path. Consider hoisting model resolution into a dedicated `resolveModelFromSession` helper in a future cleanup.
3. **Cost guardrails (the original Roadmap item).** Phase 1 ships *context-window* telemetry only — no dollar cost, no per-run/ticket/channel token budget caps. The Roadmap entry stays open. The `~/.relay/sessions/<id>/budget.jsonl` shape is forward-compatible: `cumulativeUsed` is a token count, so a future cost layer can multiply by per-model rates.
4. **Brief auto-archive of `~/.relay/sessions/<id>/budget.jsonl`.** Like Phase 2's handoff briefs, budget files accumulate. A retention policy (last N sessions, last 30 days) is a future phase.
5. **GUI per-session chip on the channel sidebar.** Today the GUI shows a "worst session" chip globally (M4). A per-channel chip in the sidebar list could surface which channel has the most-saturated session, but is out of scope here.

## Pointer for Phase 2's planner

[`docs/design/context-threshold-events.md`](../../../docs/design/context-threshold-events.md) is the single source of truth for the Phase 2 subscription contract, including the D-03 + M8 sharpening (Phase 1 does NOT enforce 0 % start in code; Phase 2 owns the unique-sessionId invariant). Phase 2 PR-3 (#222) implemented the subscriber; this Phase 1 SUMMARY confirms zero drift between the contract document and what shipped.
