# Phase 1: Per-session token-usage telemetry + context-window bar — Research

**Researched:** 2026-05-09
**Domain:** TS orchestrator <-> Rust dashboards; provider CLI parsing; on-disk telemetry plumbing
**Confidence:** HIGH (the central blocker is well-isolated; all hook points cited from source)

## Summary

Relay already has every piece needed *except* the wire from the provider adapter to the existing tracker. Specifically:

- **`TokenTracker`** (`src/budget/token-tracker.ts`) is feature-complete: `record(input, output)` API, replay-on-construct, threshold events at 50/60/85/95/100, debounced single-emit-per-rising-edge per tracker lifetime, atomic-append `~/.relay/sessions/<id>/budget.jsonl` persistence, reset / flush / close lifecycle. Per-line shape includes `cumulativeUsed` so a Rust reader can read a single trailing line for the live total.
- **The autonomous-session pipeline already works end-to-end:** `RepoAdminSession` records into a tracker (`src/orchestrator/repo-admin-session.ts:408,448-459`), the budget JSONL is read by `read_session_budget_used()` in the Tauri backend (`gui/src-tauri/src/lib.rs:3111-3135`), surfaced as `AutonomousSessionState.budgetPct`, and rendered by `AutonomousSessionHeader` (`gui/src/components/AutonomousSessionHeader.tsx`) with severity tiers `ok / warn / hot / overrun` matching `TokenTracker.THRESHOLDS`. **This is the prior art** — Phase 1 should mirror it for *chat sessions*, not invent a new shape.
- **The single missing wire is in the CLI adapters.** A repo-wide grep for `tracker.record(`, `tokenTracker.record(`, `input_tokens`, or `output_tokens` against `src/agents/` and `src/orchestrator/orchestrator-v2.ts` returns zero hits. Both `ClaudeCliAgent` (`src/agents/cli-agents.ts:347-520`) and `CodexCliAgent` (same file, `:258-345`) discard the provider's usage data. `ParsedProviderResult` (`:84-94`) has no `usage` slot.

**Primary recommendation:** Treat this phase as *plumbing the existing rails*, not building new ones. (1) Extend `ParsedProviderResult` with `usage`. (2) Parse `usage` from Claude's `result` event and from Codex's structured-output JSON. (3) Plumb `AgentResult.tokenUsage` through `orchestrator-v2.ts::dispatch` to a per-session `TokenTracker`. (4) Add a `harness-data::load_session_budget(session_id)` reader. (5) Render in TUI / GUI / CLI by reading that loader. (6) The threshold-event surface is *already debounced and live* — listeners only need to forward those events to `ChannelStore.postEntry({ type: "status_update", metadata: { kind: "context_threshold", ... } })`.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Parse provider stdout for `usage` | TS adapter (`src/agents/cli-agents.ts`) | — | Adapters are the only place that knows each provider's output shape (`stream-json` for Claude, schema-shaped JSON file for Codex). |
| Plumb `usage` through `AgentResult` | TS domain (`src/domain/agent.ts`) | — | `AgentResultSchema` is the contract every adapter returns; that's the boundary. |
| Compute pct, fire thresholds, persist `budget.jsonl` | TS budget (`src/budget/token-tracker.ts`) | — | Already exists. Nothing to do beyond instantiating one per chat session. |
| Persist usage snapshot for dashboards | TS orchestrator + `~/.relay/sessions/<sessId>/budget.jsonl` | — | Same disk shape as autonomous sessions. Disk is authoritative per `ARCHITECTURE.md` "Disk wins". |
| Read snapshot for display | Rust shared crate (`crates/harness-data`) | — | Single source of truth for TUI + GUI per `AGENTS.md:101-105` cross-dashboard contract. |
| Render percent indicator | TUI + GUI + CLI (three independent surfaces) | — | Each dashboard reads `~/.relay/` independently per `ARCHITECTURE.md` "three views, one source of truth". No coordination at runtime. |
| Emit threshold events to channel feed | TS orchestrator subscriber (forwards `TokenTracker.onThreshold` -> `ChannelStore.postEntry`) | — | Channel feed is the messaging substrate Phase 2 subscribes to. The tracker already debounces per rising edge. |

## Standard Stack

This phase reuses the existing stack — no new dependencies are required.

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `zod` | `^3.24.4` (existing) | Validate the new `usage` field on `AgentResult` | Every cross-process payload in Relay is zod-validated (`src/domain/*.ts`); pattern is locked. [VERIFIED: package.json] |
| `ratatui` | `0.29` (existing) | TUI percent-bar widget | TUI is built on it. `Gauge` and `LineGauge` are stable widgets in 0.29. [VERIFIED: tui/Cargo.toml; ratatui 0.29 changelog] |
| `serde` / `serde_json` | `1` (existing) | Mirror the TS usage shape into `harness-data` | Cross-dashboard contract requires a serde struct alongside any new on-disk shape. [VERIFIED: crates/harness-data/Cargo.toml] |

### Supporting
None. The disk format is JSONL via Node `appendFile` (already used by `TokenTracker`), Rust read via `BufReader::lines()` (already used by `read_session_budget_used`).

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Reusing `~/.relay/sessions/<id>/budget.jsonl` shape | A new `usage.json` per-session doc (single-doc atomic-rename) | Rejected: duplicates a working pipeline. The existing JSONL gives append-safety (atomic POSIX appends < PIPE_BUF, see `token-tracker.ts:380-385`), replay on restart, and the Rust reader already exists. |
| Posting threshold events as a new `ChannelEntryType` | Reusing `type: "status_update"` with `metadata.kind: "context_threshold"` | The `ChannelEntryType` enum in `src/domain/channel.ts:30-46` adds friction for additions (mirror in Rust required). `status_update` is already a sentinel for "neither user nor agent speech"; readers that don't know `metadata.kind` ignore the field gracefully. |
| Exposing usage on `AutonomousSessionState` | A separate `ChatSessionState` Tauri command | Cleaner separation: chat sessions and autonomous sessions are distinct concepts with different lifecycles; conflating them would couple two GUI surfaces that are intentionally independent. |

**Installation:**
```bash
# No new deps. cargo check --workspace + pnpm test to verify the existing wiring after edits.
```

**Version verification:**
- `ratatui = "0.29"` confirmed at `tui/Cargo.toml:14` (verified 2026-05-09).
- `serde = "1"`, `serde_json = "1"` confirmed at `crates/harness-data/Cargo.toml` (verified 2026-05-09).
- `zod ^3.24.4` confirmed at `package.json` (verified 2026-05-09).

## User Constraints

There is no `CONTEXT.md` for this phase yet. The phase definition in `ROADMAP.md` and the kickoff brief constrain scope:

- **Locked surfaces:** TUI, GUI, CLI, all three must show the bar.
- **Locked persistence target:** `~/.relay/` (not in-memory only).
- **Locked thresholds:** 75 / 90 / 95 emitted on the channel feed. **CONFLICT** with the existing `TokenTracker.THRESHOLDS = [50, 60, 85, 95, 100]` in `src/budget/token-tracker.ts:21`. See "Open Questions" #Q1 — this needs an answered before plan-phase.
- **Locked downstream consumer:** Phase 2 (handoff) subscribes to the 90% event. Whatever threshold list ships, 90 must be one of them.
- **Locked dual-provider support:** Claude AND Codex (per acceptance criterion).
- **Locked schema-mirror discipline:** any new TS shape that lands on disk must be mirrored in `crates/harness-data/src/lib.rs` in the same PR per `AGENTS.md:101-105`.

## Phase Requirements

The phase brief enumerates eight surfaces — mapping each to research support:

| ID | Description | Research Support |
|----|-------------|------------------|
| REQ-1 | Per-session token-usage signal in TS orchestrator (Claude / Codex adapters) | `src/agents/cli-agents.ts:84-94` (extend `ParsedProviderResult`); `:347-520` (Claude streaming + buffered paths); `:258-345` (Codex path); see "Token extraction" findings |
| REQ-2 | Persist usage snapshots to `~/.relay/` | Reuse `~/.relay/sessions/<sessId>/budget.jsonl` shape (`src/budget/token-tracker.ts:102`); see "Persistence shape" findings |
| REQ-3 | TUI percent bar in session pane | `tui/src/ui.rs::draw_chat:311` is the hook point; ratatui 0.29 ships `Gauge` / `LineGauge`; see "Dashboards: TUI" |
| REQ-4 | GUI session-detail render + global "worst session" chip | `gui/src/components/AutonomousSessionHeader.tsx` is the prior-art template; `gui/src/components/CenterPane.tsx` for placement; see "Dashboards: GUI" |
| REQ-5 | CLI `rly status` and session listing | `printStatus` in `src/index.ts:2747-2777`; see "Dashboards: CLI" |
| REQ-6 | Threshold events on channel feed at 75 / 90 / 95 | `TokenTracker.onThreshold` (`src/budget/token-tracker.ts:218-223`); `ChannelStore.postEntry` (`src/channels/channel-store.ts:597-628`); see "Threshold events" |
| REQ-7 | Schema/contract single source in TS, mirrored in `crates/harness-data/` | `src/domain/agent.ts` + `crates/harness-data/src/lib.rs`; cross-dashboard contract `AGENTS.md:101-105`; see "Risks" |
| REQ-8 | Vitest scripted-mode + cargo tests | `test/budget/token-tracker.test.ts` (existing pattern); `test/agents/cli-agents-*.test.ts` (adapter tests); `crates/harness-data/src/lib.rs:2310-2440` (Rust loader tests); see "Testing" |

## Architecture Patterns

### System Architecture Diagram

```text
┌─────────────────────────────────────────────────────────────────┐
│ Provider CLI subprocess (claude / codex)                        │
│   Claude:  stdout = stream-json events                          │
│   Codex:   --output-schema writes JSON to a tmp file            │
└────────────────────────────┬────────────────────────────────────┘
                             │ stdout / file
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ src/agents/cli-agents.ts                                        │
│   ClaudeCliAgent.invokeStreaming  → parse `result` + `assistant`│
│   ClaudeCliAgent.invokeProvider   → parse buffered `--output    │
│                                      -format json` body         │
│   CodexCliAgent.invokeProvider    → read response.json          │
│   ── extend ParsedProviderResult.usage ─────────────────────    │
└────────────────────────────┬────────────────────────────────────┘
                             │ AgentResult.tokenUsage (NEW)
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ src/orchestrator/orchestrator-v2.ts::dispatch (~:474)            │
│   on success: tokenTracker.record(input, output)                │
│   tracker is keyed by chat sessionId, not runId                 │
└────────────────────┬────────────────────────────┬────────────────┘
                     │                            │
                     ▼                            ▼
       ~/.relay/sessions/<sessId>/        TokenTracker.onThreshold
       budget.jsonl                       │
       (cumulative + delta lines)         ▼
                     ▲              ChannelStore.postEntry({
                     │                type: "status_update",
                     │                metadata: { kind:
                     │                  "context_threshold",
                     │                  threshold: 90, pct: 91.2,
                     │                  used: ..., total: ... } })
                     │                                │
                     │                                ▼
                     │              ~/.relay/channels/<id>/feed.jsonl
                     │                                │
                     ▼                                ▼
┌─────────────────────────────────────────────────────────────────┐
│ Three views, all reading ~/.relay/ independently                │
│                                                                 │
│ Rust shared: harness-data::load_session_budget(sessionId)       │
│   ├─► TUI (tui/src/ui.rs::draw_chat)  →  ratatui Gauge          │
│   └─► GUI (gui/src-tauri/src/lib.rs)  →  Tauri command          │
│            │                                                    │
│            └─► gui/src/components: ContextWindowBar              │
│                                                                 │
│ TS:  printStatus reads budget.jsonl directly (or a new           │
│      readSessionBudget helper) for `rly status`                 │
└─────────────────────────────────────────────────────────────────┘
```

### Recommended Project Structure
```
src/
├── agents/cli-agents.ts          # ADD usage parsing in ParsedProviderResult
├── domain/agent.ts               # ADD optional tokenUsage field on AgentResult + zod
├── domain/session.ts             # consider: add SessionUsageSnapshot type for the loader contract
├── budget/
│   ├── token-tracker.ts          # NO CHANGE (already exists)
│   ├── session-tracker-pool.ts   # NEW: keyed pool of TokenTracker (one per chat session)
│   └── threshold-feed-bridge.ts  # NEW: subscribes to TokenTracker, posts ChannelEntry
├── orchestrator/
│   └── orchestrator-v2.ts        # ADD: tokenTracker.record() after agent.run() resolves
├── cli/
│   └── status.ts (or inline)     # ADD: read budget.jsonl in printStatus

crates/harness-data/src/lib.rs    # ADD: SessionBudget struct + load_session_budget()
                                  #      (mirror autonomous-session reader)

tui/src/ui.rs                     # ADD: percent bar in draw_chat session header
gui/
├── src-tauri/src/lib.rs          # ADD: get_chat_session_budget Tauri command
├── src/api.ts                    # ADD: getChatSessionBudget(channelId, sessionId)
├── src/types.ts                  # ADD: ChatSessionBudget type
└── src/components/
    └── ContextWindowBar.tsx      # NEW: render the bar (sibling of AutonomousSessionHeader)
```

### Pattern 1: Adapter extracts usage, dispatch persists it

Source pattern: how `RepoAdminSession` already does this (`src/orchestrator/repo-admin-session.ts:448-461`):

```typescript
// Existing prior art for the per-session tracker shape
this.tokenTracker = new TokenTracker(`admin-${this.alias}`, ceiling, {
  rootDir: dirname(this.logDir),
});
this.unsubscribeTokenTracker = this.tokenTracker.onThreshold((evt) =>
  this.handleThresholdEvent(evt)
);
```

Phase 1 mirrors this for chat sessions. The dispatch call site in `orchestrator-v2.ts::dispatch` already wraps `agent.run(request)` in a try/catch — the new code lands in the success branch immediately after `result = await agent.run(request)` (`src/orchestrator/orchestrator-v2.ts:502`).

### Pattern 2: Threshold subscriber posts to channel feed

The `ChannelStore.postEntry` shape is fixed — a status_update with metadata is the canonical low-impact entry type:

```typescript
// Source: src/orchestrator/orchestrator-v2.ts:563-572 — the existing pattern
this.trackChannelPost(
  run,
  this.channelStore.postEntry(run.channelId, {
    type: "status_update",
    fromAgentId: null,
    fromDisplayName: "Orchestrator",
    content: `${eventType} -> ${run.state}`,
    metadata: { runId: run.id, state: run.state, event: eventType },
  })
);
```

Threshold-bridge code mirrors this exactly with `metadata: { kind: "context_threshold", threshold: 90, pct, used, total, sessionId }`. No new entry type needed.

### Pattern 3: Disk-shape mirror across TS and Rust

```rust
// Source pattern: crates/harness-data/src/lib.rs:1268-1295
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChatSession {
    pub session_id: String,
    pub message_count: usize,
    // ...
}
```

Rust struct for `SessionBudget` follows the same shape: `#[serde(rename_all = "camelCase")]`, `#[serde(default)]` on optional fields for back-compat, no `deny_unknown_fields` (would break forward-compat per `CONCERNS.md` "Cross-dashboard contract").

### Anti-Patterns to Avoid

- **Don't define a new `ChannelEntryType` for thresholds.** Adding to `ChannelEntryTypeSchema` (`src/domain/channel.ts:30`) requires a Rust mirror, a writer, a reader, and breaks back-compat for older Rust binaries reading newer feeds. Use `status_update` + `metadata.kind` discriminator instead.
- **Don't poll `feed.jsonl` for the percent bar.** `feed.jsonl` is unbounded (`CONCERNS.md` "Performance Bottlenecks: feed.jsonl re-read"); the dashboards already read it for chat. Add a separate small-file `budget.jsonl` reader so the percent bar is independent of feed size. The autonomous-session pipeline already does this.
- **Don't mutate `ChannelEntry` shape.** Keep new metadata under the existing free-form `metadata: Record<string, unknown>` field (`src/domain/channel.ts:240-246`).
- **Don't write tokens directly into `~/.relay/channels/<id>/sessions.json`.** That's the chat-session index and is read on every render by `crates/harness-data::load_sessions:1316`. Keeping budget data in a sibling file (`~/.relay/sessions/<sessId>/budget.jsonl`) keeps the hot path small and reuses the existing reader pattern.
- **Don't bypass `getRelayDir()`.** Per `ARCHITECTURE.md` "Anti-Patterns: Reading `~/.relay/` from a hot path without caching the path", always go through `getRelayDir()` (`src/cli/paths.ts`) on the TS side and `harness_root()` on the Rust side.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Threshold debouncing | A "did we already fire 90%?" flag | `TokenTracker.firedThresholds` set (`src/budget/token-tracker.ts:68,387-396`) | Already implemented with rising-edge semantics, persistence-aware: `replay()` re-marks crossed thresholds so a process restart never re-fires. |
| Atomic JSONL append | Manual lock + write | `appendFile` from `node:fs/promises` | POSIX guarantees < PIPE_BUF appends are atomic. Already documented at `src/budget/token-tracker.ts:380-385`. |
| Cumulative-total replay | Sum every line on every read | Read the last line's `cumulativeUsed` | The Rust reader already does this in `read_session_budget_used:3111-3135`. The TokenTracker invariant guarantees `cumulativeUsed` is monotonic. |
| Percent-bar widget | A custom block-character renderer | `ratatui::widgets::Gauge` or `LineGauge` | Stable in ratatui 0.29; already supported color-by-style. `LineGauge` matches the inline title-bar aesthetic; `Gauge` is the wider dashboard look. |
| GUI severity tier | A new color enum | Reuse `tokenPctSeverity()` (`gui/src/components/AutonomousSessionHeader.tsx:258-263`) | Returns `ok / warn / hot / overrun`; CSS classes already exist (`metric--tokens-ok`, etc.). |
| Cross-process safety on `budget.jsonl` | A lock file | Accept best-effort within process | `FileHarnessStore` is single-process by design (`ARCHITECTURE.md` "Threading"). Multi-writer is a Postgres backend concern (deferred per ROADMAP). |
| Schema versioning | Skip it | Add an explicit `schemaVersion` field on `SessionBudget` from day 1 | `CONCERNS.md` "Channel state has no schema-version field anywhere (high)" calls this out as a *high-severity* tech-debt item. Phase 2's handoff briefs may live on disk for "a week" — Phase 1 should not perpetuate the missing-versioning pattern. |

**Key insight:** ~85% of this phase is wiring, not invention. The risk is in the invention parts — choosing thresholds (75/90/95 vs the existing 50/60/85/95/100), the schema version, and the chat-session vs autonomous-session boundary. Resolve those in discuss-phase before plan-phase.

## Runtime State Inventory

Not applicable — this is a greenfield additive feature, no rename / refactor / migration.

## Common Pitfalls

### Pitfall 1: Schema drift between TS and Rust silently breaks the dashboards
**What goes wrong:** New required field added to `AgentResult` or `SessionBudget` on the TS side, no matching Rust struct change → TUI or GUI silently shows nothing.
**Why it happens:** Rust serde uses `#[serde(rename_all = "camelCase")]` and (selectively) `#[serde(default)]` — required fields without `default` cause the whole row to fail to deserialize. The `serde_json::from_str(...).ok()` pattern in `load_json` (`crates/harness-data/src/lib.rs:1260-1263`) silently maps that to `None`. No test failure.
**How to avoid:** AGENTS.md mandates same-PR mirror. Defensive practices: use `#[serde(default)]` on every field that isn't strictly required to render. **Add a serde fixture test under `crates/harness-data/src/lib.rs` `mod tests`** (cf. `:2310-2440`) that deserializes a hand-written JSON line representing `SessionBudget` — the test fails if the struct drifts even when no caller exercises the field.
**Warning signs:** PR touches `src/domain/*.ts` but doesn't touch `crates/harness-data/src/lib.rs`. CI's `cargo check --workspace` passes either way (compile-clean code can still drop fields).

### Pitfall 2: Provider's `usage` shape differs across event types in `stream-json`
**What goes wrong:** Claude emits incremental `usage` on each `assistant` event AND a final `result` event. Naively summing all of them double-counts.
**Why it happens:** The Anthropic Messages API streaming convention is that `message_delta` carries deltas; the *final* `result` event in `claude --output-format stream-json` carries the cumulative totals for the whole run. Per official docs ([code.claude.com/docs/en/headless](https://code.claude.com/docs/en/headless)), `--output-format json` includes `total_cost_usd` and per-model breakdown — the structured-output mode bundles this into the response payload.
**How to avoid:** Treat the **`result` event** (or `--output-format json`'s top-level response object) as the single authoritative reading per `agent.run()` call. Ignore mid-stream `assistant.message.usage` for the tracker; record only on `result`. Mid-stream usage can still be surfaced live in the UI by a *separate* path (the streaming renderer), but it must not feed `tracker.record`.
**Warning signs:** Cumulative budget jumping by 2x in one ticket; the `cumulativeUsed` line in `budget.jsonl` outpacing what the model report shows.

### Pitfall 3: Codex doesn't have a stream-json equivalent today
**What goes wrong:** Codex usage extraction is point-in-time, not streaming. The adapter (`src/agents/cli-agents.ts:332`) reads `outputPath` once after the subprocess exits.
**Why it happens:** Codex's `--output-schema` mode writes a single response JSON; mid-run telemetry is unavailable to the adapter today. Per `INTEGRATIONS.md`: "Codex does not have a stream-json equivalent in this adapter; `onStreamLine` is silently ignored for Codex" (`:122`).
**How to avoid:** For Phase 1, accept that the Codex bar updates **per-dispatch** (each `agent.run()`), not mid-run. Document this as a known divergence; it does not block REQ-1 ("read from each provider adapter"). Per [docs.onlinetool.cc/codex/docs/exec.html](https://docs.onlinetool.cc/codex/docs/exec.html), Codex emits `turn.completed` events with `usage: { input_tokens, cached_input_tokens, output_tokens }` — when Codex exposes a streaming schema-output mode in the future, plumb it through `onStreamLine` like Claude.
**Warning signs:** A 5-minute Codex dispatch shows 0% on the bar for 4 minutes 50 seconds, then jumps to 60% at the end.

### Pitfall 4: Mid-stream concurrent appends from multiple sessions in the same process
**What goes wrong:** Two sessions in the same orchestrator process both `record()` simultaneously to *their own* `budget.jsonl` — fine, separate files. But two `record()` calls into the *same* tracker race on the JSONL line.
**Why it happens:** Same-tracker concurrent records are *already serialized* by `TokenTracker.writeChain` (`src/budget/token-tracker.ts:75,148`). Multi-tracker ≠ multi-file conflict.
**How to avoid:** Use a single `TokenTracker` per chat session id, keyed in a `Map<sessionId, TokenTracker>`. The pattern of `RepoAdminSession.ownsTokenTracker` (`src/orchestrator/repo-admin-session.ts:409,439-451`) is the template.
**Warning signs:** Interleaved JSONL lines (each line should be a complete JSON object, lossy `cumulativeUsed`).

### Pitfall 5: `feed.jsonl` torn-read on threshold-event posts
**What goes wrong:** Threshold-bridge posts to `feed.jsonl` while a Rust reader is mid-`read_to_string`. Last line is partial; reader silently skips it (`CONCERNS.md` "Cross-language read-during-write race").
**Why it happens:** TS `appendFile` is atomic per-write but Rust does whole-file reads.
**How to avoid:** This is an existing, accepted tradeoff. Don't reinvent. The threshold event will appear on the next render cycle. Per `CONCERNS.md`: "low priority — append + read-once already self-heals on the next render."
**Warning signs:** Threshold UI flicker — ignore unless reproducible.

## Code Examples

### Pattern 1: Parse Claude `result` event for usage
```typescript
// In src/agents/cli-agents.ts, inside invokeStreaming around line 483.
// Extend processLine to capture obj.usage from the result event.
} else if (obj.type === "result" && typeof obj.result === "string") {
  resultText = obj.result;
  // NEW: usage lives on the result event per Claude Code stream-json spec.
  // Shape per Anthropic Messages API: { input_tokens, output_tokens,
  // cache_creation_input_tokens?, cache_read_input_tokens?, service_tier? }.
  if (obj.usage && typeof obj.usage === "object") {
    capturedUsage = obj.usage as Record<string, number>;
  }
}
```
Source for shape: [platform.claude.com/docs/en/build-with-claude/streaming](https://platform.claude.com/docs/en/build-with-claude/streaming).

### Pattern 2: Parse Codex turn.completed usage
```typescript
// In src/agents/cli-agents.ts, inside CodexCliAgent.invokeProvider after readFile.
const rawResponse = await readFile(outputPath, "utf8");
const parsed = JSON.parse(rawResponse) as {
  // Codex --output-schema mode emits a payload with optional `usage`
  // matching the turn.completed event shape.
  // Per docs.onlinetool.cc/codex/docs/exec.html.
  usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number };
} & Record<string, unknown>;
```
Source: [docs.onlinetool.cc/codex/docs/exec.html](https://docs.onlinetool.cc/codex/docs/exec.html).

### Pattern 3: Tracker pool keyed by chat session
```typescript
// New: src/budget/session-tracker-pool.ts
import { TokenTracker } from "./token-tracker.js";

export class SessionTrackerPool {
  private readonly trackers = new Map<string, TokenTracker>();

  get(sessionId: string, ceiling: number): TokenTracker {
    let tracker = this.trackers.get(sessionId);
    if (!tracker) {
      tracker = new TokenTracker(sessionId, ceiling);
      this.trackers.set(sessionId, tracker);
    }
    return tracker;
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.trackers.values()].map((t) => t.close()));
    this.trackers.clear();
  }
}
```

### Pattern 4: Rust loader for the bar
```rust
// New in crates/harness-data/src/lib.rs (mirror of read_session_budget_used
// from gui/src-tauri/src/lib.rs:3111-3135 — consolidated into harness-data
// so the TUI doesn't have to duplicate it).
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct SessionBudget {
    pub session_id: String,
    pub used: u64,
    pub total: u64,
    pub pct: f64,
    pub last_updated: Option<String>,
}

pub fn load_session_budget(session_id: &str, total: u64) -> SessionBudget {
    let path = harness_root()
        .join("sessions")
        .join(session_id)
        .join("budget.jsonl");
    let used = match fs::File::open(&path) {
        Ok(file) => {
            let mut last: u64 = 0;
            for line in BufReader::new(file).lines().flatten() {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                    if let Some(c) = v.get("cumulativeUsed").and_then(|x| x.as_u64()) {
                        last = c;
                    }
                }
            }
            last
        }
        Err(_) => 0,
    };
    let pct = if total == 0 { 0.0 } else { (used as f64 / total as f64) * 100.0 };
    SessionBudget {
        session_id: session_id.to_string(),
        used,
        total,
        pct,
        last_updated: None,
    }
}
```

### Pattern 5: TUI percent bar in chat header
```rust
// In tui/src/ui.rs::draw_chat (around line 322), after the title.
use ratatui::widgets::{Gauge, LineGauge};

// LineGauge sits cleanly inline with the title bar.
let budget = harness_data::load_session_budget(&session_id, /* model_max */ 200_000);
let gauge = LineGauge::default()
    .filled_style(Style::default().fg(severity_color(budget.pct)))
    .label(format!("ctx {:.0}%", budget.pct))
    .ratio((budget.pct / 100.0).min(1.0).max(0.0));
// Render in a one-line strip below the chat title block.
```
Source: ratatui 0.29 widgets reference.

### Pattern 6: Threshold-feed bridge
```typescript
// New: src/budget/threshold-feed-bridge.ts
import type { ChannelStore } from "../channels/channel-store.js";
import type { TokenTracker, ThresholdEvent } from "./token-tracker.js";

export function attachThresholdFeed(
  tracker: TokenTracker,
  channelId: string,
  channelStore: ChannelStore
): () => void {
  return tracker.onThreshold(async (evt: ThresholdEvent) => {
    try {
      await channelStore.postEntry(channelId, {
        type: "status_update",
        fromAgentId: null,
        fromDisplayName: "Relay",
        content: `Context window at ${Math.round(evt.pct)}%.`,
        metadata: {
          kind: "context_threshold",
          threshold: String(evt.threshold),
          pct: String(evt.pct),
          used: String(evt.used),
          total: String(evt.total),
          sessionId: evt.sessionId,
        },
      });
    } catch (err) {
      // Best-effort, follows orchestrator-v2 trackChannelPost pattern.
      console.error(`[threshold-feed] post failed: ${err}`);
    }
  });
}
```

## Token Extraction (the central unknown)

### Q1: How does Claude Code CLI surface token usage in its output today?

**Buffered mode** (`claude -p --output-format json --json-schema ...`): the response is a single JSON object containing `result`, `session_id`, `usage`, and (since v2.1.x) `total_cost_usd` plus per-model cost breakdown. [CITED: code.claude.com/docs/en/headless — "With `--output-format json`, the response payload includes `total_cost_usd` and a per-model cost breakdown"]. `usage` follows the Anthropic Messages API shape: `{ input_tokens, output_tokens, cache_creation_input_tokens?, cache_read_input_tokens?, service_tier? }`. [VERIFIED: platform.claude.com/docs/en/build-with-claude/streaming]

**Streaming mode** (`stream-json --verbose [--include-partial-messages]`): newline-delimited events. Top-level types include `system`, `assistant`, `user`, `result`, `stream_event`. The `result` event is the **last** event in the stream and carries the canonical totals for the whole run. Per `assistant` event, `message.usage` carries the per-turn delta (Anthropic Messages API convention — `message_start` has cumulative input tokens, `message_delta` has output deltas). [CITED: code.claude.com/docs/en/headless — "Each line is a JSON object representing an event"; platform.claude.com/docs/en/build-with-claude/streaming for the underlying SSE shape]

**Context-window remaining is NOT a separate signal.** It is `model_max - input_tokens` where `model_max` is the model's known context window. As of 2026-05-09: Claude Sonnet 4.5 = 200K standard (1M beta retired), Claude Opus 4.7 = 1M standard. [CITED: support.claude.com/en/articles/8606395, repost.aws/questions/QU636ll_JOQxmoTp9kQblG2Q]

**Recommendation:** Use the **`result` event** in streaming mode (mirroring how the existing adapter already extracts `obj.result` at `cli-agents.ts:483-485`). For the buffered code path (`cli-agents.ts:347-416`), parse `result.stdout`'s top-level `usage` field. Both code paths converge on the same `ParsedProviderResult.usage` shape.

### Q2: How does Codex CLI surface the same?

`codex exec` with `--output-schema` writes the structured response to the file specified by `-o`. The wider event stream (`codex exec --json`) emits `thread.started`, `turn.started`, `turn.completed`, `turn.failed`, `item.*` events. `turn.completed` carries the per-turn usage:

```json
{ "type": "turn.completed", "usage": { "input_tokens": 24763, "cached_input_tokens": 24448, "output_tokens": 122 } }
```

[CITED: docs.onlinetool.cc/codex/docs/exec.html — "Token usage fields include input_tokens, cached_input_tokens, and output_tokens"]

**Cumulative usage across multiple turns is NOT exposed.** Each `turn.completed` reports its own isolated metrics. [CITED: same source — "does not specify where cumulative usage across multiple turns is stored or aggregated"]

The current adapter (`src/agents/cli-agents.ts:258-345`) uses `--output-schema` and reads only the structured-output JSON file, not the JSONL event stream. To extract usage, we must either:

- **Option A (low-cost):** Add `--json` (or whatever the Codex flag is for the JSONL event stream) alongside `--output-schema`, parse the JSONL stream, and capture the last `turn.completed.usage`. Risk: Codex CLI may not allow both modes simultaneously (verify in plan-phase by running `codex exec --help`).
- **Option B (lower risk, less detail):** Keep buffered mode, but check whether `codex exec --output-schema` includes a top-level `usage` field in the schema-shaped JSON file. The phase-brief description "Codex includes a tokenUsage block in its schema-output JSON" suggests this — confirm during plan-phase by running `codex exec` once locally and inspecting the response file.

**Recommendation:** Option B if it works (no protocol change, no event-stream parsing). Otherwise Option A. Defer the choice to plan-phase pending a one-shot live `codex exec` smoke test.

[ASSUMED — needs live verification]: Codex's `response.json` written by `--output-schema` contains a top-level `usage` or `tokenUsage` object alongside the schema-shaped body.

### Q3: Cleanest hook in `cli-agents.ts` to call `tracker.record()`?

**Don't call `tracker.record()` from inside the adapter.** The adapter's job is to *parse* `usage` and return it on `AgentResult`. The orchestrator's `dispatch()` is where `record()` belongs because:

1. The adapter doesn't know which session/tracker to record into. The orchestrator owns the `SessionTrackerPool`.
2. Tests for the adapter should be able to assert on the parsed `usage` shape without spinning up a tracker — keeps the adapter unit testable.
3. The dispatch layer already has a try/catch around `agent.run()` (`orchestrator-v2.ts:501-545`) — record happens in the success branch.

**The TokenTracker accepts normalized inputs:** `record(inputTokens: number, outputTokens: number)` (`token-tracker.ts:126`). Both providers return integers in those names — no normalization needed beyond mapping `input_tokens -> inputTokens`. Cache tokens (`cache_creation_input_tokens`, `cache_read_input_tokens`, `cached_input_tokens`) should be **added to inputTokens** for percent-of-context purposes, since they all consume the same context window. [VERIFIED: Anthropic prompt-caching docs — cache reads still occupy context]

### Q4: Where does each provider's max context window come from?

**Claude:** Hard-coded per model. The `--model` flag in `cli-agents.ts:382-384` is the discriminator. There's no API call that returns "what's my context window" — Relay must keep a small lookup table. As of 2026-05-09: Sonnet 4.5 = 200_000, Opus 4.7 = 1_000_000.

**Codex:** Same situation — hard-coded per model. The Codex CLI doesn't surface context window in its events.

**Recommendation:** Add `src/domain/model-context-windows.ts` with a `MODEL_CONTEXT_WINDOWS: Record<string, number>` table. Default to a conservative 200K when the model isn't recognized. The `model` field on `Agent` (`src/domain/agent.ts:79-85`) is already the key. Plan a follow-up to make this configurable via `provider-profiles.json` for users on third-party endpoints (OpenRouter, Bedrock, Vertex) where `--model` may not match a known string.

[VERIFIED: code.claude.com/docs/en/model-config; verified context windows above as of 2026-05-09]

## Persistence Shape

### Q5: Where in `~/.relay/` should per-session usage snapshots live?

**Recommendation:** Reuse `~/.relay/sessions/<sessionId>/budget.jsonl` exactly as `TokenTracker` already writes it.

Rationale:
- TokenTracker already writes there (`src/budget/token-tracker.ts:102`).
- The Tauri backend already reads there (`gui/src-tauri/src/lib.rs:3121` — `autonomous_sessions_root().join(session_id).join("budget.jsonl")`).
- The append-only JSONL gives free durability + replay on restart.
- Per-session directory under `sessions/` matches the autonomous-loop convention; chat session ids (`sess-<ms>` per `STRUCTURE.md` "ID prefixes") and autonomous session ids (`auto-<ms>-<rand>`) are namespaced enough not to collide.

**Caveat:** The autonomous-session reader in `gui/src-tauri/src/lib.rs` looks at `autonomous_sessions_root()` which is presumably `~/.relay/sessions/`. Phase 1 needs `harness-data` to expose a generic `load_session_budget(session_id)` rather than the GUI-only autonomous-only path. Move that reader from `gui/src-tauri/src/lib.rs:3111-3135` into `crates/harness-data/src/lib.rs` so the TUI can also use it without duplication.

[VERIFIED — file path live in code at `gui/src-tauri/src/lib.rs:3121`]

### Q6: Smallest schema for a usage snapshot

The per-line shape already exists in `TokenTracker`:
```typescript
// src/budget/token-tracker.ts:41-46
interface BudgetLine {
  ts: string;
  inputTokens: number;
  outputTokens: number;
  cumulativeUsed: number;
}
```

The **derived snapshot** the dashboards consume is what needs a new shape. Recommended minimal:

```typescript
// src/domain/session.ts (or new src/domain/session-budget.ts)
export interface SessionBudget {
  schemaVersion: 1;            // CONCERNS.md tech-debt-#2 — start versioned
  sessionId: string;
  used: number;                // cumulative input + output across all records
  total: number;               // model context window
  pct: number;                 // (used / total) * 100, NOT clamped
  lastUpdated?: string;        // ISO from the last appended line
  modelName?: string;          // for display ("Sonnet 4.5")
}
```

Rust mirror in `crates/harness-data/src/lib.rs`:
```rust
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct SessionBudget {
    #[serde(default = "default_schema_version")]
    pub schema_version: u32,
    pub session_id: String,
    pub used: u64,
    pub total: u64,
    pub pct: f64,
    #[serde(default)]
    pub last_updated: Option<String>,
    #[serde(default)]
    pub model_name: Option<String>,
}
fn default_schema_version() -> u32 { 1 }
```

**`schemaVersion` rationale:** Per `CONCERNS.md` "Channel state has no schema-version field anywhere (high)", every persisted root type should adopt the convention. Phase 1 is a clean greenfield surface to start that practice. Phase 2's handoff briefs depend on this.

### Q7: Safe append + read across TS/Rust — existing pattern

There is **no shared append-and-read library**; the convention is:
- TS writers use `appendFile` for JSONL (`src/budget/token-tracker.ts:384`, `src/channels/channel-store.ts:622`). POSIX guarantees < PIPE_BUF (typically 4096 bytes — way more than a token-tracker line) appends are atomic, so concurrent same-process writes don't interleave.
- Rust readers use `BufReader::lines().flatten()` and call `serde_json::from_str(...).ok()` on each line — malformed lines are silently dropped. See `crates/harness-data/src/lib.rs:1011-1015` (channel feed), `gui/src-tauri/src/lib.rs:3126-3133` (budget reader).
- The "torn last line" race (`CONCERNS.md` "Cross-language read-during-write race on `feed.jsonl`") is **accepted** — the next render cycle re-reads and recovers. Don't reinvent.

Don't introduce locks. Don't switch to atomic-rename for append-only files (would defeat the append optimization). Mirror the existing pattern exactly.

## Threshold Events

### Q8: Where do channel-feed events get emitted today?

The single canonical write path is `ChannelStore.postEntry(channelId, { type, fromAgentId, fromDisplayName, content, metadata })` (`src/channels/channel-store.ts:597-628`). It appends one JSON line to `feed.jsonl` and calls `touchChannel` to bump activity.

Concrete examples currently in the codebase:

```typescript
// src/orchestrator/orchestrator-v2.ts:563-572 — orchestrator state transition
await this.channelStore.postEntry(run.channelId, {
  type: "status_update",
  fromAgentId: null,
  fromDisplayName: "Orchestrator",
  content: `${eventType} -> ${run.state}`,
  metadata: { runId: run.id, state: run.state, event: eventType },
});

// src/channels/channel-store.ts:560-567 — agent joined
await this.postEntry(channelId, {
  type: "agent_joined",
  fromAgentId: member.agentId,
  fromDisplayName: member.displayName,
  content: `${member.displayName} joined the channel.`,
  metadata: { role: member.role, provider: member.provider },
});
```

**Recommendation:** Mirror exactly. Use `type: "status_update"`, set `metadata.kind: "context_threshold"`, fill in `threshold / pct / used / total / sessionId`. Phase 2 subscribes by reading `feed.jsonl` and filtering on `metadata.kind === "context_threshold"` and `metadata.threshold === "90"`.

### Q9: Edge cases for threshold events

**Already handled by `TokenTracker`:**

- *Rising-edge only:* `findCrossedThresholds` (`src/budget/token-tracker.ts:387-396`) only adds a threshold to the crossed list when `pctAt(previousUsed) < threshold && pctAt(currentUsed) >= threshold`. A value bouncing around 90% never re-emits.
- *Once per tracker lifetime:* `firedThresholds` Set (`:68`) plus `replay()` on construct (`:371-375`) ensure that even after a process restart, already-crossed thresholds don't re-fire.
- *Atomic ordering:* Threshold events fire **before** the JSONL append (`:157-167`), so a listener that reads `tracker.used` synchronously sees the post-record state.

**Not handled (intentional):**

- *Reset on memory-shed cycle:* `tracker.reset()` (`src/budget/token-tracker.ts:282-304`) clears `firedThresholds` so a recycled session can re-fire all thresholds. **Phase 1 chat sessions don't recycle**, so reset is irrelevant. Phase 2's handoff is conceptually a session boundary — when a session ends, its tracker is closed and a new tracker is constructed for the new session, with its own clean `firedThresholds`.

**Recommendation:** Use the existing semantics as-is. No debouncing logic needed beyond what TokenTracker already provides. The threshold-feed bridge (Pattern 6) is a thin best-effort listener.

## Dashboards

### Q10: TUI inline-indicator widgets

`tui/src/ui.rs` does not yet use any percent-bar widget. Existing patterns (all in `ui.rs`):
- Title-bar text: `Block::default().title(...)` with formatted strings, e.g. `format!(" Chat{}{}{} ", ...)` at `:322`.
- Color severity: `Style::default().fg(Color::Cyan)` etc. throughout `draw_chat` (`:311-569`).
- Compact inline metrics in lists: `Span::styled(pad_right(...), Style::default().fg(Color::DarkGray))` at `:836`.

ratatui 0.29 ships two relevant widgets:
- **`ratatui::widgets::Gauge`** — full-width block-character bar with optional percent label.
- **`ratatui::widgets::LineGauge`** — single-line bar that composes inside a header. Better fit for the chat-pane header.

**Recommendation:** `LineGauge` rendered as a one-line strip immediately below the chat header block (or inline in the title bottom — `title_bottom` is already used at `:329` for the tab bar). Color via the same severity tiers as `tokenPctSeverity`: cyan/green for OK, yellow for warn, red for hot, magenta-ish for overrun. No new style — reuse the chat-header `Style::default().fg(Color::Cyan)` / `Color::Yellow` / `Color::Red` palette already in use throughout `ui.rs`.

[VERIFIED — `tui/src/ui.rs:1-3` imports `widgets::*` so both `Gauge` and `LineGauge` are accessible without dep changes; ratatui 0.29 is in `tui/Cargo.toml`]

### Q11: GUI session-detail rendering

The existing prior art is `gui/src/components/AutonomousSessionHeader.tsx` (149 lines) — exact pattern Phase 1 should follow:

- Polls the Tauri backend on a `refreshTick` interval-bumped prop (App runs a 5s interval per the comment at `:13-15`).
- Renders inside CenterPane below the channel header.
- Uses `tokenPctSeverity()` to map pct → CSS class (`metric--tokens-ok / -warn / -hot / -overrun`).
- Shows "tokens X / Y (Z%)" + a kill button.

**Recommendation:** Create `gui/src/components/ContextWindowBar.tsx` as a sibling of `AutonomousSessionHeader.tsx`. Render it inside `CenterPane.tsx` beneath the chat session header. Reuse the existing CSS classes — no new tokens.

For the **global "worst session" chip** in REQ-4: add a sidebar component (e.g. `gui/src/components/Sidebar.tsx` already lists channels — extend it with a small status pill near the channel name when `pct >= 75`). Or render in `App.tsx`'s top-bar, beside the existing UpdateBanner. The Tauri command `list_chat_session_budgets()` (new) returns one row per active chat session; React picks `max(pct)`.

Files cited:
- `gui/src/components/AutonomousSessionHeader.tsx` — template.
- `gui/src/components/CenterPane.tsx` — placement parent.
- `gui/src/api.ts:235-236` — Tauri command wrapper convention.
- `gui/src/types.ts:312-330` — `AutonomousSessionState` shape mirror.

### Q12: CLI `rly status` structure

`printStatus` lives at `src/index.ts:2747-2777`. Currently emits:
```
Workspace: <cwd>
Global root: <getGlobalRoot()>
Workspace dir: <paths.rootDir>
Artifacts dir: <paths.artifactsDir>
Runs index path: <paths.runsIndexPath>

Service state: <status.state>
Version: <version>
Updated: <updatedAt>

Recent runs:
- <runId> state=<state> updated=<updatedAt> ledger=<ledgerPath>
```

**Recommendation:** Add a new `Active sessions:` block before `Recent runs:`. For each active chat session (read by enumerating `~/.relay/sessions/<id>/budget.jsonl` files with recent mtime, or read the `~/.relay/channels/<id>/sessions.json` indexes and join), print one line:

```
- sess-1762634000123 (channel: ch-relay-rebrand) ctx 76% (152K / 200K tokens) — Sonnet 4.5
```

Color per severity (no color in non-TTY — there's no shared color helper in `src/cli/`, only `NO_COLOR` env-respecting prints scattered through `src/cli/stream-activity-renderer.ts`). Keep it plain text in `printStatus` to start; color polish can come in a follow-up.

For session listing: `src/index.ts:148` routes `command === "session"` to `handleSessionCommand`. The session subcommand should add a `--with-context` flag (or always include) showing the bar.

## Testing

### Q13: Provider adapter testing in scripted mode

Existing pattern files:
- `test/budget/token-tracker.test.ts` (canonical for tracker behaviour — exercises threshold ordering, replay, reset).
- `test/agents/cli-agents-env-overlay.test.ts`, `cli-agents-full-access.test.ts`, `cli-agents-role-lockdown.test.ts` (canonical for adapter args + env shape).

These adapter tests use a hand-rolled fake invoker: they stub `ScriptedInvoker`-style behaviour via a fake `CommandInvoker`. The `ScriptedInvoker` (`src/simulation/scripted-invoker.ts`) emits deterministic JSON keyed off the prompt's `Work kind` field — it does **not** simulate stream-json. For Phase 1 tests:

**Recommendation:**
- Adapter tests for usage extraction inject a fake invoker that emits a hand-written `result` event (Claude path) or writes a hand-written `response.json` (Codex path). Assert on `parsed.usage`.
- The `ScriptedInvoker` itself can be **extended** to optionally emit a usage block on its synthetic responses — useful for end-to-end orchestrator tests that want to assert a tracker recorded something. Defer this to plan-phase; minimum viable is per-adapter test coverage.

Existing `test/agents/cli-agents-*.test.ts` files do not currently exercise the streaming path's stdout parsing because `ScriptedInvoker.spawn` doesn't exist. Phase 1 needs to either:
- (a) Add a `FakeStreamingInvoker` that implements `spawn()` (returns a mock handle that emits canned chunks), or
- (b) Test the `processLine` parser as a pure exported function (extract it from `invokeStreaming`).

Option (b) is cleaner. The `processLine` arrow inside `invokeStreaming` (`cli-agents.ts:460-486`) closes over `accumText`, `resultText`, `onLine` — refactor to a pure helper `parseStreamLine(line: string, state: StreamState): void` that's directly unit-testable.

### Q14: Rust display tests

`crates/harness-data/src/lib.rs:2310-2440` is the canonical pattern for Rust readers. Each test:
- Calls `scoped_root()` (a test helper that overrides `HARNESS_HOME` to a tempdir).
- Writes a hand-crafted JSON / JSONL file.
- Calls the loader.
- Asserts on the returned struct.

```rust
// Example pattern from crates/harness-data/src/lib.rs:2310-2325
#[test]
fn load_approval_queue_parses_jsonl_file() {
    let _guard = scoped_root();
    let session = "sess-load";
    let path = approval_queue_path(session);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let line1 = r#"{"id":"apv-1", ...}"#;
    let line2 = r#"{"id":"apv-2", ...}"#;
    fs::write(&path, format!("{}\n{}\n", line1, line2)).unwrap();
    let records = load_approval_queue(session);
    assert_eq!(records.len(), 2);
}
```

**Recommendation:** Add tests for `load_session_budget` mirroring this pattern: write fake `budget.jsonl` lines, verify last-`cumulativeUsed`-wins, malformed-line skipping, missing file → zeros. **No snapshot tests** — `TESTING.md` calls them out as banned for orchestrator output, and the same applies here.

For the TUI render layer: `tui/src/ui.rs` has no tests today (`grep -n "#\[test\]" tui/src/ui.rs` returns zero hits). Phase 1 should not block on adding TUI render tests. Compile-check via `cargo check --workspace --locked` is the existing gate. If Phase 1 wants render-correctness coverage, the canonical pattern is to extract pure logic functions (e.g. `severity_color(pct: f64) -> Color`) and unit-test those with `#[test]` blocks, **not** snapshot the whole frame.

## Risks

### Q15: TS/Rust schema drift mitigation

Per `CONCERNS.md` "Cross-dashboard contract: `src/domain/` ↔ `crates/harness-data/src/lib.rs` (high)" — there is **no codegen, no automated mirror check, no sync test**. The mitigation is convention only:

1. `AGENTS.md:101-105` mandates same-PR mirror.
2. `cargo check --workspace --locked` + `cargo test --workspace` in CI catch *deserialization* failures *if a test exercises the field*.
3. `#[serde(deny_unknown_fields)]` is **not** used (it would break forward-compat).
4. Selective `#[serde(default)]` is used on optional fields.

**Phase 1 mitigations beyond the convention:**

1. **Add a serde fixture test** under `crates/harness-data/src/lib.rs::tests` that hand-writes a `SessionBudget` JSON line covering every field, including the `schemaVersion`. The test deserializes and asserts every field round-trips. If a TS-side rename happens without a Rust mirror, the test fails because the JSON-with-old-camelCase no longer matches.

2. **Add a TS-side test** under `test/domain/session-budget.test.ts` that round-trips a sample object through `JSON.stringify` + `JSON.parse` + zod parse, AND writes the resulting JSON to a file the Rust test fixture reads. Out-of-scope for Phase 1 unless cheap.

3. **Document the schemaVersion contract** in a comment at the top of `src/domain/session-budget.ts`: bumping the version means a same-PR Rust update AND a forward-migration helper.

### Other risks

- **Codex usage shape uncertain.** Resolve by running `codex exec --help` + a one-shot smoke test in plan-phase. (`research_questions Q2 Option B` — needs verification.)
- **Threshold values 75/90/95 vs 50/60/85/95/100 conflict.** See "Open Questions" Q1.
- **Model context window lookup table.** The lookup table is fragile (Anthropic changes models often). Mitigate by defaulting to a conservative 200K when the model isn't recognized, and emitting a warning to stderr ("Unknown model X, assuming 200K context window"). This is a known follow-up — accept for v1.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js / pnpm | TS code paths | ✓ (assumed — repo has `pnpm-lock.yaml`) | 22+ | — |
| Rust toolchain | TUI / GUI / harness-data | ✓ (assumed) | edition 2021 | — |
| `claude` CLI | live-mode token-extraction smoke tests | unknown | — | Tests run in scripted mode by default; live verification deferred to manual smoke |
| `codex` CLI | same | unknown | — | Same |
| ratatui 0.29, serde 1, serde_json 1, zod 3.24+ | already in deps | ✓ | as cited | — |

**Missing dependencies with no fallback:** none — phase is additive against existing deps.
**Missing dependencies with fallback:** live `claude` / `codex` smoke testing during plan-phase Q2 verification can be performed by the user manually if not available in CI.

## Validation Architecture

Including (no `nyquist_validation: false` set).

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest 3.2.4 (TS); cargo test (Rust); vitest 3.2.4 + jsdom (GUI frontend) |
| Config file | `vitest.config.ts` (root); `gui/vitest.config.ts` (frontend); `crates/harness-data/Cargo.toml` (Rust); `tui/Cargo.toml`; `gui/src-tauri/Cargo.toml` |
| Quick run command | `pnpm test test/budget/token-tracker.test.ts test/agents/cli-agents-env-overlay.test.ts` |
| Full suite command | `pnpm test && pnpm typecheck && pnpm build && cargo check --workspace --locked && cargo test --workspace` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|--------------|
| REQ-1 (Claude usage parse) | `processLine`/buffered parser captures `usage` from `result` event | unit | `pnpm test test/agents/cli-agents-usage.test.ts` | Wave 0 |
| REQ-1 (Codex usage parse) | adapter reads `usage` from response.json (or JSONL stream) | unit | `pnpm test test/agents/cli-agents-codex-usage.test.ts` | Wave 0 |
| REQ-1 (AgentResult plumbing) | `AgentResult.tokenUsage` round-trips through orchestrator dispatch | unit | `pnpm test test/orchestrator/orchestrator-v2-token-usage.test.ts` | Wave 0 |
| REQ-2 (persistence) | Tracker `record()` writes JSONL with `cumulativeUsed`; replay on restart resumes | unit | `pnpm test test/budget/token-tracker.test.ts` | EXISTS — already covers 100% of this surface |
| REQ-3 (TUI bar) | `severity_color()` pure function returns correct color tier | unit | `cargo test -p relay-tui` | Wave 0 (extract pure helper from ui.rs) |
| REQ-4 (GUI bar) | `ContextWindowBar` renders pct + severity class; uses `tokenPctSeverityForTesting` | unit | `cd gui && pnpm test ContextWindowBar.test.tsx` | Wave 0 |
| REQ-4 (Tauri loader) | `get_chat_session_budget` reads `budget.jsonl` and returns the right pct | unit | `cargo test -p relay-gui get_chat_session_budget` | Wave 0 |
| REQ-5 (CLI status) | `printStatus` includes active-session block | unit | `pnpm test test/cli/print-status.test.ts` | Wave 0 (no test file exists for printStatus today — verified by `grep`) |
| REQ-6 (threshold->feed) | Threshold event posts a `status_update` ChannelEntry with `metadata.kind=context_threshold` | unit | `pnpm test test/budget/threshold-feed-bridge.test.ts` | Wave 0 |
| REQ-7 (schema mirror) | TS `SessionBudget` ↔ Rust `SessionBudget` round-trip via JSON | unit | `cargo test -p harness-data load_session_budget` | Wave 0 |
| REQ-7 (schema fixture) | Hand-written JSON line deserializes to expected struct | unit | `cargo test -p harness-data session_budget_serde_fixture` | Wave 0 |
| REQ-8 | All above pass under default scripted mode | suite | `pnpm test && cargo test --workspace` | EXISTS |

### Sampling Rate
- **Per task commit:** `pnpm test test/<area>/<file>.test.ts` (the just-touched test).
- **Per wave merge:** `pnpm test && cargo test --workspace` (full TS + Rust suite).
- **Phase gate:** `pnpm test && pnpm typecheck && pnpm build && cargo check --workspace --locked && cargo test --workspace && cd gui && pnpm test` — all green before `/gsd-verify-work`.

### Wave 0 Gaps
- [ ] `test/agents/cli-agents-usage.test.ts` — REQ-1 Claude side. New file; must mock the streaming invoker.
- [ ] `test/agents/cli-agents-codex-usage.test.ts` — REQ-1 Codex side. New file.
- [ ] `test/orchestrator/orchestrator-v2-token-usage.test.ts` — REQ-1 plumbing. New file.
- [ ] `test/budget/threshold-feed-bridge.test.ts` — REQ-6. New file.
- [ ] `test/cli/print-status.test.ts` — REQ-5. **No test file currently exists for `printStatus`** (verified by find). New file. Should at minimum unit-test the helper that formats the active-sessions block; can use a fake artifactStore + tmp `~/.relay/`.
- [ ] `gui/src/components/ContextWindowBar.test.tsx` — REQ-4. New file (mirror `AutonomousSessionHeader.test.tsx`).
- [ ] `crates/harness-data/src/lib.rs::tests::session_budget_*` — REQ-7. New `#[test]` block at the bottom of `lib.rs`, alongside the existing fixture tests at `:2310-2440`.

## Project Constraints (from CLAUDE.md / AGENTS.md)

Key constraints that affect this plan:

1. **`AGENTS.md:101-105` cross-dashboard contract.** Any `src/domain/*.ts` change requires a same-PR `crates/harness-data/src/lib.rs` mirror. Run `cargo check --workspace` AND `cargo test --workspace` before pushing.
2. **`AGENTS.md:50` scripted mode is default.** Tests must run with `HARNESS_LIVE` unset; live tests sit in `describe.skip`.
3. **`AGENTS.md:111-113` feed.jsonl is append-only.** Threshold-feed bridge must use `postEntry`, never rewrite.
4. **`AGENTS.md:120` `withEnvOverride` non-reentrant.** Not directly relevant to Phase 1 (no env-var manipulation expected) — flagged for completeness.
5. **`AGENTS.md:121` Linux/Windows GUI spawn paths device-test gated.** Not relevant — Phase 1 doesn't touch spawn.
6. **`CLAUDE.md` "Git Workflow — Non-Negotiable Rules"** — but note this is the user's *global* CLAUDE.md aimed at the TuringOn repos. The Relay-specific `./CLAUDE.md` defers entirely to `AGENTS.md`. The git-workflow rules in the global file apply to TuringOn repos, not Relay (Relay uses changesets and direct PR flow per `CONTRIBUTING.md`). Confirm in plan-phase.
7. **No drive-by reformats** (`AGENTS.md`).
8. **Always go through `getRelayDir()` / `harness_root()`** for `~/.relay/` paths.
9. **`pnpm` is the package manager.** Never `npm install` / `yarn add`.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Hand-rolled per-line streaming parsers | Claude `--output-format stream-json --verbose --include-partial-messages` | Documented in current Claude Code docs (verified 2026-05-09) | Token-level streaming requires all three flags; missing `--include-partial-messages` means no `stream_event` token deltas. |
| Sonnet 4.5 1M-context beta | Retired; back to 200K standard | Recent (verified 2026-05-09) | Don't hard-code 1M for Sonnet 4.5; only Opus 4.7 has 1M. |

**Deprecated/outdated:**
- The Claude Code "headless mode" terminology is now "Agent SDK CLI mode" — same flags, different name. (`code.claude.com/docs/en/headless` notes the rename.)

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Codex `--output-schema` response.json contains a top-level `usage` or `tokenUsage` block alongside the schema-shaped body | Token Extraction Q2 | Plan would need an extra task to switch Codex to `--json` JSONL stream parsing. Resolve in plan-phase via one-shot `codex exec` smoke. |
| A2 | TUI's `cargo test` workspace doesn't currently test `ui.rs` rendering — extracting pure helpers + adding `#[test]` blocks is acceptable per existing convention | Testing Q14 | Low — verified by grep; convention is to embed `#[cfg(test) mod` blocks. Confirmed by existing pattern in `gui/src-tauri/src/lib.rs::tests::get_session_state_computes_budget_pct_and_hours_remaining` at `:3868`. |
| A3 | Cache tokens (`cache_creation_input_tokens`, `cache_read_input_tokens`) should be summed into `inputTokens` for context-window percent | Token Extraction Q3 | Wrong direction would either over-report or under-report context usage. Anthropic prompt-caching docs confirm cache reads still occupy context, so this is the safe direction. |
| A4 | Chat session ids (`sess-<ms>`) and autonomous session ids (`auto-<ms>-<rand>`) don't collide under `~/.relay/sessions/` | Persistence Q5 | Verified at `STRUCTURE.md` "ID prefixes" — distinct prefixes by convention. Risk if a future session-id scheme changes; mitigated by using session-id-as-directory throughout. |
| A5 | `RELAY_HOME` overrides reach the autonomous-session reader correctly so test fixtures work | Testing Q14 | Verified by existing `scoped_root()` test helper in `crates/harness-data/src/lib.rs`. |
| A6 | The Relay-specific `./CLAUDE.md` (which defers to `AGENTS.md`) governs this work, not the user's global CLAUDE.md (which is TuringOn-focused) | Project Constraints | High if wrong — would require git-workflow ceremony (worktrees per branch, no auto-merge). The Relay project CLAUDE.md says `agents.md` convention — verifying with the user is cheap and worth doing. |

## Open Questions

1. **Q1: Threshold values — 75/90/95 or 50/60/85/95/100?**
   - What we know: ROADMAP and the kickoff brief specify `75 / 90 / 95` for the channel-feed events. The existing `TokenTracker.THRESHOLDS` is `[50, 60, 85, 95, 100]`.
   - What's unclear: do we *change* `THRESHOLDS` (breaking the 60% memory-shed signal `RepoAdminSession` already subscribes to per `src/orchestrator/repo-admin-session.ts:454-461`), or do we add 75 and 90 to the list (resulting in `[50, 60, 75, 85, 90, 95, 100]` and the threshold-feed bridge filtering to `{75, 90, 95}` for what gets posted to the channel)?
   - Recommendation: **add** to the canonical list; filter in the bridge. The existing subscribers (memory-shed at 60) keep working; the bridge subscribes to *all* events but only posts the user-visible subset to the channel. Confirm in discuss-phase.

2. **Q2: Per-session vs per-channel telemetry boundary.**
   - What we know: a chat session is one `sess-<ms>` per channel; a channel can have many sessions over time.
   - What's unclear: the bar surfaces "the active session's context" — is there always exactly one active chat session per channel, or do we need to track multiple?
   - Recommendation: per-session is the natural unit (matches `TokenTracker`'s key shape). The TUI/GUI's "active session" concept (`active_session: Option<ChatSession>` in `tui/src/main.rs`) gives a single read. Confirm.

3. **Q3: Multi-provider sessions in one channel.**
   - What we know: each `agent.run()` is keyed by an `AgentProvider` (`claude` / `codex`).
   - What's unclear: when a channel switches providers mid-session (Phase 2 handoff), does the bar reset?
   - Recommendation: yes — handoff creates a NEW session id, so the new tracker starts at 0%. Phase 2's design depends on this.

4. **Q4: Chat-session vs run-orchestrator hook point.**
   - What we know: `OrchestratorV2.run` is the run-level pipeline; `rly chat` is a separate session-style code path.
   - What's unclear: the dispatch hook in `orchestrator-v2.ts:474` covers run mode; does the chat-mode code path also dispatch through `agent.run()`? `src/cli/chat-context.ts` and `src/cli/session-store.ts` are the chat-mode owners.
   - Recommendation: trace the chat-mode call site in plan-phase. Both code paths need the tracker hook.

5. **Q5: Model context window discovery.**
   - What we know: hard-coded per model. Sonnet 4.5 = 200K, Opus 4.7 = 1M.
   - What's unclear: should the lookup table be in `src/domain/`, in a separate `src/budget/model-context-windows.ts`, or driven by `provider-profiles.json`?
   - Recommendation: start with a const table in `src/domain/model-context-windows.ts` (zod-validated keys = known model strings, value = number). Provider-profile-driven follows once the bar ships. Confirm.

6. **Q6: Schema versioning rollout.**
   - What we know: `CONCERNS.md` flags missing schemaVersion as high-severity tech debt.
   - What's unclear: scope creep — is Phase 1 the right place to introduce a schemaVersion convention for one new shape, or should we land a separate "introduce schemaVersion convention everywhere" phase first?
   - Recommendation: Phase 1 introduces it on `SessionBudget` only (cheap, scoped, sets a precedent). A future phase migrates other shapes.

## Sources

### Primary (HIGH confidence — directly cited from this codebase)
- `src/agents/cli-agents.ts:84-94, :258-345, :347-520` — adapter shape, both code paths, the gap.
- `src/budget/token-tracker.ts:21, :41-46, :63-75, :126-186, :282-304, :371-396` — TokenTracker API.
- `src/orchestrator/repo-admin-session.ts:408-461` — prior-art per-session tracker pattern.
- `src/orchestrator/orchestrator-v2.ts:474-549, :563-572` — dispatch hook + channel-post pattern.
- `src/channels/channel-store.ts:597-628` — postEntry shape.
- `src/domain/agent.ts:68-85, :108-115` — `AgentResult`, `AgentResultSchema`.
- `src/domain/channel.ts:30-46, :240-246` — ChannelEntryType, ChannelEntry.
- `crates/harness-data/src/lib.rs:1268-1382, :2310-2440` — Rust loader + test patterns.
- `gui/src-tauri/src/lib.rs:3020-3045, :3105-3239` — autonomous-session prior art (state, budget reader, command).
- `gui/src/components/AutonomousSessionHeader.tsx` (full file) — GUI prior-art template.
- `gui/src/types.ts:309-330` — `AutonomousSessionState`.
- `tui/src/ui.rs:1-3, :311-569` — TUI imports + chat draw.
- `src/index.ts:103-105, :2747-2777` — `printStatus`.
- `.planning/codebase/ARCHITECTURE.md` (full file).
- `.planning/codebase/CONCERNS.md:11-16, :18-23, :130-135, :202-205, :248-253` — verifies the gap, schema-version risk, schema-drift risk, the missing tracker tests.
- `.planning/codebase/INTEGRATIONS.md:9, :116-126` — Codex stream behaviour, integration auth.
- `.planning/codebase/STRUCTURE.md:193, :256-264` — budget directory + ID prefixes.
- `.planning/codebase/TESTING.md` (full).
- `.planning/codebase/CONVENTIONS.md` (sampled).
- `.planning/notes/handoff-feature-design.md` — Phase 2 dependency context.
- `AGENTS.md:101-105, :111-113` — cross-dashboard + feed contracts.

### Secondary (MEDIUM-HIGH confidence — official vendor docs)
- [Claude Code: Run Claude Code programmatically](https://code.claude.com/docs/en/headless) — `--output-format json` includes `total_cost_usd` + per-model breakdown; stream-json events.
- [Anthropic Messages API: Streaming messages](https://platform.claude.com/docs/en/build-with-claude/streaming) — `usage` shape, message_start vs message_delta semantics.
- [Codex CLI: Non-interactive mode](https://docs.onlinetool.cc/codex/docs/exec.html) — `turn.completed.usage = { input_tokens, cached_input_tokens, output_tokens }`.
- [Anthropic Help: How large is the Claude API's context window?](https://support.claude.com/en/articles/8606395-how-large-is-the-claude-api-s-context-window) — 200K standard.
- [AWS re:Post: 1M context for Sonnet 4.5 on Bedrock](https://repost.aws/questions/QU636ll_JOQxmoTp9kQblG2Q) — 1M Sonnet 4.5 beta retired.
- [Background Claude blog: stream-json output format](https://backgroundclaude.com/blog/stream-json) — event-stream overview.

### Tertiary (LOW confidence — informational only)
- [tokscale (junhoyeo/tokscale)](https://github.com/junhoyeo/tokscale) — third-party CLI for tracking token usage; useful for shape sanity but not authoritative.
- [ccusage Codex guide](https://ccusage.com/guide/codex/) — community Codex usage parser; same caveat.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — every dep cited from existing `Cargo.toml` / `package.json`; no new deps proposed.
- Architecture / hook points: HIGH — every line cited with file:line references against current source.
- Provider parsing (Claude): HIGH for `result` event semantics (official docs) and the buffered `--output-format json` shape; MEDIUM for the exact stream-json layering of usage on `assistant` vs `result` (cross-confirmed across 3 sources).
- Provider parsing (Codex): MEDIUM — `turn.completed` shape is documented; whether `--output-schema` mode also surfaces `usage` is ASSUMED (A1) and needs a one-shot live verification in plan-phase.
- Pitfalls: HIGH — concerns surfaced from `CONCERNS.md` cross-referenced with source.
- Testing: HIGH — patterns cited from existing test files.
- Threshold semantics: HIGH — `TokenTracker.findCrossedThresholds` is unambiguous in code.

**Research date:** 2026-05-09
**Valid until:** 2026-06-08 (30 days). Codex CLI shape and Anthropic context-window numbers may shift; re-verify A1 / A3 if plan-phase slips past June.
