---
phase: 03-repo-admin-readiness-handshake
status: implemented
written: 2026-05-09
manual_smoke: deferred
---

# Phase 3 Summary — Repo-admin readiness handshake

## Goal achieved

A repo-admin's `CrosslinkSession` record now carries an explicit `readyAt` flag — populated exactly once per session by an agent-asserted call to a new `agent_ready` MCP tool. Heartbeat continues to indicate liveness; readiness now indicates "agent has finished onboarding and can be addressed." Phase 4 (the project readiness surface) has a stable, honest signal to render against, instead of conflating "process alive" with "agent ready."

## What landed

### Schema additions

- **`src/crosslink/types.ts`**: `CrosslinkSessionSchema` extended with `readyAt: z.string().optional()` and `readyKind: z.enum(["admin", "worker"]).optional()`. Both fields back-compat default to `undefined`; pre-Phase-3 session.json files deserialize cleanly.
- **`crates/harness-data/src/lib.rs`**: First crosslink type ever to land in this crate. `pub struct CrosslinkSession` mirrors the TS shape (camelCase via `serde(rename_all)`); `ready_at` and `ready_kind` are `Option<String>` with `#[serde(default)]`.

### Behaviour

- **`CrosslinkStore.updateReadiness(sessionId, kind)`** (sibling to `updateHeartbeat`): monotonic-once-set; idempotent on re-call (returns existing `readyAt` with `alreadyReady: true`); returns `null` for unknown sessionIds; never modifies `readyAt` from any other code path.
- **`agent_ready` MCP tool** (`src/mcp/readiness-tools.ts`): wired into `tools/list` and `tools/call` dispatch via the same `is*Tool` chain as channel/crosslink/coordination. First-time call writes both the disk flag AND a single `status_update` channel-feed entry with `metadata.kind: "agent_ready"`. Subsequent calls are no-ops (idempotent on both rails). Degrades gracefully when no `RELAY_CHANNEL_ID` is in env: disk flag still flips, no feed entry.
- **System prompt** (`src/agents/repo-admin.ts`): new "Boot-readiness assertion" section between Memory Policy and Cross-repo Coordination. Pinned by `REPO_ADMIN_READINESS_MARKER` constant. Test asserts the marker substring + supporting copy.
- **Spawner env threading** (`src/orchestrator/repo-admin-session.ts`): `RepoAdminSpawnArgs` carries an optional `channelId`; the autonomous-loop spawner reads it from `cycleConfig.channelId` and threads it to the child as `RELAY_CHANNEL_ID`. Ad-hoc `rly claude` sessions get null and degrade.

### Read path for Phase 4

- **`crates/harness-data::load_crosslink_sessions()`**: reads every JSON file under `~/.relay/crosslink-session/` (current `STORE_NS.crosslinkSession` namespace, NOT the legacy `~/.relay/crosslink/sessions/` path). Silently skips unreadable / malformed / non-JSON files. Phase 4 dashboards consume this.

## End-to-end flow (verified by test suite)

```
repo-admin agent
  ↓  calls agent_ready MCP tool
src/mcp/server.ts dispatch  →  callReadinessTool
  ↓
CrosslinkStore.updateReadiness  →  ~/.relay/crosslink-session/<sid>.json  (readyAt set, monotonic, atomic)
ChannelStore.postEntry          →  ~/.relay/channels/<cid>/feed.jsonl    (one status_update audit entry)
  ↓
crates/harness-data::load_crosslink_sessions()  →  Phase 4 surfaces (TUI / GUI / SessionStart hook)
```

## Wave-by-wave PR boundaries

The phase shipped in four waves, each ≤ ~365 LOC (well under the 800-LOC ceiling per `AGENTS.md:63-67`). Suggested PR titles:

| Wave              | Commit    | LOC      | Title                                                                              |
| ----------------- | --------- | -------- | ---------------------------------------------------------------------------------- |
| 0 (planning)      | `f4134fb` | n/a      | `docs(planning): Phase 3 RESEARCH + PLAN — repo-admin readiness handshake`         |
| 1 (scaffolds)     | `420b2ca` | +364     | `feat(crosslink): scaffold readiness primitive — schema + Rust mirror + RED tests` |
| 1.5 (formatting)  | `fc0d4f2` | +17/-2   | `chore: prettier formatting fixup for ROADMAP`                                     |
| 2 (functionality) | `e8a157a` | +243/-27 | `feat(crosslink): land readiness handshake — agent_ready MCP tool + spawner env`   |
| 3 (Rust reader)   | `04dcd10` | +122/-4  | `feat(harness-data): real load_crosslink_sessions reader + serde fixtures`         |

## Verification gates

| Gate                                    | Result                                                                  |
| --------------------------------------- | ----------------------------------------------------------------------- |
| `pnpm typecheck`                        | GREEN                                                                   |
| `pnpm test` (full suite, scripted mode) | 989 passed, 0 failed, 24 skipped                                        |
| `pnpm format:check`                     | GREEN                                                                   |
| `pnpm build`                            | GREEN (matches existing CI)                                             |
| `cargo check --workspace --locked`      | GREEN                                                                   |
| `cargo test --workspace`                | GREEN — harness-data: 70 passed (66 baseline + 4 new); zero regressions |

### New tests added by this phase

- **`test/crosslink-store.test.ts`** — 3 tests under `describe("CrosslinkStore.updateReadiness (Phase 3)")`: alive-but-not-ready window (the exact acceptance criterion called out in `ROADMAP.md:83`), exactly-once transition with idempotent re-call, null-id rejection.
- **`test/mcp/readiness-tools.test.ts`** (new file) — 5 tests covering ok-with-readyAt, single status_update post, idempotent re-call (no second feed entry), graceful degradation without channelId, ok:false when sessionId is null.
- **`test/agents/repo-admin.test.ts`** — marker substring + supporting copy assertions; allowlist exactness updated to include `agent_ready`.
- **`test/orchestrator/repo-admin-session.test.ts`** — 2 tests: spawner receives `channelId` when `cycleConfig` is wired; omits it otherwise.
- **`crates/harness-data/src/lib.rs`** — 4 `#[test]` blocks: round-trip with readiness, back-compat without, `load_crosslink_sessions` skips malformed rows, `load_crosslink_sessions` returns empty on missing dir.

## Manual smoke — deferred

The Wave 4 manual smoke checkpoint (live `rly claude` session demonstrating the alive→ready transition on disk + feed) is **deferred to a follow-up turn**. The phase is fully verified by the test suite end-to-end against tmpdir-rooted stores, but a real-binary run with a real agent is the only thing that exercises the system-prompt copy → agent obediently calls `agent_ready` → disk + feed update path under live conditions. Recommended order when picked up:

1. Run `rly claude` in this repo. Confirm a `~/.relay/crosslink-session/<sid>.json` file appears with `readyAt` absent.
2. Wait for the agent's onboarding turn to complete; confirm `readyAt` populates AND a `status_update` entry with `metadata.kind === "agent_ready"` appears on the channel feed.
3. Manually instruct the agent to call `agent_ready` a second time; confirm `idempotent: true` is returned and no second feed entry lands.
4. Update this section to "manual_smoke: verified" with a date.

## Phase handoff contract — confirmed live for Phase 4

Phase 4's `<phase_handoff_contract>` from `03-PLAN.md` is now the live contract:

- **Disk shape stable.** `~/.relay/crosslink-session/<sid>.json` files now carry `readyAt: string | null` and `readyKind: "admin" | "worker" | null`. Older files (pre-Phase-3) deserialize with both fields `null`. Phase 4 must treat absent / null `readyAt` as "alive but not ready."
- **Rust read path stable.** `crates/harness-data::load_crosslink_sessions()` returns every live session record. TUI / GUI / SessionStart hook all consume through this single function — no drift.
- **Channel-feed event stable.** A `type: "status_update"` entry with `metadata.kind === "agent_ready"` fires exactly once per session per readiness assertion (idempotent). Phase 4's SessionStart hook can scan recent feed for these entries to render the readiness transition timeline.
- **No worker readiness yet.** `readyKind: "worker"` is reserved in the enum but no code path emits it (Phase 5 / AL-14 is a stub). Phase 5 will plug workers into the same primitive.
- **`repo-ready` coordination message untouched.** That signal still means "PR merged, your blocker is gone." Phase 4 must not conflate it with `agent_ready`.
- **`RepoAdminSession._state = "ready"` untouched.** That field still means "process is spawned." Renaming it for clarity is out of scope for Phase 3 (see Open Follow-ups).

## Open follow-ups

These were explicitly deferred to keep the phase focused. None block Phase 4.

1. **Rename `RepoAdminSession._state`** (e.g. → `_processState`) to remove the lexical collision with the new agent-asserted readiness signal on `CrosslinkSession.readyAt`. The two concepts use the same English word "ready" today; the inline doc comment added in this phase mitigates but does not remove the trap. Estimated <50 LOC, mostly mechanical.
2. **Legacy GUI reader path fix** (`gui/src-tauri/src/lib.rs:2810-2861`, `:2916-2970`) — the GUI still reads `~/.relay/crosslink/sessions/` (legacy) for SIGTERM matching. Pre-existing bug surfaced during Phase 3 research; out of scope here. Should be a small standalone PR.
3. **Live-mode `RELAY_CHANNEL_ID` smoke test.** This phase verified the env threading via unit test (Wave 2 Task 5) but has not yet observed a real autonomous-loop admin booting under it. Validates A1 from `03-RESEARCH.md`.
4. **Phase 5 / AL-14 (`spawn_worker`) readiness reuse.** When Phase 5 plan-phase happens, confirm that workers reuse this primitive cleanly with `readyKind: "worker"` — the schema enum already accepts it; validate the agent-asserted shape generalizes (research's MEDIUM-confidence area).
5. **`.planning/notes/relay-architecture-status.md`** — update the "What's missing" section to strike "No boot-readiness signal" since it now exists. Trivial doc nit.
6. **Optional second-tier readiness signal.** If real agents skip the `agent_ready` call in practice, add a coordinator-detected fallback (e.g., `readinessCheckedAt` + `inferredFromIdle: true` after N minutes of heartbeats with no assertion). Defer until A5 from `03-RESEARCH.md` has empirical evidence.
