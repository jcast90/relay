---
phase: 03-repo-admin-readiness-handshake
plan: 03
type: execute
wave: 1
depends_on: []
files_modified:
  # Wave 1 — scaffolds + types (compile-ready bundle)
  - src/crosslink/types.ts
  - crates/harness-data/src/lib.rs
  - test/crosslink/store.test.ts
  - test/mcp/readiness-tools.test.ts
  - test/agents/repo-admin.test.ts
  # Wave 2 — store + MCP tool + prompt + spawner
  - src/crosslink/store.ts
  - src/mcp/readiness-tools.ts
  - src/mcp/server.ts
  - src/mcp/role-allowlist.ts
  - src/agents/repo-admin.ts
  - src/orchestrator/repo-admin-session.ts
  # Wave 3 — Rust reader
  # (already listed above; serde tests added in same crate)
  # Wave 4 — summary
  - .planning/phases/03-repo-admin-readiness-handshake/03-SUMMARY.md
autonomous: true
requirements:
  - REQ-3.1
  - REQ-3.2
  - REQ-3.3
  - REQ-3.4
  - REQ-3.5
  - REQ-3.6
  - REQ-3.7
  - REQ-3.8
must_haves:
  truths:
    - "A repo-admin agent's `CrosslinkSession` carries a `readyAt` (ISO-8601, nullable) and `readyKind` (`'admin'|'worker'|null`) — populated only by an explicit `agent_ready` MCP call, never as a side-effect of heartbeating."
    - "Heartbeat semantics are unchanged: `updateHeartbeat` does not touch `readyAt`; sessions can heartbeat indefinitely with `readyAt: null`."
    - "Calling `agent_ready` more than once is a no-op — the first call sets the timestamp; subsequent calls return the same `readyAt` with `idempotent: true` and post no second feed entry."
    - "When a `RELAY_CHANNEL_ID` is in the MCP server's env, an `agent_ready` call posts a single `status_update` channel-feed entry with `metadata.kind = 'agent_ready'`. Without the env var, the disk flag is still flipped (degraded mode)."
    - "`crates/harness-data` exposes `load_crosslink_sessions()` returning `Vec<CrosslinkSession>` with the new fields; older session.json files (no readiness fields) deserialize cleanly as `ready_at: None`."
    - "Repo-admin system prompt contains `REPO_ADMIN_READINESS_MARKER` substring; test `test/agents/repo-admin.test.ts` pins it the same way the existing `MEMORY_POLICY` and `COORDINATION_POLICY` markers are pinned."
    - "The existing `repo-ready` typed coordination message (`src/crosslink/messages.ts:74-90`) is unchanged. The existing `RepoAdminSession._state = 'ready'` field (`src/orchestrator/repo-admin-session.ts:90`) is unchanged."
  artifacts:
    - path: "src/crosslink/types.ts"
      provides: "`CrosslinkSessionSchema` extended with `readyAt: z.string().optional()` and `readyKind: z.enum(['admin','worker']).optional()`."
      contains: "readyAt: z.string().optional()"
    - path: "src/crosslink/store.ts"
      provides: "`CrosslinkStore.updateReadiness(sessionId, kind)` — sibling to `updateHeartbeat`. Monotonic-once-set; returns `{readyAt, alreadyReady}` or `null` for unknown sessions."
      contains: "async updateReadiness"
    - path: "src/mcp/readiness-tools.ts"
      provides: "`getReadinessToolDefinitions()` and `callReadinessTool(args, state)` — the new `agent_ready` MCP tool surface."
      contains: "export async function callReadinessTool"
    - path: "src/agents/repo-admin.ts"
      provides: "`REPO_ADMIN_READINESS_MARKER` constant + new 'Boot-readiness assertion' section in the system prompt."
      contains: "export const REPO_ADMIN_READINESS_MARKER"
    - path: "crates/harness-data/src/lib.rs"
      provides: "`pub struct CrosslinkSession` (first crosslink type in the crate) + `pub fn load_crosslink_sessions() -> Vec<CrosslinkSession>` reader pointed at `~/.relay/crosslink-session/`."
      contains: "pub struct CrosslinkSession"
  key_links:
    - from: "repo-admin agent (Claude/Codex CLI subprocess)"
      to: "src/mcp/readiness-tools.ts callReadinessTool"
      via: "JSON-RPC tool call: `agent_ready` with optional `summary`"
      pattern: "agent_ready"
    - from: "src/mcp/readiness-tools.ts"
      to: "CrosslinkStore.updateReadiness"
      via: "monotonic-once-set disk flip via FileHarnessStore.putDoc"
      pattern: "updateReadiness"
    - from: "src/mcp/readiness-tools.ts"
      to: "ChannelStore.postEntry"
      via: "single `status_update` entry with `metadata.kind: 'agent_ready'`, gated on `RELAY_CHANNEL_ID` presence"
      pattern: "metadata: { kind: \"agent_ready\""
    - from: "src/orchestrator/repo-admin-session.ts spawner"
      to: "child env"
      via: "`RELAY_CHANNEL_ID` set alongside existing `RELAY_AGENT_ALIAS` / `RELAY_SESSION_ID`"
      pattern: "RELAY_CHANNEL_ID"
    - from: "crates/harness-data::load_crosslink_sessions"
      to: "Phase 4 dashboards (TUI, GUI, SessionStart hook)"
      via: "shared crate read of `~/.relay/crosslink-session/*.json`"
      pattern: "load_crosslink_sessions"
---

<phase_goal>
A repo-admin's `CrosslinkSession` record gains an explicit `readyAt` flag — populated exactly once per session via a new `agent_ready` MCP tool that the repo-admin calls at the end of its onboarding turn. Heartbeat continues to indicate liveness; readiness indicates the agent has finished orienting itself and can be addressed. The same readiness state is mirrored into `crates/harness-data` (Phase 4's read path) and announced once on the channel feed (Phase 4's hook injection point + audit trail).
</phase_goal>

<objective>
Add a single, agent-asserted boot-readiness primitive that disambiguates "process is alive" (heartbeat, already exists) from "agent is ready to receive tasks" (new). Ships as: two optional fields on `CrosslinkSessionSchema` (`readyAt`, `readyKind`); a sibling `updateReadiness` method on `CrosslinkStore`; a new MCP tool `agent_ready` (≈25 LOC) added to the repo-admin allowlist; a system-prompt section + test-pinned marker that instructs the agent to call it; a spawner env var (`RELAY_CHANNEL_ID`) so the tool can post the audit entry to the right channel; a Rust mirror in `crates/harness-data` (the first crosslink type to land there).

**Purpose.** Today `CrosslinkSession.lastHeartbeat` is the only signal observers have. It conflates "process is alive" with "agent is ready to be addressed." Any UI that lights a session green based on heartbeat alone (Phase 4's planned project surface) lies during the onboarding window. This phase introduces an honest signal so Phase 4 can render trustworthy state.

**Output.** A repo-admin session that registers in an *alive but not ready* state, heartbeats while it onboards, and only flips to `readyAt: <ISO>` when the agent asserts via `agent_ready`. The same shape generalizes to per-task workers in Phase 5 (AL-14) via the `readyKind` discriminator without a breaking change.

**User story.** *As a Relay user about to dispatch work to a repo-admin, I need to know that the admin has finished onboarding and is genuinely ready to receive tasks — not just that its process is alive — so that I trust dispatched work is actually being picked up.*
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
</execution_context>

<context>
@ROADMAP.md
@.planning/phases/03-repo-admin-readiness-handshake/03-RESEARCH.md
@.planning/notes/cli-ux-trust-vs-invocation.md
@.planning/notes/relay-architecture-status.md
@AGENTS.md
@.planning/codebase/ARCHITECTURE.md
</context>

<phase_handoff_contract>
Phase 4 (Project readiness surface) consumes this phase's primitive:

- **Disk shape stable.** `~/.relay/crosslink-session/<sid>.json` files have `readyAt: string | null` and `readyKind: "admin" | "worker" | null`. Older files (pre-Phase-3) deserialize with both fields `null`. Phase 4 must treat absent / null `readyAt` as "alive but not ready."
- **Rust read path stable.** `crates/harness-data::load_crosslink_sessions() -> Vec<CrosslinkSession>` returns every live session record. Phase 4 reads this; the TUI / GUI / SessionStart hook all funnel through it.
- **Channel-feed event stable.** A `type: "status_update"` entry with `metadata.kind === "agent_ready"` fires exactly once per session per `agent_ready` invocation (idempotent). Phase 4's SessionStart hook is allowed to scan the recent feed for these to display the readiness transition timeline.
- **No worker readiness yet.** `readyKind: "worker"` is reserved in the enum but no code path emits it (AL-14 is a stub). Phase 5 will plug workers into the same primitive.
- **`repo-ready` coordination message untouched.** That signal still means "PR merged, your blocker is gone." Phase 4 must not conflate it with `agent_ready`.
- **`RepoAdminSession._state = "ready"` untouched.** That field still means "process is spawned." Renaming it for clarity is out of scope for Phase 3 (flagged as an Open Question for follow-up).
</phase_handoff_contract>

<wave_structure>
Four waves. Each wave is one logical PR boundary. PRs are sub-800 LOC per `AGENTS.md:63-67`.

- **Wave 1 (PR-1):** Schema + scaffolds — types in TS and Rust land together so every test in this PR compiles. Tests start RED (failing as intended). Estimated ~120 LOC.
- **Wave 2 (PR-2):** Store + MCP tool + prompt + spawner env — drives Wave 1's RED tests to GREEN. Estimated ~180 LOC.
- **Wave 3 (PR-3):** Rust reader (`load_crosslink_sessions`) + serde fixtures. Estimated ~80 LOC.
- **Wave 4 (PR-4):** Manual smoke + 03-SUMMARY.md. Documentation + Phase 4 handoff confirmation. Estimated ~50 LOC.
</wave_structure>

<tasks>

<task type="auto" wave="1">
## Task 1 — Schema extension + Rust mirror + test scaffolds

  <files>
src/crosslink/types.ts
crates/harness-data/src/lib.rs
test/crosslink/store.test.ts
test/mcp/readiness-tools.test.ts
test/agents/repo-admin.test.ts
  </files>

  <steps>
1. **Extend `CrosslinkSessionSchema`** (`src/crosslink/types.ts:26-38`):
   - Append `readyAt: z.string().optional()`.
   - Append `readyKind: z.enum(["admin", "worker"]).optional()`.
   - Both fields back-compat default to `undefined` (zod handles via `.optional()`).
   - No other fields touched.

2. **Add the Rust mirror** in `crates/harness-data/src/lib.rs` (this is the FIRST crosslink type in the crate — verified by grep):
   - `pub struct CrosslinkSession` with all existing TS fields (snake_case via `#[serde(rename_all = "camelCase")]`) PLUS `pub ready_at: Option<String>` and `pub ready_kind: Option<String>`.
   - Both new fields use `#[serde(default)]` so older session files deserialize cleanly as `None`.
   - Stub `pub fn load_crosslink_sessions() -> Vec<CrosslinkSession> { Vec::new() }` (real body lands in Wave 3 — keeps the `cargo check` green for Wave 1).
   - DO NOT add Rust tests in this wave; they land in Wave 3 with the real reader.

3. **Scaffold three test files** with at least one RED test each (intentionally failing — test bodies reference functions that don't yet exist):

   - `test/crosslink/store.test.ts` (extend existing) — add a `describe("CrosslinkStore.updateReadiness", …)` block with:
     - `it("starts sessions in alive-but-not-ready state")` — register a session, assert `readyAt` is undefined after register and after one `updateHeartbeat` call.
     - `it("transitions to ready exactly once via updateReadiness")` — call `updateReadiness(id, "admin")`, assert `readyAt` is set; second call returns same `readyAt` with `alreadyReady: true`.
     - `it("rejects unknown sessionIds with null return")`.

   - `test/mcp/readiness-tools.test.ts` (NEW) — `describe("agent_ready MCP tool", …)`:
     - `it("returns ok with readyAt when called with valid state")`.
     - `it("posts a single status_update entry with metadata.kind agent_ready")`.
     - `it("is idempotent — second call posts no second feed entry")`.
     - `it("degrades gracefully without RELAY_CHANNEL_ID — flips disk flag, no feed entry")`.
     - `it("returns ok:false when crosslinkSessionId is null")`.

   - `test/agents/repo-admin.test.ts` (extend existing) — in the `describe("repo-admin role — system prompt", …)` block:
     - `it("encodes the boot-readiness policy by substring match")` — asserts `prompt` contains `REPO_ADMIN_READINESS_MARKER` AND the strings "alive but not ready" AND `/onboarding turn is complete/i`.

4. **Verify Wave 1 boundary**: every test scaffold compiles against the imports it references. Functions/constants land in Wave 2; tests reference them via `import` so TypeScript does not compile until those exports exist. To preserve the "every PR independently passes typecheck" rule (per `AGENTS.md` PR hygiene + Phase 1's H2 lesson), include skeleton exports in Wave 1:
   - In `src/crosslink/store.ts`, add a stub `async updateReadiness(): Promise<never> { throw new Error("Wave 2 lands the body"); }`.
   - In `src/mcp/readiness-tools.ts` (NEW file), add stub exports for `getReadinessToolDefinitions` and `callReadinessTool` that throw.
   - In `src/agents/repo-admin.ts`, add `export const REPO_ADMIN_READINESS_MARKER = "call \`agent_ready\` exactly once when your onboarding turn is complete"` (the constant lands now; the system-prompt copy that contains it lands in Wave 2).
   - This mirrors Phase 1's H2 fix exactly: every PR passes `pnpm typecheck && cargo check --workspace --locked`.
  </steps>

  <verify>
- `pnpm typecheck` GREEN.
- `cargo check --workspace --locked` GREEN.
- `pnpm test test/crosslink/store.test.ts test/mcp/readiness-tools.test.ts test/agents/repo-admin.test.ts` — all five RED tests fail with `throw "Wave 2 lands the body"` or assertion-mismatch (NOT compile errors). Test count: at minimum 8 new failing assertions across the three files.
  </verify>

  <done>
Schema extended in TS + Rust; both compile. Skeleton exports in store, readiness-tools, repo-admin land. Test scaffolds RED with intentional failures (not compile errors). No existing test regressions: `pnpm test` passes for everything *outside* the three new test areas; the three new test files fail loudly.
  </done>
</task>

<task type="auto" wave="2">
## Task 2 — `CrosslinkStore.updateReadiness` (drive store tests GREEN)

  <files>
src/crosslink/store.ts
  </files>

  <steps>
1. Replace the Wave 1 stub with the real `updateReadiness` body, sibling to `updateHeartbeat` (`src/crosslink/store.ts:178-188`):
   ```typescript
   async updateReadiness(
     sessionId: string,
     kind: "admin" | "worker" = "admin"
   ): Promise<{ readyAt: string; alreadyReady: boolean } | null> {
     const session = await this.readSession(sessionId);
     if (!session) return null;
     if (session.readyAt) {
       return { readyAt: session.readyAt, alreadyReady: true };
     }
     const readyAt = new Date().toISOString();
     const updated: CrosslinkSession = {
       ...session,
       readyAt,
       readyKind: kind,
       lastHeartbeat: readyAt,
     };
     await this.store.putDoc(STORE_NS.crosslinkSession, sessionId, updated);
     return { readyAt, alreadyReady: false };
   }
   ```

2. **Do not** modify `updateHeartbeat`. The heartbeat path stays untouched per the locked constraint.

3. Run `test/crosslink/store.test.ts` until all three new tests in the `updateReadiness` block pass GREEN. Existing crosslink-store tests must continue to pass unchanged.
  </steps>

  <verify>
- `pnpm test test/crosslink/store.test.ts` — full file GREEN, including the three new `updateReadiness` tests AND every pre-existing test in the file (no regressions in `discoverSessions`, `updateHeartbeat`, `register/deregister`).
- `pnpm typecheck` clean.
  </verify>

  <done>
`updateReadiness` is monotonic-once-set, atomic via `putDoc`, idempotent on re-call, and treats unknown ids as `null`. The "alive-but-not-ready" window is observable: a session can heartbeat repeatedly with `readyAt: undefined` until `updateReadiness` is called once.
  </done>
</task>

<task type="auto" wave="2">
## Task 3 — `agent_ready` MCP tool + dispatch + allowlist

  <files>
src/mcp/readiness-tools.ts
src/mcp/server.ts
src/mcp/role-allowlist.ts
  </files>

  <steps>
1. Replace the Wave 1 stub at `src/mcp/readiness-tools.ts` with the real implementation. Mirror the shape of `src/mcp/channel-tools.ts` (template). The tool definition:
   ```typescript
   export function getReadinessToolDefinitions() {
     return [{
       name: "agent_ready",
       description:
         "Assert that this agent has finished onboarding and is ready to receive tasks. " +
         "Call exactly once at the end of your onboarding turn (after you have read the " +
         "channel board and oriented yourself). Subsequent calls are no-ops.",
       inputSchema: {
         type: "object",
         additionalProperties: false,
         properties: {
           kind: { type: "string", enum: ["admin"] }, // workers added in Phase 5
           summary: { type: "string", maxLength: 280 },
         },
       },
     }];
   }
   ```

2. The handler (`callReadinessTool`):
   - Reads `state.crosslinkSessionId`, `state.channelId`, `state.alias` from the MCP server's existing state plumbing (see `src/mcp/server.ts:130-218` for the auto-register patterns the state already exposes).
   - Calls `state.crosslinkStore.updateReadiness(sessionId, kind ?? "admin")`.
   - If `alreadyReady`: returns `{ ok: true, readyAt, idempotent: true }` and **does not post a second feed entry**.
   - If first-time AND `state.channelId != null`: posts ONE `status_update` entry with `metadata: { kind: "agent_ready", readyKind, sessionId, alias, readyAt }`.
   - If first-time AND `state.channelId == null`: returns `{ ok: true, readyAt, idempotent: false }` with no feed entry (degraded mode — the disk flag is still authoritative).
   - If `state.crosslinkSessionId == null`: returns `{ ok: false, reason: "session-not-registered" }`.

3. Wire dispatch in `src/mcp/server.ts`:
   - Import `getReadinessToolDefinitions`, `callReadinessTool`.
   - Add the tool definition to the `tools/list` response (mirror the existing channel-tools merge at `src/mcp/server.ts` near the channel-tool registration site).
   - In the `tools/call` dispatch switch, add `case "agent_ready": return callReadinessTool(args, state);`.
   - The `state` object passed to the handler must already contain `crosslinkStore`, `channelStore`, `crosslinkSessionId`, `channelId`, `alias` — verify by reading the existing handler shapes and reusing the same state reference. If `channelId` isn't currently surfaced, add it (read from `process.env.RELAY_CHANNEL_ID` at server boot — Task 5 ensures this env var is populated).

4. Add `"agent_ready"` to `REPO_ADMIN_ALLOWED_TOOLS` in `src/mcp/role-allowlist.ts` (matches the pattern at `:120` for `spawn_worker`). Do NOT add to other role allowlists — only repo-admin asserts readiness in Phase 3.

5. Drive `test/mcp/readiness-tools.test.ts` to GREEN. All five tests must pass.
  </steps>

  <verify>
- `pnpm test test/mcp/readiness-tools.test.ts` — all five tests GREEN.
- `pnpm test test/mcp/role-allowlist.test.ts` (existing) — still passes; the new tool name is allowlisted.
- `pnpm typecheck` clean.
  </verify>

  <done>
The `agent_ready` MCP tool is callable from the repo-admin role, refused from non-allowlisted roles, monotonic via `updateReadiness`, idempotent on re-call, and degrades gracefully without `RELAY_CHANNEL_ID`. Channel feed receives at most one `status_update` entry per session per readiness assertion.
  </done>
</task>

<task type="auto" wave="2">
## Task 4 — System prompt + marker test

  <files>
src/agents/repo-admin.ts
test/agents/repo-admin.test.ts
  </files>

  <steps>
1. In `src/agents/repo-admin.ts`, the constant `REPO_ADMIN_READINESS_MARKER` was added in Wave 1. Now insert a new section in `buildRepoAdminSystemPrompt` between the Memory Policy section and the Cross-repo Coordination section (so the order goes: Role → Memory → Tool policy → **Boot-readiness** → Cross-repo coordination). Use the copy from `03-RESEARCH.md` Pattern 4:

   ```typescript
   "## Boot-readiness assertion",
   "You start in an 'alive but not ready' state — observers can see your",
   "process is alive (heartbeat) but cannot tell whether you have finished",
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

2. Drive the test in `test/agents/repo-admin.test.ts` GREEN. The marker assertion + the two supporting substring assertions all pass.

3. Document the `RepoAdminSession._state = "ready"` distinction inline (single comment line at `src/orchestrator/repo-admin-session.ts:90` referencing `CrosslinkSession.readyAt` as the agent-asserted signal; per Pitfall 1 in research). One-line comment, no behavioral change.
  </steps>

  <verify>
- `pnpm test test/agents/repo-admin.test.ts` — GREEN, including the new readiness assertion AND every pre-existing marker test (memory + coordination).
- The new section appears between Memory Policy and Cross-repo Coordination in the rendered system prompt — verify by reading the test snapshot or printing the prompt manually.
  </verify>

  <done>
The repo-admin system prompt explicitly instructs the agent to call `agent_ready` once at end-of-onboarding. The instruction is test-pinned via `REPO_ADMIN_READINESS_MARKER` matching the existing marker pattern. The `RepoAdminSession._state` confusion is mitigated with one inline comment.
  </done>
</task>

<task type="auto" wave="2">
## Task 5 — Spawner env: `RELAY_CHANNEL_ID` threading

  <files>
src/orchestrator/repo-admin-session.ts
test/mcp/readiness-tools.test.ts
  </files>

  <steps>
1. In `src/orchestrator/repo-admin-session.ts:288-342` (the `ClaudeRepoAdminSpawner.spawn` method that already sets `RELAY_AGENT_ALIAS`, `RELAY_AGENT_ROLE`, `RELAY_SESSION_ID`, `RELAY_PROVIDER`), add `RELAY_CHANNEL_ID` to the env block when `this.channelId` is non-null. The pool already knows the channel id — verify by reading the surrounding `RepoAdminPool` plumbing.

2. The MCP server already reads `RELAY_*` env vars (verify via `src/mcp/server.ts:130-159`). If `RELAY_CHANNEL_ID` is not currently read into `state.channelId`, add it: `channelId: process.env.RELAY_CHANNEL_ID ?? null` at the same place `crosslinkSessionId` and `alias` are resolved.

3. Update `test/mcp/readiness-tools.test.ts` test `"degrades gracefully without RELAY_CHANNEL_ID"` to also verify the *positive* path: when env is set, the channel-feed entry is posted exactly once.

4. Add a single test in `test/orchestrator/repo-admin-session.test.ts` (existing file) that asserts `RELAY_CHANNEL_ID` is populated in the spawner's env block when the pool has a channel id. Match the pattern of the existing env-overlay test at `test/agents/cli-agents-env-overlay.test.ts`.
  </steps>

  <verify>
- `pnpm test test/orchestrator/repo-admin-session.test.ts test/mcp/readiness-tools.test.ts` — both files GREEN; all readiness-tool tests including degraded + happy paths.
- Existing env-sanitizer tests (`test/agents/cli-agents-env-overlay.test.ts`) unchanged.
- `pnpm typecheck` clean.
  </verify>

  <done>
Repo-admin sessions launched by the autonomous-loop spawner carry `RELAY_CHANNEL_ID` in their MCP server's env. The MCP server resolves `state.channelId` from this env var. `agent_ready` posts the audit entry to the right channel for autonomous-loop sessions; ad-hoc `rly claude` sessions (no `RELAY_CHANNEL_ID`) degrade to disk-only readiness flips.
  </done>
</task>

<task type="auto" wave="3">
## Task 6 — Rust reader + serde fixtures (`load_crosslink_sessions`)

  <files>
crates/harness-data/src/lib.rs
  </files>

  <steps>
1. Replace the Wave 1 stub `pub fn load_crosslink_sessions() -> Vec<CrosslinkSession> { Vec::new() }` with the real reader:
   ```rust
   pub fn load_crosslink_sessions() -> Vec<CrosslinkSession> {
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
   - **Path discipline:** read from `~/.relay/crosslink-session/` (current `STORE_NS.crosslinkSession`), NOT `~/.relay/crosslink/sessions/` (legacy GUI path). The legacy path is a separate pre-existing GUI bug — out of scope.
   - **Failure tolerance:** silently skip unparseable rows (matches existing `harness-data` patterns) so one malformed file doesn't poison the list.

2. Add two `#[test]` blocks (mirror the patterns at `crates/harness-data/src/lib.rs:2310-2440`):

   ```rust
   #[test]
   fn crosslink_session_round_trip_with_readiness() {
       let json = r#"{"sessionId":"session-test","pid":1234,"repoPath":"/tmp/repo","description":"test","capabilities":["general"],"agentProvider":"claude","registeredAt":"2026-05-09T10:00:00Z","lastHeartbeat":"2026-05-09T10:00:30Z","status":"active","readyAt":"2026-05-09T10:00:15Z","readyKind":"admin"}"#;
       let s: CrosslinkSession = serde_json::from_str(json).unwrap();
       assert_eq!(s.session_id, "session-test");
       assert_eq!(s.ready_at.as_deref(), Some("2026-05-09T10:00:15Z"));
       assert_eq!(s.ready_kind.as_deref(), Some("admin"));
   }

   #[test]
   fn crosslink_session_back_compat_no_readiness_fields() {
       let json = r#"{"sessionId":"session-old","pid":4321,"repoPath":"/tmp/repo","description":"test","capabilities":[],"agentProvider":"claude","registeredAt":"2026-04-01T10:00:00Z","lastHeartbeat":"2026-04-01T10:00:30Z","status":"active"}"#;
       let s: CrosslinkSession = serde_json::from_str(json).unwrap();
       assert_eq!(s.ready_at, None);
       assert_eq!(s.ready_kind, None);
   }
   ```

3. (Optional) Add one `#[test]` for `load_crosslink_sessions` against a temp-dir fixture (write two JSON files; one valid, one malformed; assert returned `Vec` has length 1). Matches existing scoped-tempdir patterns elsewhere in the file.
  </steps>

  <verify>
- `cargo test -p harness-data` — both new fixtures pass; existing harness-data tests unchanged.
- `cargo check --workspace --locked` clean.
- Round-trip fixture asserts both fields landing; back-compat fixture asserts both fields default to `None` for pre-Phase-3 JSON.
  </verify>

  <done>
`crates/harness-data` exposes a working `load_crosslink_sessions()` reader pointed at the current FileHarnessStore namespace path. The new `CrosslinkSession` struct round-trips with and without the readiness fields. Phase 4 has a stable Rust read path.
  </done>
</task>

<task type="checkpoint:human-verify" wave="4" gate="blocking">
## Task 7 — Manual smoke + Phase 4 handoff

  <steps>
1. Run a real `rly claude` session in this repo. Observe:
   - The crosslink-session JSON file at `~/.relay/crosslink-session/<sessionId>.json` initially has `lastHeartbeat` populated and `readyAt` absent / null.
   - After the agent completes its onboarding turn (asks the user a clarifying question or summarizes the workspace), `readyAt` is populated AND a `status_update` entry with `metadata.kind === "agent_ready"` appears on the channel feed at `~/.relay/channels/<channelId>/feed.jsonl`.
   - Calling `agent_ready` again (manually instructing the agent to "call agent_ready") returns `idempotent: true` and does NOT add a second feed entry.

2. Verify with `cargo test -p harness-data`:
   ```bash
   cargo run --example dump_crosslink_sessions  # if such a debug tool exists, otherwise a small inline `cargo test` with `dbg!` is fine
   ```
   Confirm `load_crosslink_sessions()` returns the live session with `ready_at` populated.

3. Write `03-SUMMARY.md` in the phase directory documenting:
   - What landed (5 tasks across 4 waves).
   - Wave-by-wave PR boundaries (suggested PR titles).
   - Open follow-ups: rename `RepoAdminSession._state` → `_processState` (Pitfall 1), legacy GUI reader path fix (Runtime State Inventory), live-mode `RELAY_CHANNEL_ID` threading verification (A1).
   - Phase 4 readiness — the `<phase_handoff_contract>` from this PLAN.md is now the live contract.

4. (Optional but recommended) Add a one-line note to `.planning/notes/relay-architecture-status.md` updating the "What's missing" section: strike "No boot-readiness signal" — it now exists.
  </steps>

  <verify>
- Manual smoke: live `rly claude` session demonstrates the alive→ready transition with one feed entry.
- `pnpm test && pnpm typecheck && pnpm build && cargo check --workspace --locked && cargo test --workspace` — full gate GREEN end-to-end.
- `03-SUMMARY.md` exists and accurately reflects what landed.
  </verify>

  <done>
Live smoke confirms the disk + feed flow end-to-end. `03-SUMMARY.md` written. `relay-architecture-status.md` updated. Phase 4 unblocked: it now has a stable disk shape, Rust reader, and channel-feed event to render against.
  </done>
</task>

</tasks>

<source_audit>
## Multi-source coverage audit

| Source item                                                                  | Type | Plan/Task          | Coverage |
|------------------------------------------------------------------------------|------|--------------------|----------|
| ROADMAP Phase 3 Goal: explicit `agent-ready` state distinct from heartbeat   | GOAL | Tasks 1, 2         | covered  |
| ROADMAP Phase 3 Acceptance: transition fires typed channel event             | GOAL | Task 3             | covered  |
| ROADMAP Phase 3 Acceptance: `harness-data` exposes readiness                 | GOAL | Tasks 1, 6         | covered  |
| ROADMAP Phase 3 Acceptance: heartbeat unchanged                              | GOAL | Tasks 2 (locked)   | covered  |
| ROADMAP Phase 3 Acceptance: alive-but-not-ready window test                  | GOAL | Tasks 1, 2         | covered  |
| ROADMAP Phase 3 Acceptance: prompt language test-pinned                      | GOAL | Tasks 1, 4         | covered  |
| REQ-3.1 (state location: flag on CrosslinkSession)                           | REQ  | Task 1             | covered  |
| REQ-3.2 (channel-feed event with metadata.kind)                              | REQ  | Task 3             | covered  |
| REQ-3.3 (system prompt instructs explicit emit)                              | REQ  | Task 4             | covered  |
| REQ-3.4 (heartbeat unchanged; readiness layered)                             | REQ  | Task 2             | covered  |
| REQ-3.5 (Rust mirror in harness-data)                                        | REQ  | Tasks 1, 6         | covered  |
| REQ-3.6 (test asserts alive-but-not-ready window)                            | REQ  | Tasks 1, 2         | covered  |
| REQ-3.7 (tests pin system-prompt marker)                                     | REQ  | Tasks 1, 4         | covered  |
| REQ-3.8 (cross-dashboard contract honored — same-PR Rust mirror)             | REQ  | Tasks 1, 6         | covered  |
| RESEARCH Q1 (state location)                                                 | RES  | Task 1             | covered  |
| RESEARCH Q2 (agent-asserted, not coordinator-validated)                      | RES  | Tasks 3, 4         | covered  |
| RESEARCH Q3 (new MCP tool, not channel_post extension)                       | RES  | Task 3             | covered  |
| RESEARCH Q4 (parameterize via readyKind)                                     | RES  | Task 1             | covered  |
| RESEARCH Q5 (name: `agent_ready`)                                            | RES  | Tasks 1, 3         | covered  |
| RESEARCH Q6 (dual write — record + feed entry)                               | RES  | Tasks 2, 3         | covered  |
| RESEARCH Q7 (REPO_ADMIN_READINESS_MARKER)                                    | RES  | Tasks 1, 4         | covered  |
| RESEARCH Pitfall 1 (RepoAdminSession._state confusion)                       | RES  | Task 4 (comment)   | mitigated |
| RESEARCH Pitfall 2 (heartbeat regression)                                    | RES  | Tasks 1, 2         | covered  |
| RESEARCH Pitfall 3 (channel-id resolution)                                   | RES  | Task 5             | covered  |
| RESEARCH Pitfall 4 (cross-dashboard drift)                                   | RES  | Tasks 1, 6         | covered  |
| RESEARCH Pitfall 5 (idempotency)                                             | RES  | Tasks 1, 2, 3      | covered  |
| RESEARCH Pitfall 6 (session-end clears readiness)                            | RES  | Task 7 (documented) | documented |
| AGENTS.md cross-dashboard contract (same-PR Rust mirror)                     | CON  | Tasks 1, 6         | covered  |
| AGENTS.md sub-800 LOC PRs                                                    | CON  | wave_structure     | covered  |
| AGENTS.md no drive-by reformats                                              | CON  | (general guidance) | guidance |
| Notes: trust-not-invocation framing                                          | NOTE | <objective>        | covered  |
| Notes: architecture-status (heartbeat ≠ ready)                               | NOTE | <objective>, T2    | covered  |
</source_audit>

<assumption_check_log>
- **A1 (RELAY_CHANNEL_ID env wiring is in scope):** Task 5 makes this in-scope. If the spawner change is rejected during PR review, the readiness tool degrades gracefully — disk flag still flips, feed entry skipped. The Wave 1 test for "degrades gracefully without RELAY_CHANNEL_ID" already covers the fallback.
- **A3 (workers in Phase 5 will reuse the primitive):** Task 1 reserves `readyKind: "worker"` in the zod enum but no Phase 3 code path emits it. If Phase 5 design diverges, the enum value stays unused and is removable in a non-breaking patch.
- **A5 (agents reliably call `agent_ready`):** Empirical. Task 7 manual smoke is the first datapoint. If real agents drop the call, follow-up work adds a coordinator-detected fallback (e.g., 2-min timeout with `inferredFromIdle: true`) — out of scope here.
</assumption_check_log>

<output>
Plan output for Phase 3 lands at:
- `.planning/phases/03-repo-admin-readiness-handshake/03-PLAN.md` (this file)
- `.planning/phases/03-repo-admin-readiness-handshake/03-SUMMARY.md` (Task 7)
</output>
