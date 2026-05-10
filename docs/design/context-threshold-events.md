# Context-threshold events on the channel feed

Status: Stable as of Phase 1 (2026-05-09)
Owner: Relay core
Target version: 0.7.x
Related code paths:

- `src/budget/threshold-feed-bridge.ts`
- `src/budget/token-tracker.ts`
- `src/budget/session-tracker-pool.ts`
- `src/orchestrator/orchestrator-v2.ts`
- `src/channels/channel-store.ts`
- `crates/harness-data/src/lib.rs` (Rust mirror — `SessionBudget`, `SessionKind`)

## Problem

Phase 2's `rly handoff` planner surfaces a "you're at 90%, want to hand off?" prompt when a chat session is near the model's context-window ceiling. It needs a deterministic, on-disk signal so the planner can subscribe via the existing channel-feed file rather than reaching into orchestrator internals. Phase 1 emits that signal.

## Goals

- Phase 2's planner can subscribe by tailing `~/.relay/channels/<id>/feed.jsonl`.
- The signal is rising-edge only — re-crossing 90% (e.g. after compaction) does not re-fire within the same session.
- The signal survives a process restart — `TokenTracker.firedThresholds` replay (token-tracker.ts:404-408) marks already-crossed thresholds on construction so a reload doesn't re-emit them.
- The same shape works for chat sessions (recorded via `rly chat record-usage`, Phase 1 PR-4) and orchestrator dispatches (recorded by `OrchestratorV2.dispatch`, Phase 1 PR-2).

## Non-goals

- Cross-process locking on `feed.jsonl` writes. The existing append-only contract applies (AGENTS.md: "channel-store.postEntry is append-only"). A torn last line is silently skipped by the Rust reader and recovers on the next render cycle.
- Re-firing a crossed threshold within the same session — by design, per `TokenTracker.firedThresholds`. Phase 2 must not assume retriggers.
- Per-tenant or per-workspace filtering. Subscribers filter on `metadata.sessionId` if they want session-scoped semantics.

## Mental model

```
Adapter (cli-agents.ts)
    │ extracts result.tokenUsage
    ▼
OrchestratorV2.dispatch (or chat record-usage CLI)
    │ pool.get(sessionId, ceiling, kind).record(in, out)
    ▼
TokenTracker
    │ firedThresholds + onThreshold listeners
    ▼
attachThresholdFeed (filter to [75, 90, 95])
    │ channelStore.postEntry({ type: "status_update", metadata: { kind: "context_threshold", … } })
    ▼
~/.relay/channels/<chid>/feed.jsonl
    │ appended atomically (one entry per crossed threshold per session)
    ▼
Phase 2 handoff planner (subscriber)
```

The wider in-process threshold list (`[50, 60, 75, 85, 90, 95, 100]`, D-01) stays available for in-process subscribers like `RepoAdminSession.handleThresholdEvent` (60% memory-shed cycle). The bridge filters down to `[75, 90, 95]` for the channel-feed surface so chat-session noise is bounded.

## Specs

### Channel-feed entry shape

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
    "model": "claude-sonnet-4-5",
  },
}
```

All `metadata` values are strings (matches the `ChannelEntry.metadata: Record<string, unknown>` convention; numeric round-trips are the consumer's job). `metadata.pct` is pinned to `/^\d+\.\d{2}$/` by `test/budget/threshold-feed-bridge.test.ts` (M7).

Given a `record()` that crosses 75 / 90 / 95 in one call, the bridge:

- When the crossed threshold is in `[75, 90, 95]`, posts exactly one `status_update` entry with `metadata.kind === "context_threshold"`.
- When the crossed threshold is outside that subset (e.g. 50, 60, 85, 100), posts nothing — the in-process EventEmitter still fires for in-process subscribers.

Given a process restart over an existing `~/.relay/sessions/<id>/budget.jsonl` whose cumulative is at 80%:

- `TokenTracker` replay marks `[50, 60, 75]` as already-fired (the canonical THRESHOLDS set ≤ resumed pct).
- A subsequent `record()` that crosses 90% emits one threshold-feed entry with `metadata.threshold === "90"`. 75 does NOT re-fire.

### Phase 2 subscription rule

```ts
const isContextThreshold90 = (entry: { type: string; metadata?: Record<string, unknown> }) =>
  entry.type === "status_update" &&
  entry.metadata?.kind === "context_threshold" &&
  entry.metadata?.threshold === "90";
```

Filter `feed.jsonl` lines through that predicate. The `sessionId` field tells you WHICH session crossed; a channel hosting multiple sessions over its lifetime emits one event per (session, threshold) pair.

### Handoff session-id contract (D-03 + M8 sharpening)

A Phase-2 handoff creates a NEW sessionId in the destination provider. The intent is that this session's tracker starts at 0% — but **Phase 1 does not enforce this in code**. Phase 1 guarantees only that `firedThresholds` is replayed from disk for the same sessionId (`src/budget/token-tracker.ts`).

To satisfy the 0%-start requirement, **Phase 2 MUST mint unique sessionIds** that have no pre-existing `~/.relay/sessions/<id>/budget.jsonl`. As a soft guard, `SessionTrackerPool.get` emits `console.warn("[budget] tracker for sessionId X is replaying non-zero state from disk")` if a brand-new sessionId surfaces a non-zero existing budget — but this is a warning, not an error. **Phase 2 owns the uniqueness invariant.**

Subscribers should treat each `(sessionId, threshold)` pair as independent.

### Schema bumps

`metadata.schemaVersion === "1"` is the contract version. Bumping it is a breaking change — coordinate across:

1. `src/budget/threshold-feed-bridge.ts` (the emitter).
2. `src/domain/session-budget.ts` (the on-disk shape).
3. `crates/harness-data/src/lib.rs` (the Rust mirror's `default_session_budget_schema_version`).
4. Phase 2's planner subscription code.

A coordinated bump should also include a forward-migration helper for any pre-existing on-disk lines.

## Implementation plan

Already implemented in Phase 1 PR-2 (this design doc lands in the same PR):

1. `src/budget/threshold-feed-bridge.ts` exports `attachThresholdFeed(tracker, channelId, channelStore, opts)` returning an unsubscribe handle.
2. `OrchestratorV2.dispatch` calls `attachThresholdFeed` after the first `tokenUsage`-bearing dispatch on a run, capturing the unsubscribe in `thresholdFeedUnsubs`.
3. `OrchestratorV2.waitForPendingWrites` runs every captured unsubscribe BEFORE `trackerPool.closeAll()` so a final-write listener never fires after the channel store is gone.
4. `TokenTracker.safeEmitThreshold` awaits any `Promise<void>` returned by an async listener so `tracker.flush()` drains the bridge's `channelStore.postEntry` work — `tests` and the orchestrator's drain rely on that.

Phase 1 PR-4 (later) adds the chat-mode `record-usage` CLI handler that reuses the same bridge for GUI- and TUI-launched chat sessions.

## Open questions

- **Multi-tenant scoping**: today the bridge posts to a single channel id passed at construction. If a future feature wants to fan out the same threshold event to multiple channels (e.g. an org-wide audit channel), the contract is additive — multiple `attachThresholdFeed` calls subscribe independent listeners. No change required here.
- **Numeric vs string metadata**: `ChannelEntry.metadata` is `Record<string, unknown>` so we could emit numbers. The Phase-2 planner is expected to `parseFloat` the strings already; flipping to numbers would be a `schemaVersion` bump.

## Sign-off

Pending Phase 2 plan-phase confirmation that the documented filter (`type === "status_update" && metadata.kind === "context_threshold" && metadata.threshold === "90"`) matches what the handoff planner subscribes to.
