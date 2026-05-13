# Phase 4: Project readiness surface - Research

**Researched:** 2026-05-11
**Domain:** Cross-surface readiness rendering (SessionStart hook + TUI + GUI + CLI)
**Confidence:** HIGH overall (Codex hook parity verified via official docs; Phase 3 disk shape verified in code; lifecycle collision verified in code)

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01:** **Channel IS the project.** Phase 4 introduces no new entity. TUI/GUI top-level lists channels (filtered by `status === "active"` or similar); drilling into a channel shows repos × admin states × recent feed events. Matches today's mental model — `Channel.repoAssignments[]` and `workspaceIds[]` already define the cross-repo unit. A new top-level `Project` entity was explicitly rejected as a future concern, not Phase 4 scope.
- **D-02:** **Active-channel resolution for the hook:** the SessionStart hook resolves the active channel by (a) reading `RELAY_CHANNEL_ID` env if set (the spawner already threads this for repo-admin sessions per Phase 3), else (b) deriving from the session's `cwd` via `Channel.repoAssignments[]` reverse lookup. Hook degrades gracefully (no injection) if neither path resolves — this is the same degradation shape as `agent_ready` when no channel context exists (Phase 3 D-03).
- **D-03:** **Density: terse one-liner per repo.** Target ~5-15 lines total for a typical 3-repo channel. Hook output is a fenced text block that the agent's first turn can scan in a single glance. Sample shape:
  ```
  [Relay] Channel: oauth-rollout (3 repos)
    ● ui-repo       ready (admin: atlas-7f2)
    ● backend-repo  ready (admin: atlas-3a1)
    ○ sdk-repo      booting (since 2m ago)
  Feed: 4 new entries since you were last here. Use rly status for detail.
  ```
  The `● / ○` glyphs are presentation; the canonical state string (`ready` / `booting`) is what the agent or a downstream parser reads.
- **D-04:** **Snapshot only — no diff machinery.** Hook injects current state every time. Phase 4 ships with zero "last seen" / "diff since last turn" bookkeeping. The only "since-last-time" signal is the `Feed: N new entries` count tail, which is a single integer the hook computes from `feed.jsonl` length minus a per-session `lastSeenFeedIdx` watermark (cheap to add to the existing session.json; if too complex, drop it entirely — still acceptable).
- **D-05:** **No structured diff section.** If the agent wants to know what changed, it can call MCP (`rly status --json` or equivalent) or read the feed via existing tools.
- **D-06:** **Single canonical state enum, used identically across all surfaces.** `type RepoAdminState = "disconnected" | "booting" | "ready" | "stale"`. Mapping rules encoded in `harness-data` as single source of truth:
  - `disconnected` — repo is not in the channel's `repoAssignments[]`.
  - `booting` — `CrosslinkSession` exists, `pid` alive, `lastHeartbeat` fresh, **`readyAt` absent**.
  - `ready` — `CrosslinkSession.readyAt` set.
  - `stale` — `pid` dead OR `heartbeatAge > STALE_HEARTBEAT_MS`.
  Same word in hook output (`booting`), `rly status` (`state=booting`), TUI column (`[BOOTING]`), GUI badge (`🟡 booting`).
- **D-07:** **Muted ready, emphasized exceptions.** `ready` is the expected baseline — plain text, no color, no badge. `booting` gets a warning color/symbol (yellow ○). `stale` gets an error color/symbol (red ×). `disconnected` is dimmed/grayed.

### Claude's Discretion

1. **Codex hook surface** — investigate Codex's hook mechanism, propose (a) Codex-equivalent SessionStart wrapper, (b) per-launch context injection through `rly codex` shim, or (c) ship Claude-only and document the gap.
2. **`rly project show <name>` shape** — extend `rly status`, add `rly channel show <channelId>`, or introduce `rly project show <channelId|name>` as an alias.
3. **`lastSeenFeedIdx` persistence shape** — on `CrosslinkSession`, in a sibling file, or dropped entirely.
4. **State enum naming** — `disconnected | starting | ready | stale` vs `unlinked | onboarding | ready | dead`. Check `src/lifecycle/session-lifecycle.ts` for collisions.
5. **TUI/GUI navigation depth + cmux pane references** — Phase 4 or follow-up.

### Deferred Ideas (OUT OF SCOPE)

- **Top-level Relay Project entity** — explicitly rejected for Phase 4.
- **Structured diff in hook output** — explicitly rejected.
- **cmux pane integration** — planner's call whether in scope.
- **Multi-channel hook output** — Phase 5+ concern.
- **Worker state (Phase 5 / AL-14)** — but Phase 4 surfaces must render workers under spawning admin without code changes (WORKER-06).
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| SURFACE-01 | `SessionStart` hook for Claude (`~/.claude/settings.json`) injects current project state into session's first turn — dropped by `rly install`. | Hook pattern verified in `src/crosslink/hook.ts` (generator) + `src/install/manifest.ts` (drift). Output shape verified via Claude Code docs: `hookSpecificOutput.additionalContext` JSON or plain stdout, 10K char limit, 600s timeout. |
| SURFACE-02 | Codex `SessionStart` equivalent ships parity (or documents the gap explicitly). | **VERIFIED PARITY POSSIBLE.** Codex CLI v0.130 supports `SessionStart` with identical I/O shape. Feature flag: `[features].hooks = true` (legacy `codex_hooks` deprecated as of v0.129). Config in `~/.codex/hooks.json` or `[hooks]` in `~/.codex/config.toml`. Plain stdout also injected as "extra developer context." |
| SURFACE-03 | TUI shows project-rooted view — top-level list of channels, drilling in shows repos × admin state × recent feed events. Reads via `harness-data`. | `tui/src/main.rs` already lists channels (verified line counts around channel rendering). Need to enrich rendering with state column using `load_crosslink_sessions()` + new `derive_state()` helper. |
| SURFACE-04 | GUI matches project-rooted view, with optional cmux pane references. | `gui/src/components/Sidebar.tsx` already buckets channels. Need a repos-and-states row under each channel header. cmux pane refs are planner's call per CONTEXT.md. |
| SURFACE-05 | `rly status` and `rly project show <name>` print terse project state for terminal consumers. | `src/index.ts::printStatus` is the extension point (line 2794). `src/cli/print-status-context.ts` is the precedent for adding a new block (Phase 1 PR-4 added the chat-session block here). |
| SURFACE-06 | Four states (not-connected / alive-not-ready / ready / stale) unambiguous in all surfaces. | D-06 locks the enum. Mapping is mechanical given Phase 3 `CrosslinkSession.readyAt` + existing `STALE_HEARTBEAT_MS = 120_000` (verified `src/crosslink/store.ts:19`). |
| SURFACE-07 | Closing and reopening any surface shows same state — no in-process cache. | All four surfaces must read `~/.relay/` on each render. Hook is reborn each turn; CLI is a one-shot; TUI/GUI use `load_crosslink_sessions()` on every tick (existing pattern — Phase 1 PR-3 already does this for budgets). |
| WORKER-06 | Phase 4 surfaces render workers under their spawning admin without code changes. | **FORWARD-COMPAT CONSTRAINT.** `CrosslinkSession.readyKind` already has `"worker"` reserved (Phase 3 schema). Phase 4's state derivation operates on `CrosslinkSession` records regardless of `readyKind`. The rendering layer (TUI / GUI / hook) must group sessions by `readyKind` so when Phase 5 starts emitting worker records, they auto-appear nested under their spawning admin. Today no worker records exist — rendering must handle the empty-workers case gracefully. |
</phase_requirements>

## Project Constraints (from CLAUDE.md / AGENTS.md)

- **Sub-800 LOC PRs.** One logical change per PR. Phase 4 must split into 4-5 PRs in the same shape as Phases 1-3.
- **No drive-by reformats.** Keep diffs focused.
- **Cross-dashboard contract — same PR.** Any TS shape change must include the Rust mirror (`crates/harness-data/src/lib.rs`) in the SAME PR. Same applies to the four-state enum.
- **No snapshot tests for orchestrator output.** Assert on shape, not stringified blobs. Hook output should be testable as structured data, not a frozen string.
- **Vitest scripted mode is default.** Phase 4 tests should not require `HARNESS_LIVE`.
- **Channel-store.postEntry is append-only.** Never rewrite `feed.jsonl` in place.
- **MCP secrets handling:** Phase 4 doesn't introduce secrets, but if the hook ever logs feed entries, redact via existing patterns. Not in scope today.

## Summary

Phase 4 is the consumer half of Phase 3's readiness primitive. The disk shape (`CrosslinkSession.readyAt` + `readyKind` + the `agent_ready` channel-feed entry) and the Rust read path (`crates/harness-data::load_crosslink_sessions()`) are both shipped and stable. Phase 4's job is **rendering**: four surfaces (SessionStart hook, TUI, GUI, CLI) reading the same disk state through one shared state-derivation function.

The biggest unknown going in was Codex hook parity (Claude's Discretion #1). **Verified resolved**: Codex CLI v0.130+ supports a `SessionStart` lifecycle event with byte-compatible I/O to Claude Code's hook (JSON stdin including `session_id`, `cwd`, `source`; JSON or plain-stdout stdout becomes additional context). The only delta is config location (`~/.codex/hooks.json` vs `~/.claude/settings.json`) and the feature flag (`[features].hooks = true`). Phase 4 can ship true four-surface parity by generating a sibling hook entry for both adapters.

**Primary recommendation:** Land the four-state enum + `derive_state(session, now) -> RepoAdminState` helper in `crates/harness-data` (single source of truth, do-it-once). Mirror the TS type in `src/domain/repo-admin-state.ts`. Wire both Claude `SessionStart` and Codex `SessionStart` through one shared TS generator following `src/crosslink/hook.ts` precedent. Extend `rly install` to write both hook entries idempotently with drift detection (using the existing `installed.json` manifest pattern). For the watermark (D-04), recommend storing `lastSeenFeedIdx` as an optional field on `CrosslinkSession` — single read path, back-compat via `#[serde(default)]`, drop the feature with no schema churn if cost > value.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| State derivation (`session + now -> RepoAdminState`) | Rust shared crate (`harness-data`) | TS mirror (`src/domain/`) | Three consumers (TUI, GUI, hook-via-CLI) need this. Single Rust impl + thin TS mirror keeps drift impossible. |
| `derive_state()` consumed by SessionStart hook | TS (CLI / orchestrator) | — | Hook node script runs under Node — must consume TS. The shape mirrors the Rust enum verbatim. |
| `derive_state()` consumed by TUI | Rust crate (`tui/`) | — | TUI reads `load_crosslink_sessions()` already; adds one call to `derive_state(s, now)` per row. |
| `derive_state()` consumed by GUI | Rust crate (`gui/src-tauri/`) | TS frontend (`gui/src/`) | Tauri backend computes state, frontend just renders strings + colors. |
| `derive_state()` consumed by CLI | TS (`src/index.ts::printStatus`) | — | `rly status` is TS. Uses TS mirror. |
| SessionStart hook script | TS generator (`src/crosslink/hook.ts` pattern) | Generated node script (cold path) | Existing pattern in repo: TS emits a shell + node script pair under `~/.relay/crosslink/hooks/`. Phase 4 adds a sibling `session-start.{sh,mjs}` pair. |
| Hook installation into agent configs | TS (`src/cli/install.ts`) | Install manifest (`installed.json`) | `rly install` owns config-file writes. Drift detection via existing `--check` flow. |
| Hook resolves active channel (env or cwd) | TS (inside generated node script) | `ChannelStore.listChannels` + reverse lookup | Hook needs `repoAssignments[]`. Existing `listChannels()` returns the full list; reverse-lookup scan is O(channels × repos), trivial. |
| TUI rendering: state column on channel drill-in | Rust (`tui/src/ui.rs`) | — | All TUI rendering is Rust. Existing pattern: enrich existing tab. |
| GUI rendering: state badge under each channel | TS/React (`gui/src/components/`) | Tauri command that returns `Vec<(repo, RepoAdminState)>` | Pattern matches existing `RepoChipRow.tsx` — add a state badge alongside the chip. |
| `rly status` repo-state block | TS (`src/cli/print-status-context.ts` precedent) | — | Phase 1 added `formatActiveSessionsBlock`; Phase 4 adds `formatChannelStatesBlock`. |
| `lastSeenFeedIdx` watermark | TS writer (`CrosslinkStore`) | Rust reader (`harness-data`) — read-only | Watermark advances after the hook fires for a session. Optional field. |
| Workers rendered under admin | Rust (`harness-data`) — grouping helper | TUI + GUI consume | `group_by_admin(sessions)` returns `Vec<(admin, Vec<worker>)>`. Empty workers list today; Phase 5 fills it. |

## Standard Stack

### Core (already in repo — Phase 4 consumes, does not add)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `crates/harness-data` | workspace | Single Rust read path for TUI + GUI. Owns `CrosslinkSession` mirror + `load_crosslink_sessions()`. | Established Phase 3 precedent — every cross-dashboard shape lives here. `[VERIFIED: codebase grep, .planning/codebase/ARCHITECTURE.md]` |
| `zod` | (existing) | TS schema for `CrosslinkSession` + new state enum. | Existing convention in `src/domain/`. `[VERIFIED: src/crosslink/types.ts]` |
| `serde` / `serde_json` | (existing, harness-data) | Rust mirror serialization. | Existing convention in `harness-data`. `[VERIFIED: crates/harness-data/Cargo.toml]` |
| Vitest + cargo test | (existing) | Test runners. | Project standard per AGENTS.md. `[VERIFIED: AGENTS.md]` |

### Supporting (Phase 4-specific additions)
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| Claude Code SessionStart hook | N/A (config-only) | Inject channel state at session start. | Per Claude Code docs: output `hookSpecificOutput.additionalContext` (JSON) or plain stdout. Max 10,000 chars; default 600s timeout. `[CITED: code.claude.com/docs/en/hooks]` |
| Codex SessionStart hook | N/A (config-only, v0.130+) | Codex equivalent. | Identical shape to Claude; gated on `[features].hooks = true`. Config in `~/.codex/hooks.json` or `[hooks]` in `~/.codex/config.toml`. `[CITED: developers.openai.com/codex/hooks]` |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `derive_state()` in `harness-data` | Duplicate logic in each consumer (TUI, GUI, hook node script) with shared constants | Duplication risk: same state can mean different things across surfaces if one consumer's mapping drifts. The exact pitfall Phase 3 was designed to prevent. Reject. |
| Per-launch context injection via `rly codex` shim | Wrap `codex` invocations in a Relay shim that pre-prints context | Doesn't fire on user-launched `codex` (only Relay-spawned). Hook approach catches every Codex session, including user-initiated ones. Reject — Codex hook surface is real and stable as of v0.130. |
| Sibling file for `lastSeenFeedIdx` | `~/.relay/crosslink-session/<sid>.watermark.json` | Extra read per hook fire; back-compat is easy but doubles I/O. Field-on-record is cleaner. |
| New top-level `RelayProject` entity | Reject per D-01 (locked). | Out of scope. |
| `RepoAdminState` named `unlinked / onboarding / ready / dead` | — | Naming check ran (see Common Pitfalls #1): no lexical collision in `session-lifecycle.ts`. `disconnected / booting / ready / stale` is fine. |

**Installation:** No new dependencies. Phase 4 is composition of existing primitives.

**Version verification:** `crates/harness-data` is workspace-local; no registry. `zod` and `serde` are already in use. Codex hook stability: v0.130 (May 8, 2026) per official changelog `[CITED: developers.openai.com/codex/changelog]`. Claude Code hooks are stable in 2.1+ (silent injection via `additionalContext`) per official docs `[CITED: code.claude.com/docs/en/hooks]`.

## Architecture Patterns

### System Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Disk authoritative state (~/.relay/)                                        │
│                                                                              │
│  channels/<id>/channel.json   →  Channel.repoAssignments[], primaryWorkspace │
│  channels/<id>/feed.jsonl     →  ChannelEntry[] (Phase 1 + Phase 3 events)   │
│  crosslink-session/<sid>.json →  CrosslinkSession (readyAt, lastHeartbeat,   │
│                                  pid, readyKind?: admin|worker)              │
└──────────────┬────────────────┬───────────────────┬─────────────────────────┘
               │                │                   │
               ▼                ▼                   ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  Shared state-derivation: crates/harness-data                                 │
│                                                                              │
│  load_crosslink_sessions()  →  Vec<CrosslinkSession>                          │
│  derive_state(session, now) →  RepoAdminState                                 │
│  group_by_admin(sessions)   →  Vec<(Admin, Vec<Worker>)>     (WORKER-06)     │
│  (Rust impl + thin TS mirror in src/domain/repo-admin-state.ts)              │
└──────┬───────────────────┬──────────────────┬──────────────────┬─────────────┘
       │                   │                  │                  │
       ▼                   ▼                  ▼                  ▼
┌──────────────┐  ┌──────────────────┐  ┌────────────────┐  ┌───────────────┐
│ SessionStart │  │ TUI (tui/src/)   │  │ GUI (gui/)     │  │ CLI           │
│ hook         │  │                  │  │ Tauri cmd ⇄    │  │ rly status    │
│              │  │ Per-channel pane │  │ React badges   │  │ rly project   │
│ Claude:      │  │ shows repo ×     │  │                │  │   show <name> │
│ ~/.claude/   │  │ state column     │  │ Sidebar +      │  │   (planner's  │
│ Codex:       │  │                  │  │ ChannelHeader  │  │    call)      │
│ ~/.codex/    │  │                  │  │ get repo chip  │  │               │
│ hooks.json   │  │                  │  │ + state badge  │  │               │
└──────┬───────┘  └──────────────────┘  └────────────────┘  └───────────────┘
       │
       │  injects ~5-15 line context at session start
       ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ Agent's first turn (Claude or Codex)                                          │
│ "Channel: oauth-rollout (3 repos)                                             │
│    ● ui-repo       ready (admin: atlas-7f2)                                  │
│    ● backend-repo  ready (admin: atlas-3a1)                                  │
│    ○ sdk-repo      booting (since 2m ago)                                    │
│  Feed: 4 new entries since you were last here."                              │
└──────────────────────────────────────────────────────────────────────────────┘

Hook installation flow (rly install — extended by Phase 4):
  rly install  →  generateSessionStartHookScripts()  →  ~/.relay/crosslink/hooks/session-start.{sh,mjs}
              →  writeClaudeSettings()  →  ~/.claude/settings.json  (idempotent)
              →  writeCodexHooks()      →  ~/.codex/hooks.json      (idempotent)
              →  markInstalled() updates ~/.relay/installed.json
  rly install --check  →  reports hook drift if user removed entries
```

### Recommended Project Structure (Phase 4 additions)
```
src/
├── domain/
│   └── repo-admin-state.ts          # NEW: TS mirror of Rust enum + derive_state shim
├── crosslink/
│   ├── hook.ts                      # EXTEND: add generateSessionStartHookScripts()
│   └── session-start-hook-content.ts # NEW: pure formatter (testable in isolation)
├── cli/
│   ├── install.ts                   # EXTEND: wire SessionStart hooks for Claude + Codex
│   ├── print-status-context.ts      # EXTEND: add formatChannelStatesBlock()
│   └── channel-show.ts              # NEW (if planner picks rly channel/project show)
└── install/
    └── manifest.ts                  # EXTEND: hook entries in manifest for drift

crates/harness-data/
└── src/lib.rs                       # EXTEND: RepoAdminState enum + derive_state + group_by_admin

tui/src/
├── main.rs                          # EXTEND: render channel rows with state column
└── ui.rs                            # EXTEND: state column formatter

gui/src-tauri/src/
└── lib.rs                           # EXTEND: Tauri cmd returning Vec<(repo, RepoAdminState)>

gui/src/
└── components/
    ├── ChannelHeader.tsx            # EXTEND: state badge row under header
    └── RepoChipRow.tsx              # EXTEND: state badge next to chip
```

### Pattern 1: State Derivation as a Pure Function in `harness-data`
**What:** Single Rust function `derive_state(&CrosslinkSession, now: i64) -> RepoAdminState`. Pure (no IO). Mirrors a thin TS shim that does the same on the TS side.
**When to use:** Every consumer (hook, TUI, GUI, CLI). Never re-derive in a consumer.
**Example:**
```rust
// crates/harness-data/src/lib.rs (Phase 4 addition)
// Source: derives from existing STALE_HEARTBEAT_MS in src/crosslink/store.ts:19
#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RepoAdminState {
    Disconnected,
    Booting,
    Ready,
    Stale,
}

pub const STALE_HEARTBEAT_MS: i64 = 120_000;

pub fn derive_state(session: &CrosslinkSession, now_ms: i64) -> RepoAdminState {
    let alive = is_pid_alive(session.pid);
    let hb = parse_iso(&session.last_heartbeat).unwrap_or(0);
    let hb_age = now_ms - hb;
    if !alive || hb_age > STALE_HEARTBEAT_MS {
        return RepoAdminState::Stale;
    }
    if session.ready_at.is_some() {
        return RepoAdminState::Ready;
    }
    RepoAdminState::Booting
}
// Note: "disconnected" is decided at the channel level, not the session level —
// it means "no CrosslinkSession exists for this repo assignment." The channel-
// rendering layer calls derive_state only for repos with a session; absence
// maps to disconnected directly.
```

### Pattern 2: Hook Generator + Install Wiring (extension of existing `src/crosslink/hook.ts`)
**What:** TS generator emits a shell wrapper + Node script pair under `~/.relay/crosslink/hooks/` (existing convention). `rly install` writes the entry into both `~/.claude/settings.json` and `~/.codex/hooks.json` idempotently.
**When to use:** Phase 4 SessionStart hook.
**Example:**
```ts
// Source: src/crosslink/hook.ts generateHookScripts() — Phase 4 sibling.
// The output node script for SessionStart:
//   - reads stdin JSON (Claude/Codex schema is compatible)
//   - resolves active channel (D-02): env RELAY_CHANNEL_ID OR cwd reverse lookup
//   - loads CrosslinkSession records via direct fs read of crosslink-session/
//   - derives state per repo, formats per D-03, prints to stdout
//   - exit 0 on success, exit 0 on no-channel (graceful no-op)
```

### Pattern 3: Hook Output Shape — Plain Stdout + JSON Wrapper
**What:** Both Claude Code and Codex accept either (a) raw stdout (treated as additional context) or (b) JSON with `hookSpecificOutput.additionalContext`. Phase 4 should emit raw stdout for simplicity — exit 0, multi-line context block. This works for both adapters with zero adapter-specific branching.
**When to use:** SessionStart hook output.
**Example:**
```bash
# Output to stdout (works for both Claude SessionStart and Codex SessionStart):
[Relay] Channel: oauth-rollout (3 repos)
  ● ui-repo       ready (admin: atlas-7f2)
  ● backend-repo  ready (admin: atlas-3a1)
  ○ sdk-repo      booting (since 2m ago)
Feed: 4 new entries since you were last here. Use `rly status` for detail.
```
**Source:** `[CITED: code.claude.com/docs/en/hooks]` (Plain stdout reaches Claude for SessionStart), `[CITED: developers.openai.com/codex/hooks]` ("Plain text on stdout also gets added as 'extra developer context.'").

### Pattern 4: Channel-First Resolution (D-02 cwd reverse lookup)
**What:** Hook walks `listChannels()`, picks the channel whose `repoAssignments[].repoPath` is a prefix of `cwd` (or matches exactly). Tie-break: most-recently-touched channel (use `updatedAt`).
**When to use:** Hook fires from a session with no `RELAY_CHANNEL_ID` (ad-hoc `rly claude`, user `claude` invocation).
**Example:**
```ts
// Source: src/domain/channel.ts::Channel.repoAssignments[] (verified)
function resolveActiveChannel(cwd: string, channels: Channel[]): Channel | null {
  const candidates = channels.filter(c =>
    c.status === "active" &&
    (c.repoAssignments ?? []).some(ra =>
      cwd === ra.repoPath || cwd.startsWith(ra.repoPath + "/")
    )
  );
  if (candidates.length === 0) return null;
  // Most-recently-updated wins on ties.
  return candidates.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
}
```

### Anti-Patterns to Avoid

- **Re-deriving state in each consumer.** Every surface must call the SAME `derive_state()` function. Embedding the if/else mapping in three places (TUI render, GUI Tauri cmd, hook node script) is the exact failure mode Phase 3's "alive ≠ ready" lesson teaches. The state-derivation function MUST live in `harness-data` and have an exact TS mirror.

- **Hard-coding the `STALE_HEARTBEAT_MS` threshold in multiple places.** Today `src/crosslink/store.ts:19` has it. Phase 4 adds a Rust mirror. Both must reference the same value. Bumping it later requires changing one place; TS imports from a shared const file or the Rust const is documented as authoritative.

- **Reading `crosslink-session/` through `CrosslinkStore.discoverSessions()`.** That method **auto-deregisters** sessions older than `STALE_HEARTBEAT_MS` (verified `src/crosslink/store.ts:265-268`: `if (stale) await this.deregisterSession(...)`). Phase 4 needs to OBSERVE `stale` state, not delete it. Use `load_crosslink_sessions()` from Rust (read-only, returns raw) or a new read-only TS sibling like `listSessionsRaw()`. **DO NOT call `discoverSessions()` from hook node script.**

- **Hook output that looks like system instructions.** Per Claude Code docs: phrasing like "You MUST do X" can trigger prompt-injection defenses and surface the text to the user instead of injecting as context. Use factual statements: "Channel: oauth-rollout. SDK admin is booting." not "ATTENTION: SDK is booting, do not dispatch yet." `[CITED: code.claude.com/docs/en/hooks]`

- **Blocking the hook on slow IO.** SessionStart fires on every session start/resume. The node script must read at most: `channel.json` (one channel × small file), `feed.jsonl` (last N lines), `crosslink-session/*.json` (small). Target: < 100ms wall-clock. Hook has 600s default timeout but the user perceives this as "Claude takes ages to start." Same fast-path as existing `check-messages.mjs`.

- **Mutating disk in the hook.** The hook is a reader. Exception: `lastSeenFeedIdx` watermark (D-04) IS a write, but ONLY for the resolved active session. If write fails (permission, disk full), the hook still succeeds — watermark is best-effort.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| State derivation logic | Custom mapping in each surface | `derive_state()` in `harness-data` (Rust) + TS mirror in `src/domain/repo-admin-state.ts` | Phase 3's exact lesson: divergent definitions of "ready" ship a lying dashboard. |
| SessionStart hook output formatting | Adapter-specific JSON shapes (one for Claude, one for Codex) | Plain stdout — both adapters treat stdout as additional context | Same plain-text output works for both adapters. Single formatter, single test surface. |
| Reverse lookup `cwd → channel` | Custom prefix-matching with edge cases | Pattern in Pattern 4 above — `cwd.startsWith(ra.repoPath + "/")` with most-recent-updatedAt tie-break | Two-line predicate. Existing `Channel.repoAssignments[]` already has the data. |
| `lastSeenFeedIdx` persistence | Sibling file `<sid>.watermark.json` | Optional field on `CrosslinkSession` with `#[serde(default)]` Rust + `.optional()` zod | Halves I/O. Back-compat is automatic. Drop the field entirely if it complicates Phase 4 — Phase 4 still ships honest state without "N new entries." |
| Hook installation drift detection | Custom file-watcher or hash-check | Extend existing `~/.relay/installed.json` manifest (`src/install/manifest.ts`) with a `hooks: { claude: { sha }, codex: { sha } }` block | The pattern is `rly install --check` already (verified `src/install/manifest.ts:diffSurface`). Same shape for hook entries. |
| State-color presentation logic | Re-implement per surface | Surface-specific renderer consumes the canonical state string — TUI uses `Style::default().fg(Color::Yellow)` for `Booting`; GUI uses CSS class `.state-booting`; hook prints `○` glyph | Per D-07 the color/glyph mapping IS per-surface; the STATE STRING is canonical. |
| Process-liveness check | Custom `kill -0`-style probe in three places | Existing helpers: TS `isProcessAlive(pid)` (verified pattern in `src/crosslink/hook.ts:161-167`); Rust equivalent in `harness-data` (likely needs to be added — verify in plan-phase) | Borrow the TS impl pattern; the Rust impl is a `kill(pid, 0)` syscall via `nix` or a 4-line custom Unix helper. Already needed for the stale state. |

**Key insight:** Phase 4 is a *composition* phase. Every primitive (readiness flag, channel structure, hook scaffolding, install manifest, channel feed) exists. The wins come from disciplined single-source-of-truth refactoring (state derivation lives in ONE place) and avoiding the temptation to "improve" things while passing through (no drive-by reformats per AGENTS.md).

## Runtime State Inventory

> Phase 4 is mostly additive — net-new code, net-new hook entries. There IS one rename / install-side runtime concern (hook entries in user config files outside the repo). Inventory below.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | None new. Phase 4 READS `~/.relay/crosslink-session/`, `channels/<id>/feed.jsonl`, `channels/<id>/channel.json` — all existing. Optionally WRITES `lastSeenFeedIdx` field on existing `CrosslinkSession` records (back-compat default). | If watermark adopted: add field with `#[serde(default)]` Rust + `.optional()` zod. Older session.json files deserialize cleanly. |
| Live service config | **`~/.claude/settings.json`** — Phase 4 adds a `hooks.SessionStart` entry. Lives in user's home, NOT in git. `rly install` owns the write. **`~/.codex/hooks.json`** (or `[hooks]` in `~/.codex/config.toml`) — same. **`~/.codex/config.toml`** — Phase 4 must enable `[features].hooks = true` (Codex v0.130+). | `rly install` writes both files idempotently. `rly install --check` detects drift (user manually edited / removed). |
| OS-registered state | None. Phase 4 does not register OS services, scheduled tasks, or daemons. | None. |
| Secrets/env vars | None new. Phase 4 reads `RELAY_CHANNEL_ID` (set by Phase 3 spawner) and `RELAY_SESSION_ID`. No new env vars introduced. | None. |
| Build artifacts | Phase 4 doesn't change the build. Hook scripts are generated at `rly install` time, not at `pnpm build` time. | None. |

**Cross-version concern:** A user on Codex < v0.130 has no `SessionStart` hook surface. `rly install` should detect Codex version (best-effort: `codex --version` parsed for major-minor) and either skip Codex hook wiring with a warning OR write the config anyway (Codex < v0.130 will ignore the `[hooks]` block silently — verify). Recommend: write unconditionally, log a one-line note that Codex hooks need v0.130+, fail-soft.

## Common Pitfalls

### Pitfall 1: Lexical collision between `RepoAdminState = "ready"` and `RepoAdminSession._state = "ready"`
**What goes wrong:** Phase 3 left a deferred follow-up: `RepoAdminSession._state` (process-spawn state, `src/orchestrator/repo-admin-session.ts:90`) uses the word "ready" to mean "process is spawned." Phase 4's new `RepoAdminState.ready` means "agent finished onboarding." Reading two pieces of code that use the same string for different concepts is a maintenance booby trap.
**Why it happens:** Renaming `_state` to `_processState` was deferred from Phase 3 (Open Follow-up #1 in `03-SUMMARY.md`).
**How to avoid:** Phase 4 should either:
  - (a) Bundle the rename `_state → _processState` into Phase 4's first wave (mechanical, < 50 LOC per Phase 3 SUMMARY), OR
  - (b) Defer the rename but add a clarifying comment block at `repo-admin-session.ts:90` distinguishing `_processState` (process spawn) from `RepoAdminState.ready` (agent assertion).
  Recommended: **(a)** — Phase 4 introduces the four-state enum, so this is the moment to flatten the naming. The rename is non-behavioral; it's just `git grep _state` and rename.
**Warning signs:** Reviewer asks "wait, which 'ready' is this?" in PR review.

### Pitfall 2: Hook fires from a session OUTSIDE any channel
**What goes wrong:** User runs `claude` in a directory that's not in any channel's `repoAssignments[]`. The hook resolves null. If the hook fails loudly, every non-Relay Claude session shows an error.
**Why it happens:** Hook is registered globally in `~/.claude/settings.json`. It fires on every Claude session, not just Relay-spawned ones.
**How to avoid:** Hook MUST exit 0 with empty stdout when no active channel resolves. This is the "graceful no-op" path called out in D-02. Existing `src/crosslink/hook.ts` already follows this pattern (line 98-100: `if (!mySession) process.exit(0)`). Mirror exactly.
**Warning signs:** Any error message in stdout/stderr when running `claude` outside a Relay channel.

### Pitfall 3: `CrosslinkStore.discoverSessions()` auto-deregisters stale sessions
**What goes wrong:** Phase 4 wants to show `stale` repos as a distinct state. If the surface calls `discoverSessions()` to read sessions, stale ones get DELETED from disk before they're rendered (verified `src/crosslink/store.ts:265-268`).
**Why it happens:** `discoverSessions()` was designed as a write-back cleanup helper, not a read-only enumerator.
**How to avoid:** Phase 4 surfaces read RAW sessions via:
  - Rust: `load_crosslink_sessions()` (no auto-cleanup; verified `crates/harness-data/src/lib.rs:633`).
  - TS hook node script: direct fs read of `crosslink-session/*.json` (the existing hook already does this — verified `src/crosslink/hook.ts:71-96`).
  Phase 4's `derive_state()` distinguishes alive-but-stale-heartbeat from dead-PID without ever calling `discoverSessions`.
**Warning signs:** "Stale" state never observable in dashboards because sessions vanish as soon as they go stale.

### Pitfall 4: `feed.jsonl` torn last line
**What goes wrong:** Hook reads `feed.jsonl` for the "N new entries" count. If the file has a torn last line (concurrent appender mid-write), `JSON.parse` throws.
**Why it happens:** `feed.jsonl` is append-only with `appendFile`. No fsync. A reader can observe a partial line during write.
**How to avoid:** Follow existing tolerance pattern — `try/catch` per line, skip malformed lines. `ChannelStore.readFeed` already does this for the bulk read (verified `src/channels/channel-store.ts:658-682`, though it loads the whole file). For the hook's count-only path, count lines, attempt to parse last line, skip on error. Per Phase 1 design doc: "A torn last line is silently skipped by the Rust reader and recovers on the next render cycle." `[CITED: docs/design/context-threshold-events.md]`
**Warning signs:** "Feed: N new entries" count occasionally off by one during heavy write traffic. Acceptable.

### Pitfall 5: Codex `[features].hooks` feature flag not enabled by default
**What goes wrong:** User has Codex installed but never enabled hooks; `rly install` writes `~/.codex/hooks.json` but Codex silently ignores it.
**Why it happens:** Codex hooks are opt-in via `[features].hooks = true` in `~/.codex/config.toml` (legacy: `codex_hooks`, deprecated). `[CITED: developers.openai.com/codex/hooks, developers.openai.com/codex/config-reference]`
**How to avoid:** `rly install` should also touch `~/.codex/config.toml` and ensure `[features].hooks = true` is present (idempotent merge — read the file, set the key, write back). Same pattern as writing hooks.json. Surface a one-line note in install output: "Enabled Codex hooks feature flag in ~/.codex/config.toml."
**Warning signs:** `rly install --check` says Codex hook is installed but agents don't see the injected context.

### Pitfall 6: SessionStart hook timeout — multi-second startup
**What goes wrong:** Hook does too much IO (reads every channel JSON, every feed.jsonl, every session record), takes > 1 second, user perceives Claude/Codex as sluggish.
**Why it happens:** Naive implementation: load all channels, scan all sessions, render context.
**How to avoid:**
  - Resolve active channel FIRST (one file read if `RELAY_CHANNEL_ID` is set, or one O(channels) scan).
  - Read ONLY that channel's `channel.json` and `feed.jsonl` (tail).
  - Read ONLY the `CrosslinkSession` records whose channel matches (via the `channelId` field on the record — verified `crates/harness-data/src/lib.rs:610` has `pub channel_id: Option<String>`).
  - Target wall-clock: < 100ms. Existing crosslink hook is a useful reference for the IO budget.
**Warning signs:** User says "Claude takes longer to start now."

### Pitfall 7: Channel `status === "archived"` channels still listed
**What goes wrong:** TUI/GUI top-level show every channel including archived ones. UX clutter.
**Why it happens:** `listChannels()` returns all channels by default; takes optional `status` filter.
**How to avoid:** Surfaces filter to `status === "active"` (per D-01 wording: "filtered by `status === 'active'` or similar"). PR-review DMs (`kind: "dm"`) are out of scope for Phase 4 rendering — defer to follow-up.
**Warning signs:** Old archived channels clutter the project list.

## Code Examples

Verified patterns from existing code and official sources.

### Hook node script — read CrosslinkSession records (existing pattern)
```ts
// Source: src/crosslink/hook.ts:60-96 (existing UserPromptSubmit hook).
// Phase 4 SessionStart hook reuses this exact fs-read pattern.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const RELAY_DIR = ${JSON.stringify(relayDir)};
const SESSIONS_DIR = join(RELAY_DIR, "crosslink-session");

async function loadSessionsForChannel(channelId: string) {
  const sessions = [];
  for (const file of await safeReaddir(SESSIONS_DIR)) {
    if (!file.endsWith(".json")) continue;
    try {
      const raw = JSON.parse(await readFile(join(SESSIONS_DIR, file), "utf8"));
      if (raw.channelId === channelId) sessions.push(raw);
    } catch { /* skip malformed */ }
  }
  return sessions;
}
```

### State derivation (TS mirror)
```ts
// Source: src/domain/repo-admin-state.ts (NEW — Phase 4).
// Mirrors Rust enum + derive_state in crates/harness-data.
export type RepoAdminState = "disconnected" | "booting" | "ready" | "stale";
export const STALE_HEARTBEAT_MS = 120_000; // mirror of src/crosslink/store.ts:19

export function deriveRepoAdminState(
  session: { pid: number; lastHeartbeat: string; readyAt?: string | null } | null,
  nowMs: number,
  isProcessAlive: (pid: number) => boolean
): RepoAdminState {
  if (!session) return "disconnected";
  const hb = new Date(session.lastHeartbeat).getTime();
  const alive = isProcessAlive(session.pid);
  if (!alive || nowMs - hb > STALE_HEARTBEAT_MS) return "stale";
  if (session.readyAt) return "ready";
  return "booting";
}
```

### SessionStart hook output formatter (testable in isolation)
```ts
// Source: src/crosslink/session-start-hook-content.ts (NEW — Phase 4).
// Pure formatter — no IO — so vitest can assert shape without fixtures.
export interface RepoState {
  alias: string;
  state: RepoAdminState;
  adminAlias?: string;            // "atlas-7f2"
  bootingSinceMs?: number;        // wall-clock since session registered
}

export function formatSessionStartContext(input: {
  channelName: string;
  repoStates: RepoState[];
  newFeedEntries?: number;        // optional (D-04 — droppable)
}): string {
  const lines: string[] = [];
  lines.push(`[Relay] Channel: ${input.channelName} (${input.repoStates.length} repos)`);
  for (const r of input.repoStates) {
    const glyph = glyphFor(r.state);
    const detail = detailFor(r);   // "(admin: atlas-7f2)" or "(since 2m ago)"
    lines.push(`  ${glyph} ${r.alias.padEnd(14)} ${r.state}${detail ? " " + detail : ""}`);
  }
  if (input.newFeedEntries !== undefined && input.newFeedEntries > 0) {
    lines.push(`Feed: ${input.newFeedEntries} new entries since you were last here. Use \`rly status\` for detail.`);
  }
  return lines.join("\n");
}
```

### Claude SessionStart hook config write (extension of `rly install`)
```ts
// Source: src/cli/install.ts (extension — Phase 4).
// Idempotent merge — preserves existing user-configured hooks.
const claudeSettingsPath = join(homedir(), ".claude", "settings.json");
const existing = await readJsonSafe(claudeSettingsPath, { hooks: {} });
existing.hooks = existing.hooks ?? {};
existing.hooks.SessionStart = existing.hooks.SessionStart ?? [];
// Find Relay's entry (matcher tag we own) — replace or append.
const relayMatcherTag = "relay-channel-readiness";
existing.hooks.SessionStart = existing.hooks.SessionStart.filter(
  (h: any) => h.matcher !== relayMatcherTag
);
existing.hooks.SessionStart.push({
  matcher: relayMatcherTag,
  hooks: [{ type: "command", command: sessionStartHookScriptPath, timeout: 30 }],
});
await writeJsonAtomic(claudeSettingsPath, existing);
```

### Codex SessionStart hook config write
```ts
// Source: src/cli/install.ts (Phase 4 sibling).
// ~/.codex/hooks.json is the cleanest path — TOML edits are messier.
const codexHooksPath = join(homedir(), ".codex", "hooks.json");
const existing = await readJsonSafe(codexHooksPath, { hooks: {} });
existing.hooks = existing.hooks ?? {};
existing.hooks.SessionStart = existing.hooks.SessionStart ?? [];
existing.hooks.SessionStart = existing.hooks.SessionStart.filter(
  (h: any) => h.matcher !== relayMatcherTag
);
existing.hooks.SessionStart.push({
  matcher: relayMatcherTag,
  hooks: [{ type: "command", command: sessionStartHookScriptPath, timeout: 30 }],
});
await writeJsonAtomic(codexHooksPath, existing);

// Also ensure [features].hooks = true in ~/.codex/config.toml (idempotent).
await ensureCodexFeatureFlag("hooks", true);
```

### `rly status` channel-states block (extension of `print-status-context.ts`)
```ts
// Source: src/cli/print-status-context.ts (Phase 4 extension).
// Mirrors formatActiveSessionsBlock — pure formatter taking pre-resolved rows.
export function formatChannelStatesBlock(rows: ChannelStateRow[]): string {
  if (rows.length === 0) return "";
  const lines = ["Channels:"];
  for (const ch of rows) {
    lines.push(`- ${ch.name} (${ch.repos.length} repos)`);
    for (const r of ch.repos) {
      const detail = r.adminAlias ? ` admin=${r.adminAlias}` : "";
      lines.push(`    ${r.alias.padEnd(12)} ${r.state}${detail}`);
    }
  }
  return lines.join("\n");
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Codex CLI without hooks | Codex CLI with `SessionStart` lifecycle event | v0.130 (May 8, 2026); v0.129 deprecated `codex_hooks` flag for `hooks` | **Enables four-surface parity for Phase 4.** Without v0.130, Codex would be hook-less and SURFACE-02 would document a gap. With v0.130, parity is achievable today. `[CITED: developers.openai.com/codex/hooks, agenticcontrolplane.com/blog/codex-cli-hooks-reference]` |
| Claude Code SessionStart hooks display user-visible messages | Silent context injection via `hookSpecificOutput.additionalContext` | Claude Code 2.1.0+ | Phase 4 should NOT emit user-visible "Relay is reading channel state" notifications. Inject silently as context. `[CITED: code.claude.com/docs/en/hooks]` |
| Phase 3's "alive ≠ ready" was an open question | Shipped primitive: `CrosslinkSession.readyAt` + `agent_ready` MCP tool + Rust mirror | Phase 3 (#216, 2026-05-09; SUMMARY #221) | Phase 4 has a stable contract to consume. |

**Deprecated/outdated:**
- `[features].codex_hooks = true` is deprecated as of Codex v0.129; use `[features].hooks = true`. Phase 4 install code must write the new key. `[CITED: developers.openai.com/codex/changelog]`
- Pre-2.1 Claude Code hook patterns that printed user-visible messages are obsolete; SessionStart now silently injects context. `[CITED: code.claude.com/docs/en/hooks]`

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Codex `SessionStart` hook accepts plain stdout as "extra developer context" (identical to Claude Code SessionStart). | Standard Stack, Pattern 3 | LOW — both official docs confirm. If wrong, fall back to JSON-only output. Single conditional in formatter. |
| A2 | Codex hook stdin schema is approximately compatible with Claude's (both include `session_id`, `cwd`, `source` — verified per official docs). The hook node script should not need adapter-specific parsing. | Pattern 2 | LOW — verified in both docs. If stdin shapes diverge in field naming, the script just reads what it needs (`session_id` is universal) and ignores absent fields. |
| A3 | Users on Codex < v0.130 will silently ignore the `[hooks]` config block without crashing. | Runtime State Inventory (cross-version concern) | MEDIUM — not verified. If Codex < v0.130 errors on unknown config, `rly install` needs version detection. **Recommend planner adds a `codex --version` probe in install step to surface a warning.** |
| A4 | Storing `lastSeenFeedIdx` as an optional field on `CrosslinkSession` is the cleanest watermark shape. | Don't Hand-Roll, D-04 | LOW — back-compat is via `#[serde(default)]` + zod `.optional()`. Worst case the field is dropped before ship; Phase 4 still satisfies SURFACE-01..07 without the "N new entries" counter. |
| A5 | The TS-side `isProcessAlive(pid)` pattern (`process.kill(pid, 0)`) generalizes to Rust via `nix::sys::signal::kill(pid, None)` or equivalent. | Pattern 1, Don't Hand-Roll | LOW — standard syscall. Likely there's already a Rust helper somewhere in `harness-data` or it's a 4-line addition. |
| A6 | `Channel.updatedAt` is reliably maintained and usable for tie-breaking when cwd resolves to >1 channel. | Pattern 4 | LOW — `Channel.updatedAt` is verified in `src/domain/channel.ts:191`. `ChannelStore.touchChannel` keeps it fresh on writes (referenced in `channel-store.ts:55`). |
| A7 | The four-state enum names (`disconnected | booting | ready | stale`) do not collide lexically with `src/lifecycle/session-lifecycle.ts` states (`planning | dispatching | winding_down | audit | done | killed`). | Common Pitfalls #1 | VERIFIED in research: zero overlap with `LifecycleState` enum. Slight conceptual proximity to `RepoAdminSession._state="ready"` (deferred follow-up). |

## Open Questions (RESOLVED)

> All five planner-facing open questions are resolved. The plans implement the decisions noted below. The duplicate `### Open Questions (planner-facing)` block that previously appeared near the end of this file has been merged into this section to keep a single source of truth.

1. **Codex install version probe**
   - **RESOLVED:** `spawnSync("codex", ["--version"], { timeout: 2000 })` in `rly install` (Plan 03 Task 3). On `ENOENT` or detected `<v0.130`, log a friendly one-line note ("Codex hooks require v0.130+; current: <version>; config will be written but inactive until upgrade") and WRITE the hook config anyway (fail-soft). Older Codex silently ignores unknown `[hooks]` blocks per assumption A3 — verified acceptable.
   - What we know: Codex v0.130+ supports hooks; older versions ignore the config silently (assumption A3).
   - What's unclear: behavior on Codex pre-v0.129 (when `[features].hooks` did not exist and `codex_hooks` was the flag). Some users may have Codex but never have run `--enable hooks`.
   - Recommendation: `rly install` runs `codex --version`, parses, surfaces a one-line note if < v0.130, but writes the config anyway. Document the version requirement in the install output and the SUMMARY.

2. **`rly project show <name>` vs `rly channel show <channelId>` vs extending `rly status`**
   - **RESOLVED:** Ship BOTH `rly channel show <id|name>` (canonical, per D-01 channel-IS-project) AND `rly project show <id|name>` as an alias dispatching to the same handler (Plan 05 Task 2). ALSO extend `rly status` with a channel-roll-up block via `formatChannelStatesBlock` (Plan 05 Task 1). Alias equivalence is locked in Plan 05 Task 2 case 8 (unit-level dispatch import OR subprocess byte-identical stdout — see Plan 05).
   - What we know: D-01 says channel IS the project. ROADMAP says `rly project show <name>` is the suggestion.
   - What's unclear: which CLI surface the user actually reaches for. "rly status" is already cluttered with workspace + sessions + recent-runs blocks.
   - Recommendation (for planner): introduce `rly channel show <channelId|name>` as the canonical drill-in; alias `rly project show <name>` to the same handler (deprecation-friendly — if "project" becomes a first-class entity later, `rly project show` already exists). Extend `rly status` minimally (just a channel-roll-up — one line per active channel summarizing repo states, no per-repo detail).

3. **`_state → _processState` rename (bundle into Phase 4 or defer further)**
   - **RESOLVED:** BUNDLE into Wave 1 / Plan 01 Task 3. The rename is mechanical (~50 LOC, `git grep _state` in `src/orchestrator/repo-admin-session.ts` and call sites). Lands in the same PR that introduces `RepoAdminState`, flattening the naming collision noted in Common Pitfalls #1 in a single change. Phase 3 Open Follow-up #1 closes.
   - What we know: Phase 3 left `RepoAdminSession._state` ambiguously named; Phase 4's `RepoAdminState.ready` collides conceptually.
   - What's unclear: whether the rename is best bundled with Phase 4's enum introduction or deferred to a standalone hygiene PR.
   - Recommendation: bundle into Wave 1 — the enum landing is the right moment to fix the name.

4. **Watermark cost-vs-value (D-04 droppable)**
   - **RESOLVED:** IN — `lastSeenFeedIdx` ships in Phase 4 (Plan 02 Task 3). Shape: optional field `lastSeenFeedIdx?: number` on `CrosslinkSession` with `#[serde(default, skip_serializing_if = "Option::is_none")]` (Rust) + `.optional()` (zod). Monotonic write site via `CrosslinkStore.advanceFeedWatermark`. Total cost ~30 LOC; back-compat automatic. Hook (Plan 02 Task 2) emits the `Feed: N new entries` tail ONLY when a `mySession` record is found by matching `process.env.RELAY_SESSION_ID` — for user-launched (non-Relay-spawned) Claude/Codex sessions, the Feed tail is omitted entirely.
   - What we know: Field-on-record adds minimal complexity (one optional field + one write site at the end of hook).
   - What's unclear: whether the "N new entries since" line is noise or signal. The user's CONTEXT.md explicitly allows dropping it.
   - Recommendation: ship the watermark in Phase 4. Cost is ~30 LOC (schema + write site + hook count logic). If reviewer pushes back, drop it without touching the rest of the plan.

5. **cmux pane references in Phase 4 vs follow-up**
   - **RESOLVED:** DEFER to follow-up — captured in 04-SUMMARY follow-ups list (Plan 05 Task 4). Phase 4 already covers 5 surfaces × state-derivation × dual-adapter hook install; cmux is a single-line "open external app" call that can land in a follow-up PR without touching any Phase 4 contract.
   - What we know: ROADMAP mentions cmux integration; not in D-01..D-07 locked decisions.
   - What's unclear: whether cmux is installed for most Relay users; how the "jump to pane" UX works without it.
   - Recommendation: **defer cmux to a follow-up.** Phase 4 already has 5 surfaces × state-derivation × hook install — enough scope. cmux is a single-line "open external app" call that can land in a follow-up PR without touching any Phase 4 contracts.

6. **State-derivation placement (Rust authoritative vs TS shim)** *(originally Q3; superseded by rename Q3 above — kept here for historical traceability)*
   - **RESOLVED:** Rust authoritative + thin TS mirror. `crates/harness-data` owns `derive_state`; `src/domain/repo-admin-state.ts` mirrors via `deriveRepoAdminState` for the hook + CLI. Same-PR cross-dashboard rule applies (any change to either side requires the other in the same PR). Implemented in Plan 01.
   - What we know: TUI and GUI both consume Rust. Hook node script and `rly status` consume TS. Both need the same logic.
   - What's unclear: whether TS should call out to a Rust helper (via subprocess or wasm) or maintain its own mirror.
   - Recommendation: maintain a thin TS mirror in `src/domain/repo-admin-state.ts` — keeps both surfaces fast (no IPC for hook), but the function is small enough that drift is rare. Same shape as Phase 3's pattern (CrosslinkSession exists in TS and Rust; updates land in same PR per AGENTS.md).

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node (runs generated hook script) | Hook node script | Assumed (existing convention; `src/crosslink/hook.ts:42` already checks `which node`) | — | Hook exits 0 with no output if node missing (existing pattern). |
| `~/.claude/settings.json` | Claude SessionStart hook | Created by user when they install Claude Code | — | If file absent, `rly install` creates it with a `{ "hooks": { "SessionStart": [...] } }` skeleton. |
| `~/.codex/hooks.json` (or config.toml) | Codex SessionStart hook | Created by Codex v0.130+ | v0.130+ | Skip Codex hook install with a clear warning if Codex < v0.130. |
| Codex CLI v0.130+ | SURFACE-02 parity | User-dependent | — | Document the gap in `rly install --check` output. |
| `process.kill(pid, 0)` for liveness check | State derivation (TS) | POSIX-standard | — | Existing pattern; already used in `src/crosslink/hook.ts:161-167`. |
| Rust `kill(pid)` syscall for liveness check | State derivation (Rust) | Via `nix` or libc | — | Verify a Rust helper exists or add a 4-line wrapper. |
| Existing `~/.relay/installed.json` manifest | Hook drift detection | Yes, created by `rly install` (#208) | schemaVersion: 1 | Bump schemaVersion to 2 OR add hooks block as additive (recommend additive). |

**Missing dependencies with no fallback:** None. Every dependency has a graceful path.

**Missing dependencies with fallback:**
- Codex < v0.130 — install writes config anyway with a warning (assumption A3) or skips with a warning. Either is acceptable.

## Validation Architecture

> `workflow.nyquist_validation` is `false` in `.planning/config.json` — this section is intentionally minimal, but Phase 4 inherits the test conventions from AGENTS.md and Phases 1-3.

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest (TS) + cargo test (Rust) — existing per AGENTS.md |
| Config file | `vitest.config.ts` (TS); per-crate `Cargo.toml` (Rust) |
| Quick run command | `pnpm test <path-glob>` (TS) / `cargo test -p harness-data <name>` (Rust) |
| Full suite command | `pnpm test && pnpm typecheck && pnpm build && cargo check --workspace --locked && cargo test --workspace` |

### Phase 4 Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SURFACE-01 | Hook output for a channel with mixed states | unit (pure formatter) | `pnpm test test/crosslink/session-start-hook-content.test.ts` | ❌ — to be added |
| SURFACE-02 | Codex hook config written + feature flag set | unit (install path) | `pnpm test test/cli/install-session-start.test.ts` | ❌ — to be added |
| SURFACE-03 | TUI renders state column | manual smoke + rust unit on derive_state | `cargo test -p harness-data derive_state` | ❌ — to be added |
| SURFACE-04 | GUI renders state badge | manual smoke + frontend unit | `cd gui && pnpm test` | partial |
| SURFACE-05 | `rly status` channel block | unit (pure formatter) | `pnpm test test/cli/print-status-context.test.ts` | partial — extend existing |
| SURFACE-06 | Four states mutually exclusive | unit (derive_state truth table) | `cargo test -p harness-data derive_state` | ❌ — to be added |
| SURFACE-07 | All surfaces read from disk on each render (no in-process cache) | review-time invariant + unit (no globals) | code review | N/A |
| WORKER-06 | Worker rendering nested under admin (forward-compat) | unit on group_by_admin grouping shape | `cargo test -p harness-data group_by_admin` | ❌ — to be added |

### Wave 0 Gaps
- [ ] `test/crosslink/session-start-hook-content.test.ts` — covers SURFACE-01 (output formatter); pure functions, scripted mode.
- [ ] `test/cli/install-session-start.test.ts` — covers SURFACE-02 (Claude + Codex install writes; idempotency on re-run; drift detection).
- [ ] `test/cli/print-status-context.test.ts` — extend with `formatChannelStatesBlock` cases.
- [ ] Rust tests in `crates/harness-data/src/lib.rs` for `derive_state`, `group_by_admin`, `RepoAdminState` serde round-trip.
- [ ] Manual smoke (live `rly claude` + live `codex` invocation in a Relay channel) — recommend a 04-SUMMARY checkpoint per Phase 3 precedent.

## Security Domain

> `security_enforcement` is not explicitly set in `.planning/config.json` — treating as enabled per default. Phase 4 has limited security surface (no secrets, no network, local-only).

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | n/a (no auth surface) |
| V3 Session Management | no | n/a |
| V4 Access Control | partial | Hook reads `~/.relay/` — same file-system trust boundary as the rest of Relay. No new privilege escalation. |
| V5 Input Validation | yes | Hook reads JSON on stdin (from Claude/Codex) — must parse defensively. Existing `try/catch` pattern in hook script is sufficient. |
| V6 Cryptography | no | n/a (no crypto in Phase 4) |

### Known Threat Patterns for Phase 4 stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Hook output interpreted as system instructions by the agent (prompt injection) | Tampering | Use factual phrasing per Claude Code docs guidance; never use imperative "you MUST" language. `[CITED: code.claude.com/docs/en/hooks]` |
| Malicious `channel.json` triggers parse error in hook, crashes user's Claude session | Denial of Service | Existing pattern: `try/catch` per file; skip malformed; exit 0 always. Matches `src/crosslink/hook.ts:93-95`. |
| Hook script path injection (user-supplied path in settings.json) | Tampering | `rly install` writes the canonical path; `--check` detects drift. User can manually edit but that's their own machine. |
| Watermark write race (two hook invocations advance the same `lastSeenFeedIdx`) | Tampering | Atomic write via tmp+rename (existing pattern in `CrosslinkStore.updateHeartbeat`). Last-writer-wins is acceptable for a best-effort counter. |

## Sources

### Primary (HIGH confidence)
- **Codex SessionStart hook docs** — `https://developers.openai.com/codex/hooks` — verified event list (`SessionStart`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `UserPromptSubmit`, `Stop`), I/O schema, plain-stdout-as-context, feature flag.
- **Codex changelog / config reference** — `https://developers.openai.com/codex/changelog`, `https://developers.openai.com/codex/config-reference` — feature flag deprecation (`codex_hooks` → `hooks` at v0.129).
- **Claude Code hooks docs** — `https://code.claude.com/docs/en/hooks` — verified SessionStart input/output, `additionalContext` 10K limit, 600s default timeout, four `source` values (`startup`, `resume`, `clear`, `compact`), silent injection since 2.1.0.
- **Phase 3 SUMMARY** — `.planning/phases/03-repo-admin-readiness-handshake/03-SUMMARY.md` — confirmed disk shape, Rust read path, channel-feed event shape that Phase 4 consumes.
- **Phase 3 PLAN** — `.planning/phases/03-repo-admin-readiness-handshake/03-PLAN.md` — explicit `<phase_handoff_contract>` declaring stability of `readyAt`, `load_crosslink_sessions()`, the `agent_ready` feed entry.
- **Phase 1 design doc** — `docs/design/context-threshold-events.md` — schemaVersion conventions, torn-line tolerance pattern, Rust mirror pattern.
- **Codebase** — `src/crosslink/hook.ts`, `src/cli/install.ts`, `src/domain/channel.ts`, `src/channels/channel-store.ts`, `src/lifecycle/session-lifecycle.ts`, `src/crosslink/store.ts`, `src/cli/print-status-context.ts`, `src/install/manifest.ts`, `crates/harness-data/src/lib.rs`, `.planning/codebase/ARCHITECTURE.md`, `.planning/codebase/STRUCTURE.md`, `.planning/codebase/INTEGRATIONS.md`, `AGENTS.md`.

### Secondary (MEDIUM confidence)
- **Agentic Control Plane "Codex CLI hook governance"** — `https://agenticcontrolplane.com/blog/codex-cli-hooks-reference` — corroborates feature-flag deprecation and stable-as-of-v0.130 timing.

### Tertiary (LOW confidence)
- None — primary sources covered all critical claims.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — Phase 4 stack is the existing repo + two hook config files (official-docs-verified).
- Architecture: HIGH — pattern mirrors Phases 1 + 3; single Rust source of truth + thin TS mirror is the established convention.
- Pitfalls: HIGH — pitfalls #1-#3 verified directly in code; pitfalls #4-#7 verified via existing patterns or official docs.
- Codex hook parity: HIGH — verified in two official docs and one third-party reference.
- `lastSeenFeedIdx` shape: MEDIUM — recommendation is reasonable but droppable per D-04; planner can revisit.
- TUI / GUI navigation depth: LOW — left to planner per D-01 and Claude's Discretion #5. Research scoped this as out-of-scope to research deeply; the rendering work is mechanical given `derive_state()`.

**Research date:** 2026-05-11
**Valid until:** 2026-06-10 (30 days — Phase 4 is stable composition of shipped primitives; only risk is Codex CLI hook surface changes, which has been stable since v0.130 May 8, 2026).

---

## RESEARCH COMPLETE

**Phase:** 4 - Project readiness surface
**Confidence:** HIGH overall (one MEDIUM area: Codex < v0.130 behavior — recommend version probe in install step)

### Key Findings (one-screen summary for planner)

1. **Codex hook parity IS achievable today.** Codex CLI v0.130+ supports `SessionStart` with byte-compatible I/O to Claude Code: JSON stdin includes `session_id`, `cwd`, `source`; stdout (plain or JSON-wrapped) becomes additional context. Feature flag: `[features].hooks = true` (legacy `codex_hooks` deprecated v0.129). Config at `~/.codex/hooks.json` or `[hooks]` in `~/.codex/config.toml`. **No four-surface gap.** `rly install` writes both hook configs idempotently.

2. **`derive_state(session, now) -> RepoAdminState` belongs in `crates/harness-data`.** Single source of truth for the four-state mapping; thin TS mirror in `src/domain/repo-admin-state.ts`. All four surfaces (hook, TUI, GUI, CLI) consume the same function. Constant `STALE_HEARTBEAT_MS = 120_000` already exists in `src/crosslink/store.ts:19` — Phase 4 mirrors it into Rust and removes the duplication.

3. **CRITICAL pitfall #3: `CrosslinkStore.discoverSessions()` auto-deregisters stale sessions** (verified `src/crosslink/store.ts:265-268`). Phase 4 surfaces MUST read raw via `load_crosslink_sessions()` (Rust, no cleanup) or direct fs in the hook (TS) — otherwise the `stale` state is unobservable.

4. **State enum naming has no lexical collisions.** `disconnected | booting | ready | stale` does NOT clash with `LifecycleState` enum (`planning | dispatching | winding_down | audit | done | killed` in `src/lifecycle/types.ts`). The minor `RepoAdminSession._state="ready"` proximity is a Phase 3 deferred follow-up — recommend bundling the rename `_state → _processState` into Phase 4 Wave 1 (~50 LOC, mechanical).

5. **`lastSeenFeedIdx` (D-04 watermark): recommend field-on-`CrosslinkSession` with `#[serde(default)]` + `.optional()`.** Lowest I/O cost, back-compat automatic, droppable without schema churn. Phase 4 still ships honest state if the watermark is cut for scope.

6. **Hook installation extends existing `rly install` manifest.** `src/install/manifest.ts` already handles drift for `cli`/`tui`/`gui` surfaces. Phase 4 adds a `hooks` block (additive — no schemaVersion bump needed). `rly install --check` reports drift when the user manually edits the hook entries.

7. **Wave shape suggestion** (planner's call, four 4-PR phases per Phase 1-3 precedent):
   - **PR-1 (scaffolds + tests RED, ≤150 LOC):** `RepoAdminState` enum in TS + Rust mirror + `derive_state` stub + test scaffolds. Optionally bundle the `_state → _processState` rename here.
   - **PR-2 (state derivation GREEN, ≤200 LOC):** `derive_state` body + `group_by_admin` + tests GREEN in both TS and Rust.
   - **PR-3 (hook generator + install wiring, ≤350 LOC):** new SessionStart hook generator following `src/crosslink/hook.ts` pattern; install writes Claude + Codex configs; drift detection in manifest.
   - **PR-4 (TUI + GUI + CLI rendering, ≤400 LOC):** TUI state column; GUI state badge; `rly status` channel block; optional `rly channel show <id>` command.
   - **PR-5 (manual smoke + 04-SUMMARY):** end-to-end live test with Claude AND Codex; document parity. Defer cmux integration explicitly.

### File Created
`/Users/jonathanlancaster/projects/agent-harness/.planning/phases/04-project-readiness-surface/04-RESEARCH.md`

### Confidence Assessment
| Area | Level | Reason |
|------|-------|--------|
| Standard Stack | HIGH | Composition of shipped primitives; hook surfaces verified in official docs |
| Architecture | HIGH | Mirrors Phase 1 + Phase 3 patterns (Rust source of truth + TS mirror, same-PR cross-dashboard rule) |
| Pitfalls | HIGH | All verified in code or official docs |
| Codex hook parity (claude discretion #1) | HIGH | Two official sources + one third-party corroboration |
| `rly project show` shape (claude discretion #2) | MEDIUM | Recommended `rly channel show` + alias, but planner picks |
| Watermark shape (claude discretion #3) | MEDIUM | Recommended field-on-record, but droppable per D-04 |
| State enum naming (claude discretion #4) | HIGH | Verified no `session-lifecycle.ts` collision |
| State-derivation placement (claude discretion #5) | HIGH | Standard pattern in this codebase |
| cmux integration (claude discretion #6) | MEDIUM | Recommend defer to follow-up — scope-control |

### Open Questions (planner-facing)
*(All five resolved; see `## Open Questions (RESOLVED)` above for the full decisions. Summary:)*
1. Codex install version probe — RESOLVED: probe + write anyway (Plan 03).
2. `rly channel show` vs `rly project show` — RESOLVED: both, alias to same handler (Plan 05).
3. `_state → _processState` rename — RESOLVED: bundled into Wave 1 / Plan 01 Task 3.
4. Watermark in or out — RESOLVED: IN, optional field on CrosslinkSession (Plan 02).
5. cmux pane refs — RESOLVED: deferred to follow-up (Plan 05 SUMMARY).

### Ready for Planning
Research complete. Planner can now create PLAN.md. The four-surface contract is achievable with current primitives; no architectural shifts required. Recommended sequencing biases toward landing the shared `derive_state()` first so all four surfaces consume one canonical state-mapping function.

Sources:
- [Claude Code Hooks Reference](https://code.claude.com/docs/en/hooks)
- [Codex Hooks Documentation](https://developers.openai.com/codex/hooks)
- [Codex Config Reference](https://developers.openai.com/codex/config-reference)
- [Codex CLI Changelog](https://developers.openai.com/codex/changelog)
- [Codex CLI hook governance — Agentic Control Plane](https://agenticcontrolplane.com/blog/codex-cli-hooks-reference)
