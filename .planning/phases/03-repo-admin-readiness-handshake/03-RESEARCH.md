# Phase 3: Repo-admin readiness handshake — Research

**Researched:** 2026-05-09
**Domain:** Session-state semantics across MCP / crosslink / channel-feed; agent-asserted boot signals; cross-dashboard contract for a new readiness primitive.
**Confidence:** HIGH (all hook points cited from source; one MEDIUM-confidence question about deferred future-shape — see Q4)

## Summary

Heartbeat already exists. So does — confusingly — a state literally called `ready`. Phase 3's job is **not** to invent a new lifecycle layer; it's to disambiguate three things that live next to each other in the codebase and currently confuse "alive" with "ready":

1. **`CrosslinkSession.lastHeartbeat`** (`src/crosslink/types.ts:36`) — process is alive (PID-checked + heartbeat-checked in `discoverSessions` at `src/crosslink/store.ts:220-227`). Refreshed on a 30s timer in the MCP server (`src/mcp/server.ts:163-167`).
2. **`RepoAdminSession._state = "ready"`** (`src/orchestrator/repo-admin-session.ts:90, :655-659`) — the **process is spawned**, not the agent has finished onboarding. The comment at `:655-657` literally says *"Once the child is wired, mark ready. The 'did it successfully boot' question is semantic (AL-13 will ping the agent); mechanically, the process is live as soon as spawn returns."* This is the exact confusion Phase 3 must remove.
3. **`repo-ready` typed coordination message** (`src/crosslink/messages.ts:74-90`) — *"my PR merged, your blocker is gone."* Workflow signal, not boot signal.

The phase ships a fourth, distinct concept: **boot-readiness** — *"the repo-admin has finished its onboarding turn (read the board, registered the repo, knows what tickets exist) and can be addressed."* It is **agent-asserted** because only the agent knows when its onboarding turn is done; coordinator-detected proxies (board-read, repo-indexed) are inference, not assertion. It travels through the existing crosslink-session record (a flag on `CrosslinkSession`) AND the channel feed (a typed `status_update` entry for observability). Heartbeat stays unchanged — readiness is layered on top.

**Primary recommendation:** Add `readyAt: string | null` (ISO-8601, monotonic-once-set) and `readyKind: "admin" | "worker" | null` to `CrosslinkSession`. Add a new MCP tool `agent_ready` (~25 LOC) that the repo-admin calls exactly once at end-of-onboarding; the tool flips the flag on the crosslink record AND posts a `status_update` channel-feed entry with `metadata.kind = "agent_ready"`. Mirror the new `CrosslinkSession` shape in `crates/harness-data/src/lib.rs` (currently has zero crosslink mirror — that gap blocks Phase 4). Pin the system-prompt language with a new marker constant `REPO_ADMIN_READINESS_MARKER` matching the `REPO_ADMIN_*_MARKER` pattern at `src/agents/repo-admin.ts:53,63`.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Mint readiness assertion | Agent (repo-admin) calls MCP tool | — | Only the agent knows when its onboarding turn is done. Coordinator-side proxies (board-read, repo-indexed) are inference; an agent-asserted moment is unambiguous and matches the phase brief's "deterministic moment to assert 'I'm ready.'" |
| Validate + persist readiness | TS MCP tool handler | `CrosslinkStore` | The MCP tool layer is where every other agent-driven write to crosslink lives (`registerSession`, `updateSession`). Putting readiness here keeps the role-allowlist boundary and the "disk is authoritative" invariant intact. |
| Persist on disk | `CrosslinkStore.updateReadiness` → `~/.relay/crosslink-session/<id>.json` | — | Existing `FileHarnessStore.putDoc` writes are atomic (tmp + rename); the same store pattern that `updateHeartbeat` (`src/crosslink/store.ts:178-188`) uses extends naturally. |
| Emit observable channel-feed event | `ChannelStore.postEntry` with `type: "status_update", metadata.kind: "agent_ready"` | — | Phase 1 RESEARCH.md established this exact pattern (extend with `metadata.kind` rather than adding a new `ChannelEntryType`); mirror it. |
| Surface readiness state to dashboards | Rust shared crate (`crates/harness-data/`) | — | Cross-dashboard contract per `AGENTS.md:101-105`. **Currently zero crosslink-related types in `harness-data`** (verified by grep) — Phase 3 introduces `CrosslinkSession` mirror. |
| Render readiness pill | TUI + GUI + (Phase 4) SessionStart hook | — | Three views, one source of truth (`AGENTS.md:11`). Phase 3 provides the *primitive*; Phase 4 owns the rendering across all surfaces. |
| Pin system-prompt instruction | `src/agents/repo-admin.ts` const + `test/agents/repo-admin.test.ts` substring assertion | — | Existing pattern at `:53` (`REPO_ADMIN_MEMORY_POLICY_MARKER`) and `:63` (`REPO_ADMIN_COORDINATION_POLICY_MARKER`); the marker test at `test/agents/repo-admin.test.ts:156, :168` is the template. |

## Standard Stack

This phase reuses the existing stack — no new dependencies are required.

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `zod` | `^3.24.4` (existing) | Validate the new `readyAt` / `readyKind` fields on `CrosslinkSession`; validate `agent_ready` MCP tool input | Every cross-process payload in Relay is zod-validated. Schema lives at `src/crosslink/types.ts:26-38` already — append two optional fields. [VERIFIED: package.json] |
| `serde` / `serde_json` | `1` (existing) | Mirror `CrosslinkSession` shape in `crates/harness-data/` (currently absent) | Cross-dashboard contract requires a serde struct alongside any new on-disk shape. [VERIFIED: crates/harness-data/Cargo.toml:7] |
| `ratatui` | `0.29` (existing) | TUI readiness-pill rendering (Phase 4 consumes; Phase 3 only needs the data shape) | TUI is built on it. No new widgets needed for Phase 3 itself; Phase 4 does the rendering work. [VERIFIED: tui/Cargo.toml:7] |

### Supporting
None. The on-disk write goes through the existing `FileHarnessStore.putDoc` atomic-rename path; the channel-feed write goes through `ChannelStore.postEntry`'s atomic append; the MCP tool surface uses the existing JSON-RPC dispatcher.

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Adding `readyAt` to `CrosslinkSession` | New `~/.relay/sessions/<id>/readiness.json` file (single-doc atomic-rename) | **Rejected.** Splitting alive-state and ready-state across two files means dashboards have to load and join two records to answer "is admin X ready?" The existing `discoverSessions` filter (`store.ts:220-227`) already self-heals stale-PID + stale-heartbeat; piggybacking readiness onto that record means one `discoverSessions` call answers both questions. Disk shape stays small (one extra string) and forward-compatible (`#[serde(default)]`). |
| New `agent_ready` MCP tool | Reuse `channel_post` with metadata | **Rejected today.** The current `channel_post` MCP tool (`src/mcp/channel-tools.ts:62-74, :154-164`) hardcodes `metadata: {}` — agents cannot supply a `metadata.kind = "agent_ready"` discriminator through it. Extending `channel_post` to accept arbitrary metadata is a wider blast-radius change (every existing test asserts on the empty-metadata shape). A dedicated `agent_ready` tool is ~25 LOC and gives a single, auditable place where readiness assertions land. **Reconsider after Phase 3** if a "channel_post with metadata" surface emerges; the typed tool composes with that future without rework. |
| New typed coordination message kind (`agent-ready`) | Extend `CoordinationMessageSchema` (`src/crosslink/messages.ts:133-137`) | **Rejected.** Coordination messages are *cross-admin* (one alias addresses another). Boot-readiness is a *one-broadcast-many-listeners* signal — the dashboards observe it, the orchestrator observes it, but no other admin needs it routed to them. Forcing readiness through `coordination_send` would require a target alias; the natural target is "everyone who cares," which is what the channel feed is for. Plus: the existing `repo-ready` *kind* is already in this union with completely different semantics. Adding `agent-ready` to the same union would compound the naming ambiguity. |
| Channel-entry type `agent_ready` (new `ChannelEntryType`) | Add to `ChannelEntryTypeSchema` (`src/domain/channel.ts:30-46`) | **Rejected.** Phase 1's RESEARCH.md established the precedent: adding to the entry-type enum requires same-PR Rust mirror, GUI/TUI rendering branches, and breaks back-compat for older Rust binaries reading newer feeds. Use `status_update` + `metadata.kind` discriminator instead — exactly what Phase 1 did for `context_threshold`. |
| Coordinator-validated readiness (board-read + repo-indexed probes) | Server-side detection of "the agent has called `channel_get` once and has heartbeated for ≥ N seconds" | **Rejected.** Probes are inference. Any heuristic is wrong some of the time — an agent that read the board but is still mid-tool-call isn't actually ready. Agent-asserted gives a deterministic moment; the agent decides what "ready" means and the system records the assertion. **Health-probe layer can be added later as a second-tier signal** (e.g., `readinessCheckedAt`), but the primitive ships agent-asserted. |
| State on `SessionLifecycle` (extend `LifecycleState` enum) | Add `"booting"` / `"ready"` to `src/lifecycle/types.ts:7-13` | **Rejected.** `SessionLifecycle` is the **autonomous-loop** state machine (`planning → dispatching → winding_down → audit → done/killed`, see `src/lifecycle/types.ts:26-33`). It's a per-autonomous-session record at `~/.relay/sessions/<sessionId>/lifecycle.json`; not every repo-admin session is wrapped in an autonomous-loop session. (A user running `rly claude` ad-hoc spawns a crosslink session without a `SessionLifecycle`.) Boot-readiness must work for **all** repo-admins — coupling it to autonomous-loop lifecycle would leave ad-hoc sessions invisible. |

**Installation:**
```bash
# No new deps. Verify after edits:
pnpm test && pnpm typecheck && pnpm build && cargo check --workspace --locked && cargo test --workspace
```

**Version verification:**
- `zod ^3.24.4` confirmed at `package.json` (verified 2026-05-09).
- `ratatui = "0.29"` confirmed at `tui/Cargo.toml:7` (verified 2026-05-09).
- `serde = "1"`, `serde_json = "1"` confirmed at `crates/harness-data/Cargo.toml:7` (verified 2026-05-09).

## User Constraints

There is no `CONTEXT.md` for this phase yet. The constraints come from `ROADMAP.md:63-91` and the kickoff notes at `.planning/notes/cli-ux-trust-vs-invocation.md` + `.planning/notes/relay-architecture-status.md`:

- **Locked: heartbeat unchanged.** Readiness is additive. Do not modify `lastHeartbeat` semantics or the 30s heartbeat timer (`src/mcp/server.ts:163-167`).
- **Locked: cross-dashboard contract.** Any new TS shape that lands on disk must be mirrored in `crates/harness-data/src/lib.rs` in the same PR per `AGENTS.md:101-107`. Phase 3 is the **first** time `CrosslinkSession` will have a Rust mirror; Phase 4 reads it.
- **Locked: disk is authoritative.** Per `AGENTS.md:113`, "If memory and disk disagree, disk wins on next read." Readiness state lives on disk, not in any in-memory dashboard cache.
- **Locked: admin-only for v1.** Per-task workers (Phase 5 / AL-14 `spawn_worker`) don't actually run today (`src/agents/repo-admin.ts:201` — `spawnWorkerStub` throws). Phase 3 ships admin-readiness only. **Design the shape so workers reuse it without breaking changes** (see Q4).
- **Locked: test-pinned system-prompt language.** New prompt language must be assertable via a marker substring constant exported from `src/agents/repo-admin.ts`, matching `REPO_ADMIN_MEMORY_POLICY_MARKER` (`:53`) and `REPO_ADMIN_COORDINATION_POLICY_MARKER` (`:63`). The test pattern at `test/agents/repo-admin.test.ts:156-174` is the template.
- **Locked: no `repo-ready` collision.** The existing typed coordination message `repo-ready` (`src/crosslink/messages.ts:74-90`) means "my PR merged." Phase 3's signal is named `agent-ready` (or equivalent — see Q5) and lives in a different namespace (`metadata.kind` on a channel entry, not `kind` on a coordination message).

## Phase Requirements

The phase brief enumerates five surfaces (mapped to `ROADMAP.md:71-78` Scope + `:79-84` Acceptance) — each tied to research support:

| ID | Description | Research Support |
|----|-------------|------------------|
| REQ-1 | Add a "ready" state distinct from heartbeat — flag on session record (recommended) | `src/crosslink/types.ts:26-38` is the schema entry point; extend with `readyAt` + `readyKind`. See "Where does readiness state live?" |
| REQ-2 | `agent-ready` channel-feed event when onboarding completes | `src/channels/channel-store.ts:597-628` (`postEntry`); use `type: "status_update"` + `metadata.kind: "agent_ready"`. See "What does the agent call?" |
| REQ-3 | Repo-admin system prompt instructs agent to emit signal explicitly | `src/agents/repo-admin.ts:89-178` (`buildRepoAdminSystemPrompt`); add a new section + marker constant. See "System prompt" |
| REQ-4 | Heartbeat unchanged; readiness layered on top | `src/crosslink/store.ts:178-188` (`updateHeartbeat`) is **untouched** by this phase; new `updateReadiness` is a sibling method. See "Hot path safety" |
| REQ-5 | Surface state through `harness-data` so TUI / GUI / CLI / hooks read it consistently | `crates/harness-data/src/lib.rs` has zero crosslink mirror today; introduce `CrosslinkSession` Rust struct + `load_crosslink_sessions()` reader. See "Disk shape" |
| REQ-6 | Test asserts the explicit "alive but not ready" window exists during onboarding | Vitest pattern at `test/crosslink/store.test.ts` (existing); new test asserts `readyAt: null` immediately after register, transitions to ISO timestamp after `updateReadiness`. See "Testing" |
| REQ-7 | Tests pin the system-prompt language | `test/agents/repo-admin.test.ts:153-174` is the template (substring-match the new marker). See "Testing" |
| REQ-8 | Cross-dashboard contract honored | Rust struct in `crates/harness-data/src/lib.rs` ships in same PR; serde fixture test asserts JSON round-trips. See "Risks" |

## Architecture Patterns

### System Architecture Diagram

```text
┌──────────────────────────────────────────────────────────────────────┐
│ repo-admin agent (Claude / Codex CLI subprocess)                     │
│   (1) launches with system prompt that says:                         │
│       "When onboarding is done, call `agent_ready`."                 │
│   (2) reads board / indexes repo / completes onboarding              │
│   (3) calls `agent_ready` MCP tool exactly once                      │
└────────────────────────────┬─────────────────────────────────────────┘
                             │ JSON-RPC (stdin)
                             ▼
┌──────────────────────────────────────────────────────────────────────┐
│ src/mcp/server.ts                                                    │
│   handleMessage → dispatch on tool name                              │
│   NEW: case "agent_ready" → callReadinessTool(args, state)           │
│   state.crosslinkState.sessionId   ← already wired (auto-register)   │
│   state.channelState.channelId     ← already wired                   │
└────────────────────────────┬─────────────────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────────────────┐
│ src/mcp/readiness-tools.ts (NEW, ~25 LOC)                            │
│   1. Validate args via zod (kind: "admin" — workers stubbed)         │
│   2. crosslinkStore.updateReadiness(sessionId, kind)                 │
│   3. channelStore.postEntry(channelId, {                             │
│        type: "status_update",                                        │
│        metadata: { kind: "agent_ready", readyKind: "admin",          │
│                    sessionId, alias }                                │
│      })                                                              │
│   4. Return { ok: true, readyAt: <iso> }                             │
└────────────────────────────┬─────────────────────────────────────────┘
                             │
                ┌────────────┴───────────────┐
                ▼                            ▼
   ~/.relay/crosslink-session/        ~/.relay/channels/<id>/
     <sessionId>.json                   feed.jsonl
   (atomic tmp+rename via                (atomic POSIX append
    FileHarnessStore.putDoc)              via appendFile)
   ── readyAt, readyKind added ──      ── one entry per assertion ──

                ▲                            ▲
                │ Three views, all reading ~/.relay/ independently
                │
                └─► crates/harness-data::load_crosslink_sessions()
                    │   (NEW — first crosslink reader in harness-data)
                    │
                    ├─► TUI (Phase 4 work): readiness pill in repo list
                    ├─► GUI (Phase 4 work): readiness chip in sidebar
                    └─► SessionStart hook (Phase 4 work): inject ready state
```

### Recommended Project Structure
```
src/
├── crosslink/
│   ├── types.ts              # ADD: readyAt + readyKind to CrosslinkSessionSchema
│   └── store.ts              # ADD: updateReadiness(sessionId, kind)
├── mcp/
│   ├── readiness-tools.ts    # NEW: getReadinessToolDefinitions, callReadinessTool
│   ├── role-allowlist.ts     # ADD: "agent_ready" to REPO_ADMIN_ALLOWED_TOOLS
│   └── server.ts             # ADD: dispatch case for agent_ready (matches channel_/crosslink_ pattern)
├── channels/
│   └── channel-store.ts      # NO CHANGE — postEntry already accepts metadata
├── agents/
│   └── repo-admin.ts         # ADD: REPO_ADMIN_READINESS_MARKER + system-prompt section
└── domain/
    └── channel.ts            # NO CHANGE — metadata is Record<string, unknown>

crates/harness-data/src/lib.rs  # ADD: CrosslinkSession struct + load_crosslink_sessions()
                                 # (FIRST crosslink presence in this crate)

test/
├── crosslink/store.test.ts        # ADD: updateReadiness round-trip + alive-but-not-ready window
├── mcp/readiness-tools.test.ts    # NEW: tool input validation + side effects
└── agents/repo-admin.test.ts      # ADD: marker assertion (matches existing pattern)
```

### Pattern 1: New MCP tool definition + dispatch (template = `channel-tools.ts`)

The existing channel-tools.ts pattern is the cleanest template for adding a new MCP tool:

```typescript
// New: src/mcp/readiness-tools.ts
// Source pattern: src/mcp/channel-tools.ts:11-113 (definitions + dispatch)
import type { CrosslinkStore } from "../crosslink/store.js";
import type { ChannelStore } from "../channels/channel-store.js";

export interface ReadinessToolState {
  crosslinkSessionId: string | null;
  channelId: string | null;        // resolved at MCP boot from RELAY_CHANNEL_ID env or workspace lookup
  alias: string | null;            // RELAY_AGENT_ALIAS, set by repo-admin spawner
  crosslinkStore: CrosslinkStore;
  channelStore: ChannelStore;
}

export function getReadinessToolDefinitions(): object[] {
  return [{
    name: "agent_ready",
    description:
      "Assert that this agent has finished onboarding and is ready to receive tasks. " +
      "Call this exactly once per session, at the end of your onboarding turn (after " +
      "you've read the channel board and oriented yourself). Subsequent calls are no-ops.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        // Future-proofing for Phase 5; today only "admin" is accepted.
        kind: { type: "string", enum: ["admin"] },
        // Optional human-readable summary for the channel feed entry.
        summary: { type: "string", maxLength: 280 },
      },
    },
  }];
}

export async function callReadinessTool(
  args: Record<string, unknown>,
  state: ReadinessToolState
): Promise<unknown> {
  if (!state.crosslinkSessionId) {
    return { ok: false, reason: "session-not-registered" };
  }

  const kind = (args.kind as string) ?? "admin";
  const summary = typeof args.summary === "string" ? args.summary : null;

  const updated = await state.crosslinkStore.updateReadiness(state.crosslinkSessionId, kind);
  if (!updated) {
    return { ok: false, reason: "session-not-found" };
  }

  // Idempotent: if readyAt was already set, do not re-post a feed entry.
  // (updateReadiness returns the previous readyAt for this purpose; see Pattern 2.)
  if (updated.alreadyReady && state.channelId) {
    return { ok: true, readyAt: updated.readyAt, idempotent: true };
  }

  if (state.channelId) {
    await state.channelStore.postEntry(state.channelId, {
      type: "status_update",
      fromAgentId: state.crosslinkSessionId,
      fromDisplayName: state.alias ?? "repo-admin",
      content: summary ?? `${state.alias ?? "agent"} is ready.`,
      metadata: {
        kind: "agent_ready",
        readyKind: kind,
        sessionId: state.crosslinkSessionId,
        alias: state.alias,
        readyAt: updated.readyAt,
      },
    });
  }

  return { ok: true, readyAt: updated.readyAt };
}
```

### Pattern 2: Idempotent readiness store update (template = `updateHeartbeat`)

```typescript
// In src/crosslink/store.ts, sibling to updateHeartbeat at :178-188.
async updateReadiness(
  sessionId: string,
  kind: "admin" | "worker" = "admin"
): Promise<{ readyAt: string; alreadyReady: boolean } | null> {
  const session = await this.readSession(sessionId);
  if (!session) return null;

  // Monotonic-once-set: if already ready, return the existing timestamp
  // (idempotent re-call). The agent calling agent_ready twice is a no-op
  // not an error — onboarding can be racy if the agent retries.
  if (session.readyAt) {
    return { readyAt: session.readyAt, alreadyReady: true };
  }

  const readyAt = new Date().toISOString();
  const updated: CrosslinkSession = {
    ...session,
    readyAt,
    readyKind: kind,
    lastHeartbeat: readyAt,  // a readiness assertion is also activity
  };

  await this.store.putDoc(STORE_NS.crosslinkSession, sessionId, updated);
  return { readyAt, alreadyReady: false };
}
```

### Pattern 3: Cross-dashboard contract (mirror `CrosslinkSession` in Rust)

`crates/harness-data/src/lib.rs` has **zero** crosslink-related types today (verified by grep). Phase 3 introduces the first one:

```rust
// New in crates/harness-data/src/lib.rs.
// Mirror of src/crosslink/types.ts:26-38 with the new fields appended.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CrosslinkSession {
    pub session_id: String,
    pub pid: u32,
    pub repo_path: String,
    pub description: String,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub channel_id: Option<String>,
    #[serde(default)]
    pub capabilities: Vec<String>,
    pub agent_provider: String,           // "claude" | "codex" | "unknown"
    pub registered_at: String,
    pub last_heartbeat: String,
    pub status: String,                    // "active" | "idle" | "busy"
    // Phase 3 additions:
    #[serde(default)]
    pub ready_at: Option<String>,          // ISO-8601 once asserted; None during boot
    #[serde(default)]
    pub ready_kind: Option<String>,        // "admin" | "worker" once asserted
}

pub fn load_crosslink_sessions() -> Vec<CrosslinkSession> {
    // Read from ~/.relay/crosslink-session/*.json (the *current* path; see "Disk path lineage" in Pitfalls)
    let dir = harness_root().join("crosslink-session");
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(&dir) else { return out };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") { continue; }
        let Ok(raw) = std::fs::read_to_string(&path) else { continue };
        if let Ok(s) = serde_json::from_str::<CrosslinkSession>(&raw) {
            out.push(s);
        }
    }
    out
}
```

`#[serde(default)]` on every optional + every Phase-3-added field keeps older session.json files (written before this phase) deserializable — they appear as "alive, never ready" which is the correct semantics for the back-compat case.

### Pattern 4: System-prompt marker (template = `REPO_ADMIN_*_MARKER`)

```typescript
// In src/agents/repo-admin.ts, after the existing markers at :53 and :63.
export const REPO_ADMIN_READINESS_MARKER =
  "call `agent_ready` exactly once when your onboarding turn is complete";

// In buildRepoAdminSystemPrompt (~:140), insert a new section before "## Cross-repo coordination":
"## Boot-readiness assertion",
"You start in an 'alive but not ready' state — observers can see your",
`process is alive (heartbeat) but cannot tell whether you have finished`,
`reading the board and orienting yourself. ${REPO_ADMIN_READINESS_MARKER}.`,
"After this call, observers (TUI, GUI, other agents inspecting your",
"session) will see `readyAt` set on your crosslink record and an",
"`agent_ready` event on the channel feed. Re-calling the tool is a no-op.",
"",
"What 'ready' means: you have re-read the channel board via",
"`channel_get`, you understand the open tickets and recent decisions,",
"and you are prepared to receive new dispatches. Crashing or being",
"asked to re-onboard does NOT clear the flag — the flag is per-session,",
"and a fresh session id (after restart) starts unset.",
"",
```

### Anti-Patterns to Avoid

- **Don't add a new `ChannelEntryType` for `agent_ready`.** Adding to `ChannelEntryTypeSchema` (`src/domain/channel.ts:30-46`) requires Rust mirror, GUI/TUI rendering branches, and breaks back-compat for older Rust binaries. Use `status_update` + `metadata.kind` discriminator (Phase 1 prior art).
- **Don't extend `CoordinationMessageSchema` with `agent-ready`.** That schema (`src/crosslink/messages.ts:133-137`) already contains `repo-ready` (PR-merged semantics). Adding `agent-ready` to the same union compounds the naming ambiguity AND mis-categorizes the signal (boot-readiness is broadcast, not addressed).
- **Don't put readiness on `SessionLifecycle`.** That state machine (`src/lifecycle/types.ts:7-13`) is autonomous-loop-specific (`planning / dispatching / winding_down / audit / done / killed`). Ad-hoc `rly claude` sessions don't have a `SessionLifecycle`; coupling readiness to it would leave them invisible.
- **Don't repurpose `RepoAdminSession._state = "ready"`.** That field (`src/orchestrator/repo-admin-session.ts:90, :655-659`) means "process is spawned" and is part of the pool's restart book-keeping. Repurposing it to mean "agent finished onboarding" would silently break the pool's exit-detection logic and the rapid-flap ceiling. **Rename it for clarity is out of scope** for this phase but worth flagging in Open Questions for a follow-up. The Phase 3 readiness flag lives on `CrosslinkSession`, separate from `RepoAdminSession._state`.
- **Don't write into `~/.relay/sessions/<id>/lifecycle.json`** for readiness state. That file (`src/lifecycle/session-lifecycle.ts:144`) is owned by `SessionLifecycle`'s atomic-rename writer; writes from outside that class would race with the lifecycle's `writeChain`.
- **Don't bypass `getRelayDir()` / `harness_root()`.** Per `AGENTS.md:111` and the Phase 1 RESEARCH.md anti-pattern. All disk paths flow through these helpers.
- **Don't log readiness assertions to stdout from the MCP server.** MCP stdout carries JSON-RPC framing (`src/mcp/role-allowlist.ts:76-80`). Use stderr for any diagnostic output, leading-tagged with `[relay]`.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Atomic disk write | Manual lock + write | `FileHarnessStore.putDoc` (`src/storage/file-store.ts:102-141`) | Already temp-rename atomic; same path `updateHeartbeat` uses. |
| Channel feed appendage | Custom JSONL writer | `ChannelStore.postEntry` (`src/channels/channel-store.ts:597-628`) | POSIX-atomic appendFile + `touchChannel` for sidebar sort order; already handles metadata normalization (`:618` `normalizeMetadata`). |
| Schema validation | Manual checks | `z.object().strict()` on the new MCP tool args | Every other MCP tool uses zod; fall-through silent acceptance is the trap (`src/mcp/role-allowlist.ts:71-81` even has a one-shot warn for unknown roles to avoid this). |
| Session lookup by id | Custom file read | `CrosslinkStore.readSession` (existing) | Already handles parse failures + non-existence safely. |
| ID prefix discipline | New mint logic | `buildCrosslinkId("session")` (`src/crosslink/types.ts:3-5`) | Prefix conventions are documented at `STRUCTURE.md` "ID prefixes" — readiness reuses existing session ids; no new id mint. |
| MCP tool dispatch | Custom switch | The pattern at `src/mcp/channel-tools.ts:115-200` (export `callXTool`, dispatch on name) | Server `handleMessage` already routes on tool name; mirror the channel-tools shape exactly. |

**Key insight:** ~90% of this phase is composing existing primitives. The only invention is (a) which fields to add to `CrosslinkSession`, (b) the MCP tool input schema, (c) the system-prompt copy + marker. Everything else is the existing rails.

## Runtime State Inventory

This is **not** a rename / refactor / migration phase, but two pre-existing runtime-state observations matter for Phase 3 plan-phase:

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | `~/.relay/crosslink-session/<id>.json` files written by `FileHarnessStore.putDoc` (verified at `/Users/jonathanlancaster/.relay/crosslink-session/`, 5+ files present 2026-05-09). Existing files have NO `readyAt` / `readyKind` fields; `#[serde(default)]` Rust-side and zod `.optional()` TS-side handle the back-compat case as "alive, never ready." | **No data migration needed.** Existing sessions naturally drain (deregistered on process exit per `src/mcp/server.ts:172`); new sessions write the new fields from day one. |
| Live service config | None — the MCP server registers a fresh crosslink session at every boot (`src/mcp/server.ts:151-159`). | None. |
| OS-registered state | None. | None. |
| Secrets / env vars | `RELAY_AGENT_ROLE`, `RELAY_AGENT_ALIAS`, `RELAY_SESSION_ID`, `RELAY_PROVIDER` already exist (`src/orchestrator/repo-admin-session.ts:326-330`). Phase 3 does not introduce a new env var. The MCP tool reads alias from `state.coordinationState.alias` which already resolves from `RELAY_AGENT_ALIAS` (`src/mcp/server.ts:137`). | None. |
| Build artifacts | None. | None. |
| **Disk path lineage** | The GUI's `try_sigterm_matching_session` (`gui/src-tauri/src/lib.rs:2816`) reads from `~/.relay/crosslink/sessions/` (LEGACY); the TS `CrosslinkStore` writes to `~/.relay/crosslink-session/` (CURRENT) per `STORE_NS.crosslinkSession = "crosslink-session"` (`src/storage/namespaces.ts:19`). Both paths exist on this machine. | **Phase 3 must read from the current path.** The legacy reader in the GUI is a separate, pre-existing bug — fixing it is out of scope here, but the new `harness-data::load_crosslink_sessions` must read `~/.relay/crosslink-session/` not the legacy `~/.relay/crosslink/sessions/`. Plan-phase should call this out explicitly so the planner doesn't accidentally inherit the legacy path. |

## Common Pitfalls

### Pitfall 1: `RepoAdminSession._state = "ready"` confusion
**What goes wrong:** A reviewer or future contributor reads `RepoAdminSession._state` (`src/orchestrator/repo-admin-session.ts:90, :658`), sees the literal string `"ready"`, and assumes that's the boot-readiness signal — when it actually means "process is spawned."
**Why it happens:** The two concepts use the same English word. The pool's `_state` machine predates Phase 3.
**How to avoid:** (a) The new readiness flag lives on `CrosslinkSession`, not `RepoAdminSession` — physically separate. (b) Document the distinction inline at `RepoAdminSession._state` declaration (one comment line citing `CrosslinkSession.readyAt` as the agent-asserted signal). (c) Future-follow-up: rename `RepoAdminSession._state` to `_processState` to remove the lexical collision (out of scope for Phase 3, flag in Open Questions).
**Warning signs:** PR review feedback like "doesn't this duplicate the existing ready state?" — answer is no, but the question proves the doc is needed.

### Pitfall 2: Heartbeat regression from coupling
**What goes wrong:** A naive implementation puts readiness logic inside `updateHeartbeat` ("if not yet ready and we've heartbeated 3 times, mark ready"). This silently couples liveness to readiness; an MCP server that heartbeats but the agent never asserts marks ready anyway.
**Why it happens:** Tempting because the heartbeat path is already there. Coordinator-derived readiness was rejected for this exact reason.
**How to avoid:** `updateHeartbeat` (`src/crosslink/store.ts:178-188`) is **untouched** by Phase 3. New `updateReadiness` is a sibling. Acceptance test asserts that heartbeating without `agent_ready` keeps `readyAt: null` indefinitely.
**Warning signs:** The acceptance criterion at `ROADMAP.md:83` says *"alive but not ready window exists during onboarding (not just instantaneously transitioned at boot)"* — that test fails if heartbeat is coupled to readiness.

### Pitfall 3: Channel-id resolution at MCP server boot
**What goes wrong:** The MCP tool needs a `channelId` to post the readiness feed entry, but `src/mcp/server.ts:147-159` only resolves `crosslinkSessionId`. There is no canonical "what channel does this MCP server belong to" wiring today.
**Why it happens:** The MCP server is per-workspace, not per-channel. A workspace can host multiple channels.
**How to avoid:** Two paths, in order of preference:
- **Path A (preferred):** The repo-admin spawner (`ClaudeRepoAdminSpawner.spawn` at `src/orchestrator/repo-admin-session.ts:288-342`) sets `RELAY_CHANNEL_ID` in the child's env when the pool wires up an admin (`repo-admin-pool.ts` already knows the channel id for the autonomous loop). The MCP server reads it: `channelState.channelId = process.env.RELAY_CHANNEL_ID ?? null`. Ad-hoc `rly claude` sessions don't have it — the readiness MCP tool falls back to "store-only update, no feed entry" (still valid; dashboards still see `readyAt`).
- **Path B (fallback):** The repo-admin first calls `channel_get` and the MCP server caches the channel id in `channelState`. More implicit, more bug-prone.
**Recommendation:** Path A. Spec the env var in Phase 3 plan; ad-hoc sessions degrade gracefully (no feed entry but the disk flag is still set).
**Warning signs:** Test for "agent_ready called from a non-repo-admin session" fails with a confusing error about channel resolution.

### Pitfall 4: Cross-dashboard contract drift (the same one Phase 1 RESEARCH flagged)
**What goes wrong:** TS adds `readyAt` to `CrosslinkSessionSchema`; Rust mirror missed in the same PR; `cargo check` and `cargo test` both pass because no test exercises the field; TUI / GUI silently show "alive, never ready" forever.
**Why it happens:** `serde_json::from_str(...).ok()` patterns (e.g., `gui/src-tauri/src/lib.rs:2829`) silently drop unparseable rows. Without `#[serde(deny_unknown_fields)]` (which is correctly NOT used per `CONCERNS.md`), unknown TS fields are also silently dropped — but a *missing* field on the Rust side is the pernicious case.
**How to avoid:** (a) Same-PR mirror — `AGENTS.md:101-105` mandate. (b) Hand-write a serde fixture test in `crates/harness-data/src/lib.rs::tests` that ingests a complete JSON with `readyAt` set and asserts the field round-trips (template at `:2310-2440` from Phase 1 RESEARCH cite). (c) `#[serde(default)]` on every new optional field so existing files stay parseable, but the round-trip test uses a *complete* fixture to guarantee no field is silently dropped.
**Warning signs:** PR diff touches `src/crosslink/types.ts` but not `crates/harness-data/src/lib.rs`. CI green either way.

### Pitfall 5: Idempotency of `agent_ready`
**What goes wrong:** The agent calls `agent_ready` twice (e.g., onboarding turn retried after a transient tool error). Two `status_update` entries land on the channel feed; observers see "ready" announced twice.
**Why it happens:** No idempotency check on the channel-feed write path.
**How to avoid:** `updateReadiness` is monotonic-once-set: `if (session.readyAt) return { ..., alreadyReady: true }` (Pattern 2). The MCP tool checks `alreadyReady` before posting the feed entry. The disk write is also short-circuited (no second `putDoc`).
**Warning signs:** Channel feed shows two `agent_ready` entries from the same session id within minutes; harmless to dashboards but noisy.

### Pitfall 6: Session-end clears readiness ambiguity
**What goes wrong:** A session's MCP server exits → `deregisterSession` deletes the file (`src/crosslink/store.ts:190-207`). On next boot, a *new* session is registered with a fresh id; that session is alive-but-not-ready until it asserts. **This is correct behaviour** but easy to misread as "readiness was lost."
**Why it happens:** Sessions are per-process; readiness is per-session-id, not per-repo-path.
**How to avoid:** Document that readiness is session-scoped, not repo-scoped. Phase 4's project-readiness surface aggregates across the live session for each `repoPath` (taking the most recent `readyAt`). The Phase 3 primitive does NOT need to handle aggregation.
**Warning signs:** A user file-bug saying "I restarted and now it's not ready again" — that's the correct semantics, not a bug.

## Code Examples

### Pattern A: zod schema extension
```typescript
// src/crosslink/types.ts — extend the existing schema at :26-38.
export const CrosslinkSessionSchema = z.object({
  sessionId: z.string(),
  pid: z.number(),
  repoPath: z.string(),
  description: z.string(),
  displayName: z.string().optional(),
  channelId: z.string().optional(),
  capabilities: z.array(CrosslinkCapabilitySchema),
  agentProvider: AgentProviderSchema,
  registeredAt: z.string(),
  lastHeartbeat: z.string(),
  status: SessionStatusSchema,
  // Phase 3 additions — both optional for back-compat with sessions
  // registered before this phase shipped.
  readyAt: z.string().optional(),
  readyKind: z.enum(["admin", "worker"]).optional(),
});
```

### Pattern B: System-prompt marker test (template = `:153-174`)
```typescript
// test/agents/repo-admin.test.ts — add to the `describe("repo-admin role — system prompt", …)` block.
import { REPO_ADMIN_READINESS_MARKER } from "../../src/agents/repo-admin.js";

it("encodes the boot-readiness policy by substring match", () => {
  expect(prompt).toContain(REPO_ADMIN_READINESS_MARKER);
  expect(prompt).toContain("alive but not ready");
  expect(prompt).toMatch(/onboarding turn is complete/i);
});
```

### Pattern C: Acceptance-criterion test (the alive-but-not-ready window)
```typescript
// test/crosslink/store.test.ts (or new file).
it("registers sessions in the alive-but-not-ready state", async () => {
  const store = await CrosslinkStore.init({ rootDir: tmpRoot });
  const session = await store.registerSession({
    pid: process.pid,
    repoPath: "/tmp/repo",
    description: "test",
    capabilities: ["general"],
    agentProvider: "claude",
    status: "active",
  });
  expect(session.readyAt).toBeUndefined();
  expect(session.lastHeartbeat).toBeDefined();

  // Heartbeat alone does not flip readiness.
  await store.updateHeartbeat(session.sessionId);
  const after = await store.readSession(session.sessionId);
  expect(after?.readyAt).toBeUndefined();

  // Explicit assertion flips it.
  const result = await store.updateReadiness(session.sessionId, "admin");
  expect(result?.readyAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(result?.alreadyReady).toBe(false);

  // Idempotent re-call.
  const second = await store.updateReadiness(session.sessionId, "admin");
  expect(second?.readyAt).toBe(result?.readyAt);
  expect(second?.alreadyReady).toBe(true);
});
```

### Pattern D: Rust serde fixture test (template = `crates/harness-data/src/lib.rs:2310-2440`)
```rust
#[test]
fn crosslink_session_round_trip_with_readiness() {
    let json = r#"{
        "sessionId": "session-test",
        "pid": 1234,
        "repoPath": "/tmp/repo",
        "description": "test",
        "capabilities": ["general"],
        "agentProvider": "claude",
        "registeredAt": "2026-05-09T10:00:00Z",
        "lastHeartbeat": "2026-05-09T10:00:30Z",
        "status": "active",
        "readyAt": "2026-05-09T10:00:15Z",
        "readyKind": "admin"
    }"#;
    let s: CrosslinkSession = serde_json::from_str(json).unwrap();
    assert_eq!(s.session_id, "session-test");
    assert_eq!(s.ready_at.as_deref(), Some("2026-05-09T10:00:15Z"));
    assert_eq!(s.ready_kind.as_deref(), Some("admin"));
}

#[test]
fn crosslink_session_back_compat_no_readiness_fields() {
    // Existing pre-Phase-3 session.json — readyAt / readyKind absent.
    let json = r#"{
        "sessionId": "session-old",
        "pid": 4321,
        "repoPath": "/tmp/repo",
        "description": "test",
        "capabilities": [],
        "agentProvider": "claude",
        "registeredAt": "2026-04-01T10:00:00Z",
        "lastHeartbeat": "2026-04-01T10:00:30Z",
        "status": "active"
    }"#;
    let s: CrosslinkSession = serde_json::from_str(json).unwrap();
    assert_eq!(s.ready_at, None);
    assert_eq!(s.ready_kind, None);
}
```

## Open Questions (the seven the kickoff brief enumerated)

### Q1: Where does the readiness state live?

**Recommendation:** A flag (`readyAt: string | null`, plus `readyKind: "admin" | "worker" | null`) on `CrosslinkSession`. NOT on `SessionLifecycle`, NOT a new top-level state machine.

**Rationale:**
- `CrosslinkSession` is the only artifact that exists for **every** repo-admin (autonomous-loop and ad-hoc). Per `src/mcp/server.ts:151-159`, the MCP server auto-registers a crosslink session for every wrapped Claude/Codex session. `SessionLifecycle` is autonomous-loop-only.
- Phase 1 RESEARCH established the principle: "extend existing rails, don't invent new ones." The crosslink-session record IS the existing rail for "what sessions exist and how do they behave."
- One write target keeps the cross-dashboard contract simple: dashboards already (or will) load `CrosslinkSession`s; readiness ships in the same payload.
- A separate `~/.relay/sessions/<id>/readiness.json` was considered and rejected (Alternatives Considered table) because joining two records is more complex than one extra string.

**Alternatives considered:**
- New session-lifecycle state — rejected (autonomous-loop coupling, see Anti-Patterns).
- Channel-feed event only (no flag) — rejected; dashboards would have to scan the entire feed to determine readiness, violating "small file fast read" pattern.
- Combination (flag + feed event) — **YES**, this is the recommendation. The flag is the authoritative state; the feed event is the audit trail and the subscription point.

**Confidence:** HIGH.

### Q2: What constitutes "ready"?

**Recommendation:** Agent-asserted via system-prompt instruction. The agent calls `agent_ready` MCP tool when it judges its onboarding turn complete (read board, indexed repo, oriented on open tickets).

**Rationale:**
- Coordinator-validated proxies (board-read flag, repo-indexed flag) are inference. An agent that loaded the board but is mid-tool-call when the proxy fires would be marked ready prematurely; one that handles its onboarding silently in chain-of-thought without calling specific tools would never be marked ready.
- The phase brief's *"gives the agent a deterministic moment to assert 'I'm ready.'"* (`ROADMAP.md:74`) explicitly calls for agent assertion.
- A health-probe layer can be added later as a *second-tier* signal (e.g., a `readinessChecks: { boardRead: bool, repoIndexed: bool }` block) without changing the primitive.

**Alternatives considered:**
- Pure coordinator validation — rejected (inference, fragile heuristics).
- Hybrid: agent asserts, coordinator validates. Defer until empirical evidence shows agents lie about being ready. Cheaper to ship the assertion, observe, and harden.

**Confidence:** HIGH.

### Q3: What tool does the repo-admin call?

**Recommendation:** New dedicated MCP tool `agent_ready` (~25 LOC). Add to `REPO_ADMIN_ALLOWED_TOOLS` (`src/mcp/role-allowlist.ts:105-130`).

**Rationale:**
- `channel_post` does not accept arbitrary metadata today (`src/mcp/channel-tools.ts:154-164` hardcodes `metadata: {}`). Extending it would be a wider blast-radius change.
- `coordination_send` is for cross-admin addressed messages; readiness is a broadcast.
- A dedicated tool gives a single auditable place where readiness assertions land. The tool description includes the contract ("call exactly once at end of onboarding") so the agent has explicit guidance, not implicit metadata-shape archaeology.
- Cost: 25 LOC of tool definition + handler + an entry in `role-allowlist.ts`. The existing `channel-tools.ts` pattern is the template; this fits in one new file.

**Alternatives considered:**
- Reuse `channel_post` with metadata — rejected (requires extending `channel_post`'s schema, which has back-compat concerns for many existing tests).
- Extend `coordination_send` — rejected (semantic mismatch; see Alternatives Considered table).
- Reuse `crosslink_register` (which already exists at `src/crosslink/tools.ts:104-128`) — rejected. `crosslink_register` is for **updating description / capabilities** (`src/crosslink/store.ts:158-176` `updateSession`), not for asserting state transitions. Conflating them would mean a description update would also un-mark readiness.

**Confidence:** HIGH.

### Q4: How does this generalize to per-task workers (Phase 5 / AL-14)?

**Recommendation:** Same primitive, parameterized by `kind: "admin" | "worker"`. Phase 3 ships `kind: "admin"` only; Phase 5 adds `kind: "worker"` to the zod enum (`readyKind: z.enum(["admin", "worker"]).optional()`) and the MCP tool's input schema.

**Rationale:**
- Workers in AL-14 will be ephemeral per-ticket subprocesses, but they ALSO go through MCP and ALSO auto-register a crosslink session (current code path: every MCP server registers — `src/mcp/server.ts:151`). So they get a `CrosslinkSession` for free.
- Workers will have a different "ready" definition (they're ready when they've checked out the worktree and read the ticket, not when they've read the channel board). The system-prompt copy will differ. But the storage shape and channel-feed shape can be identical with `readyKind` discriminating.
- Designing for the worker case today means: (a) `readyKind` field exists from day one; (b) the MCP tool's input schema enumerates valid kinds (Phase 3: just `"admin"`; Phase 5: adds `"worker"`); (c) the system-prompt copy is parameterized so the worker prompt can pin its own marker constant.

**Risk:** MEDIUM-confidence — workers don't exist yet (`spawn_worker` stub at `src/agents/repo-admin.ts:201`), so we can't empirically verify the shape generalizes until AL-14 lands. **Specifically check during Phase 5 plan-phase**: if a worker's "ready" definition needs richer metadata (e.g., "ready and assigned to ticket X"), the metadata can be added on the channel-feed entry's `metadata` field without changing the disk shape.

**Confidence:** MEDIUM (for the worker generalization specifically; HIGH for the admin shape).

### Q5: `repo-ready` collision — what name avoids confusion?

**Recommendation:** `agent_ready` (snake_case for the MCP tool name and the channel-entry `metadata.kind`); `agentReady` (camelCase) is not used anywhere in this surface (we read it via `metadata.kind === "agent_ready"`).

**Rationale:**
- The existing `repo-ready` (`src/crosslink/messages.ts:74-90`) is a **coordination message kind** (`kind: "repo-ready"`), not a channel-feed metadata kind. Different namespace. So a literal collision (string identical) wouldn't actually conflict at the parser level — but **semantic** collision still misleads readers.
- `agent_ready` is unambiguous: "an agent has asserted readiness." It distinguishes from `repo-ready` (the coordination message about a PR) and from `RepoAdminSession._state = "ready"` (process is spawned).
- `admin_ready` would work too but precludes the worker generalization (Q4). `onboarded` describes the cause; `ready` describes the state. The phase brief uses "ready" throughout, so stick with it.

**Confidence:** HIGH.

### Q6: Disk shape — what artifact does readiness write to?

**Recommendation:** Two writes, both atomic, both already-existing-rails:

1. **Per-session record:** `~/.relay/crosslink-session/<sessionId>.json` (the existing FileHarnessStore namespace path). Adds two fields: `readyAt`, `readyKind`. Atomic via `FileHarnessStore.putDoc` tmp-rename.
2. **Channel feed entry:** `~/.relay/channels/<channelId>/feed.jsonl` with `type: "status_update"`, `metadata.kind: "agent_ready"`. Atomic via POSIX `appendFile` (`src/channels/channel-store.ts:622`).

**Why both:**
- The per-session record is the **state**: "what is the readiness of session X right now?" Dashboards read this for the pill.
- The channel feed entry is the **event audit**: "when did session X become ready?" Phase 4 SessionStart hook scrolls the feed; orchestrator can subscribe; user history view shows the transition.
- Phase 1 established this exact dual-write pattern for context-threshold events (state in `budget.jsonl`, event in `feed.jsonl`).

**Disk path lineage caveat:** Per the Runtime State Inventory, the GUI's legacy code at `gui/src-tauri/src/lib.rs:2816` reads `~/.relay/crosslink/sessions/` (legacy), but the TS writer goes to `~/.relay/crosslink-session/` (current). Phase 3's new Rust reader (`load_crosslink_sessions`) **must** read the current path. Fixing the legacy GUI reader is out of scope.

**Confidence:** HIGH.

### Q7: System-prompt pin — what marker substring?

**Recommendation:** Export `REPO_ADMIN_READINESS_MARKER = "call \`agent_ready\` exactly once when your onboarding turn is complete"` from `src/agents/repo-admin.ts`. Test `test/agents/repo-admin.test.ts` asserts `expect(prompt).toContain(REPO_ADMIN_READINESS_MARKER)` plus a couple of supporting strings ("alive but not ready", `/onboarding turn is complete/i`).

**Rationale:**
- Pattern is already established for `REPO_ADMIN_MEMORY_POLICY_MARKER` (`:53`) and `REPO_ADMIN_COORDINATION_POLICY_MARKER` (`:63`); the marker test at `:153-174` is the template.
- The chosen substring is short enough that future copy edits to surrounding language don't need to touch the marker. Long enough to be specific (the substring "agent_ready" alone could appear in incidental documentation).
- Backtick around `agent_ready` matches the existing markdown convention in the system prompt (verified at the existing markers' use sites in `buildRepoAdminSystemPrompt`).

**Confidence:** HIGH.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js / pnpm | TS code paths | ✓ | (matches Phase 1) | — |
| Rust toolchain | harness-data + cargo tests | ✓ | edition 2021 | — |
| `claude` CLI | live-mode smoke test of `agent_ready` end-to-end | unknown | — | Scripted-mode tests (vitest with fake invoker) cover the surface; live verification is a manual smoke during plan-phase. |
| Existing test fixtures (vitest, scoped_root for Rust) | unit tests | ✓ | — | — |

**Missing dependencies with no fallback:** none — phase is additive.
**Missing dependencies with fallback:** live-CLI smoke testing can be performed manually if not in CI.

## Validation Architecture

(Including; `nyquist_validation` is not explicitly disabled in `.planning/config.json`.)

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest 3.2.4 (TS); cargo test (Rust) |
| Config file | `vitest.config.ts` (root); `crates/harness-data/Cargo.toml` |
| Quick run command | `pnpm test test/crosslink/store.test.ts test/agents/repo-admin.test.ts` |
| Full suite command | `pnpm test && pnpm typecheck && pnpm build && cargo check --workspace --locked && cargo test --workspace` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| REQ-1 (state location) | `readyAt` / `readyKind` round-trip through zod + FileHarnessStore | unit | `pnpm test test/crosslink/store.test.ts` | EXISTS — extend |
| REQ-2 (channel-feed event) | `agent_ready` MCP call posts a `status_update` entry with `metadata.kind: "agent_ready"` | unit | `pnpm test test/mcp/readiness-tools.test.ts` | Wave 0 — new file |
| REQ-3 (system prompt) | Prompt contains `REPO_ADMIN_READINESS_MARKER` | unit | `pnpm test test/agents/repo-admin.test.ts` | EXISTS — extend |
| REQ-4 (heartbeat unchanged) | Heartbeating sessions stay `readyAt: null` until explicit assertion | unit | `pnpm test test/crosslink/store.test.ts` | Wave 0 — new test in existing file |
| REQ-5 (Rust mirror) | `CrosslinkSession` deserializes both pre- and post-Phase-3 JSON | unit | `cargo test -p harness-data crosslink_session` | Wave 0 — new fixture tests |
| REQ-6 (alive-but-not-ready window test) | A session can heartbeat repeatedly with `readyAt: null` | unit | `pnpm test test/crosslink/store.test.ts` (covered by REQ-4 above) | covered |
| REQ-7 (prompt language pin) | Marker substring + supporting strings present | unit | `pnpm test test/agents/repo-admin.test.ts` (covered by REQ-3) | covered |
| REQ-8 (idempotency) | Second `agent_ready` call is a no-op (no second feed entry, same `readyAt`) | unit | `pnpm test test/mcp/readiness-tools.test.ts` (covered by REQ-2) | covered |

### Sampling Rate
- **Per task commit:** `pnpm test test/<area>/<file>.test.ts` (the just-touched test).
- **Per wave merge:** `pnpm test && cargo test --workspace`.
- **Phase gate:** `pnpm test && pnpm typecheck && pnpm build && cargo check --workspace --locked && cargo test --workspace` — all green before `/gsd-verify-work`.

### Wave 0 Gaps
- [ ] `src/mcp/readiness-tools.ts` (new file, ~25-40 LOC).
- [ ] `test/mcp/readiness-tools.test.ts` (new file).
- [ ] Extension of `test/crosslink/store.test.ts` with the alive-but-not-ready window test + `updateReadiness` round-trip.
- [ ] Extension of `test/agents/repo-admin.test.ts` with the `REPO_ADMIN_READINESS_MARKER` assertion.
- [ ] New `#[test]` block in `crates/harness-data/src/lib.rs` for `CrosslinkSession` round-trip + back-compat fixtures.
- [ ] No new framework install needed.

## Project Constraints (from CLAUDE.md / AGENTS.md)

The Relay-specific `./CLAUDE.md` defers to `AGENTS.md` (per `CLAUDE.md` itself: *"All coding-agent conventions for this repo live in AGENTS.md"*). The user's global `~/.claude/CLAUDE.md` targets TuringOn repos, NOT Relay — confirmed by Phase 1 RESEARCH at A6.

Key constraints affecting Phase 3:

1. **`AGENTS.md:101-107` cross-dashboard contract.** Any change to `src/crosslink/types.ts` requires a same-PR `crates/harness-data/src/lib.rs` mirror. **Phase 3 is the first time `CrosslinkSession` will have a Rust mirror** — the work cannot be split across PRs without leaving Phase 4 blocked.
2. **`AGENTS.md:50` scripted mode is default.** All readiness tests run with `HARNESS_LIVE` unset.
3. **`AGENTS.md:111-113` feed.jsonl is append-only.** Use `postEntry`, never rewrite.
4. **`AGENTS.md:118-119` env var sanitization.** `RELAY_*` prefix flows through the default sanitizer; no new `passEnv` entries needed since we reuse `RELAY_AGENT_ALIAS` / `RELAY_SESSION_ID` / (proposed) `RELAY_CHANNEL_ID`.
5. **`AGENTS.md:63-67` PR hygiene — Sub-800 LOC.** Phase 3 should fit easily; estimated diff is ~250 LOC across TS (schema + store + MCP tool + prompt + tests) and ~80 LOC Rust (struct + reader + 2 tests).
6. **`AGENTS.md:127` decisions are one-file-per-id.** Not directly relevant to readiness, but a reminder if any of the Phase 3 work touches the decisions surface (it shouldn't).
7. **`AGENTS.md:111` atomic writes.** Both writers (`putDoc`, `postEntry`) already satisfy this. Phase 3 doesn't add a new atomic-write call site.
8. **Always go through `getRelayDir()` / `harness_root()`.** No new ad-hoc path joins.
9. **`pnpm` is the package manager.** No new deps anyway.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Heartbeat-only liveness signal | Heartbeat (alive) + agent-asserted readiness (ready) | Phase 3 (this PR) | Disambiguates "process exists" from "agent ready to receive tasks." Phase 4's project surface stops lying. |
| `~/.relay/crosslink/sessions/` (legacy GUI reader path) | `~/.relay/crosslink-session/` (current FileHarnessStore namespace) | When the FileHarnessStore migration landed (pre-Phase-3) per `src/crosslink/store.ts:131-138` `warnIfLegacyLayoutPresent` | The GUI's `try_sigterm_matching_session` (`gui/src-tauri/src/lib.rs:2816`) still reads the legacy path — separate pre-existing bug. Phase 3's new Rust reader uses the current path. |

**Deprecated/outdated:**
- `RepoAdminSession._state = "ready"` is **NOT** deprecated by Phase 3 — it has its own meaning (process is spawned) and stays. Document the distinction inline.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | The MCP server can resolve `channelId` for a repo-admin session via `RELAY_CHANNEL_ID` env var threaded through the spawner. The pool currently sets `RELAY_AGENT_ALIAS` and `RELAY_SESSION_ID` (`src/orchestrator/repo-admin-session.ts:326-330`); adding `RELAY_CHANNEL_ID` is a one-line change. | Pitfall 3 + Pattern 1 | LOW. If the spawner can't be modified mid-Phase-3, the readiness tool degrades gracefully (no feed entry; disk flag still set). Phase 4 dashboards still see `readyAt`. Plan-phase should verify the spawner change is in scope. |
| A2 | `~/.relay/crosslink-session/<id>.json` is the authoritative current path for live writes; `~/.relay/crosslink/sessions/` is legacy. | Runtime State Inventory + Q6 | LOW. Empirically verified on this machine (2026-05-09): `crosslink-session/` has files modified May 9 09:16; `crosslink/sessions/` only has files from earlier. Confirmed by `STORE_NS.crosslinkSession = "crosslink-session"` (`src/storage/namespaces.ts:19`). |
| A3 | Workers (Phase 5 / AL-14) will get an auto-registered `CrosslinkSession` via the same MCP-server boot path. Today only the long-lived admin's MCP server registers; the worker case is not built. | Q4 | MEDIUM. If AL-14 chooses NOT to wrap workers in MCP servers (e.g., spawns them as direct subprocesses), the readiness primitive would need a second persistence path. Verify in Phase 5 design before committing the `readyKind: "worker"` enum value to public API. |
| A4 | Existing `CrosslinkSession` records on disk (without `readyAt`) deserialize cleanly when the field is added with `.optional()` (TS) and `#[serde(default)]` (Rust). | Pitfall 4 + Code Examples Pattern D | LOW. Verified by zod docs + serde behavior; the Phase 3 fixture test (Pattern D, second case) explicitly covers the back-compat case. |
| A5 | The agent will reliably call `agent_ready` once when instructed by the system prompt. | Q2 | MEDIUM. Empirical question: agents follow some prompts faithfully and forget others. Mitigation: the marker test ensures the *prompt* says it; the alive-but-not-ready window test ensures the *system* doesn't pretend the agent did it; if real agents drop the call in practice, add a second-tier coordinator-detected fallback (e.g., 2-minute timeout flips to a `readyAt` with a `inferredFromIdle: true` flag). Defer that decision to post-launch observation. |
| A6 | The Relay-specific `./CLAUDE.md` (defers to `AGENTS.md`) governs this work, not the user's global TuringOn-targeted CLAUDE.md. | Project Constraints | LOW (verified by Phase 1 RESEARCH A6); user can confirm cheaply. |

## Sources

### Primary (HIGH confidence — directly cited from this codebase, all line numbers verified 2026-05-09)
- `src/crosslink/types.ts:1-64` — `CrosslinkSessionSchema`, `CrosslinkSession`, `buildCrosslinkId`.
- `src/crosslink/store.ts:143-207, :209-233` — `registerSession`, `updateSession`, `updateHeartbeat`, `discoverSessions`.
- `src/crosslink/messages.ts:1-176` — coordination message schemas including the existing `repo-ready` (`:74-90`).
- `src/crosslink/coordinator.ts:240-475` — coordinator routing + audit pattern.
- `src/crosslink/tools.ts:11-128` — MCP tool definitions for crosslink, including `crosslink_register`.
- `src/mcp/server.ts:130-218` — MCP server boot, auto-register, heartbeat loop, cleanup.
- `src/mcp/channel-tools.ts:11-200` — template for adding a new MCP tool.
- `src/mcp/role-allowlist.ts:30-258` — repo-admin allowlist; pattern for adding a new tool name.
- `src/agents/repo-admin.ts:1-203` — system prompt builder, marker constants, stub.
- `src/orchestrator/repo-admin-session.ts:1-660` (sampled at `:14, :90, :130-160, :288-342, :421-441, :576-660`) — process state machine; `_state = "ready"` confusion; spawner env injection.
- `src/lifecycle/session-lifecycle.ts:1-437` (full file) — autonomous-loop state machine; why it's NOT the right home for boot-readiness.
- `src/lifecycle/types.ts:1-93` (full file) — `LifecycleState` enum.
- `src/channels/channel-store.ts:540-628` — `joinChannel`, `postEntry`, `appendFile` shape.
- `src/domain/channel.ts:30-258` — `ChannelEntryTypeSchema`, `ChannelEntry`, metadata convention.
- `src/storage/file-store.ts:102-326` — `putDoc`, atomic write, namespace path resolution.
- `src/storage/namespaces.ts:1-23` — `STORE_NS.crosslinkSession = "crosslink-session"`.
- `src/cli/agent-wrapper.ts:1-127` (full file) — `HARNESS_SYSTEM_PROMPT`, env injection for Claude/Codex children.
- `crates/harness-data/src/lib.rs:562-571` — `harness_root` path resolution.
- `crates/harness-data/src/lib.rs:1265-1390` — `ChatSession` struct + serde patterns (template for the new `CrosslinkSession` mirror).
- `crates/harness-data/src/lib.rs:2310-2440` — Rust fixture-test patterns (template for the round-trip + back-compat tests).
- `gui/src-tauri/src/lib.rs:2810-2861, :2916-2970` — legacy crosslink path readers (`crosslink/sessions/`); separate pre-existing bug.
- `test/agents/repo-admin.test.ts:140-180` — marker assertion test pattern.
- `AGENTS.md` (full file) — cross-dashboard contract, atomic writes, append-only feed, env sanitizer.
- `ROADMAP.md:63-91` — Phase 3 brief.
- `.planning/notes/cli-ux-trust-vs-invocation.md` (full file) — trust-not-invocation framing.
- `.planning/notes/relay-architecture-status.md` (full file) — what's built vs stubbed.
- `.planning/phases/01-token-usage-telemetry-context-bar/01-RESEARCH.md` — prior-art conventions: `metadata.kind` discriminator on `status_update`, schema-mirror discipline, "extend rails, don't invent."

### Secondary (MEDIUM confidence — supporting context)
- Live filesystem inspection 2026-05-09: `~/.relay/crosslink-session/` and `~/.relay/crosslink/sessions/` both exist; recent writes go to `crosslink-session/`.

### Tertiary
- None — Phase 3 is internal Relay work with no external vendor docs to cross-verify.

## Metadata

**Confidence breakdown:**
- Storage shape (Q1): HIGH — every line cited; pattern matches Phase 1's recommendation methodology.
- Definition of "ready" (Q2): HIGH — agent-asserted unambiguously matches the phase brief language.
- Tool surface (Q3): HIGH — `channel_post` empty-metadata constraint verified at `src/mcp/channel-tools.ts:154-164`.
- Worker generalization (Q4): MEDIUM — A3 dependency on Phase 5 design.
- Naming (Q5): HIGH — direct lexical analysis.
- Disk shape (Q6): HIGH — both writes use existing rails verified in source.
- Marker (Q7): HIGH — pattern + test template already exist.
- Cross-dashboard contract: HIGH — `crates/harness-data` has zero crosslink today (verified by grep), so this PR is greenfield for the Rust mirror.

**Research date:** 2026-05-09
**Valid until:** 2026-06-08 (30 days). The internal-only nature of this phase means there are no fast-moving external sources to invalidate the findings; the only re-verification trigger is if AL-14 (`spawn_worker`) lands during the window and changes the worker-process model (re A3).
