# Phase 4: Project readiness surface - Pattern Map

**Mapped:** 2026-05-11
**Files analyzed:** 14 (8 NEW, 6 EXTEND)
**Analogs found:** 14 / 14 — every Phase 4 surface has a precedented twin in shipped Phase 1/3 code.

Phase 4 is a **composition phase**. Every primitive (readiness flag, channel structure, hook scaffolding, install manifest, drift detection, channel-feed reader, TUI sidebar render, GUI channel header, `rly status` block) already exists. Patterns below tell each plan which precedent to copy.

## Skills / Project Conventions

Checked `.claude/skills/` and `.agents/skills/` — **neither directory exists**. Project conventions live in `CLAUDE.md` → `AGENTS.md` (referenced but not loaded here; planner reads). Phase-specific conventions surface through the analogs themselves: sub-800 LOC PRs, TS/Rust mirror in same PR, `#[serde(default)]` for back-compat, no in-process cache across surfaces.

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| **NEW** `src/domain/repo-admin-state.ts` | domain type / state derivation (TS mirror) | pure transform | `src/crosslink/types.ts` (zod enum + type) + `src/lifecycle/types.ts` (string-union state enum + transition table) | exact |
| **EXTEND** `crates/harness-data/src/lib.rs` (RepoAdminState + derive_state + group_by_admin) | domain type / state derivation (Rust authoritative) | pure transform | Same file lines 600-652 (`CrosslinkSession` + `load_crosslink_sessions`) + lines 660-668 (`TicketProvider` four-value enum with `serde(rename_all)`) | exact |
| **EXTEND** `src/crosslink/hook.ts` (add `generateSessionStartHookScripts()`) | hook generator | file I/O (write generated scripts) | `src/crosslink/hook.ts::generateHookScripts()` lines 6-32 + `buildShellScript` + `buildNodeScript` | exact (same file, sibling fn) |
| **NEW** `src/crosslink/session-start-hook-content.ts` | utility / pure formatter | pure transform | `src/cli/print-status-context.ts::formatActiveSessionsBlock` lines 26-44 | exact |
| **EXTEND** `src/cli/install.ts` + new install step | install integration | file I/O (idempotent JSON merge) | `src/install/installer.ts::installSurface` + `src/install/manifest.ts::markInstalled` + `writeManifest` atomic-rename pattern | role-match (new file write target, same idempotent pattern) |
| **EXTEND** `src/install/manifest.ts` (add `hooks: { claude, codex }` block) | install integration / manifest schema | file I/O | Same file: `SurfaceRecord` / `InstallManifest` / `diffSurface` / `reportDrift` lines 12-192 | exact (same file, additive field) |
| **EXTEND** `src/cli/print-status-context.ts` (add `formatChannelStatesBlock`) | CLI rendering | pure transform | Same file: `formatActiveSessionsBlock` + `loadActiveSessions` lines 26-110 | exact |
| **NEW** `src/cli/channel-show.ts` (rly channel show subcommand handler) | CLI rendering / argv handler | pure transform + read | `src/cli/install.ts::handleInstallCommand` lines 132-164 (argv → parseArgs → dispatch) | role-match |
| **EXTEND** `tui/src/ui.rs` (state column in sidebar) | TUI rendering | pure transform of state → styled spans | Same file: `draw_sidebar` lines 175-298 (specifically the icon/color match block lines 235-241) | exact |
| **EXTEND** `tui/src/main.rs` (load + cache session state on tick) | TUI state load | file I/O (per-tick) | Existing `app.channels` load pattern (calls `load_channels()`) — to be confirmed by planner; precedent: any existing `harness_data::load_*` consumer in `main.rs` | role-match |
| **EXTEND** `gui/src/components/ChannelHeader.tsx` (state badge row) | GUI rendering | request-response (Tauri cmd) | Same file lines 95-112 (agent-stack badge stack) + `RepoChipRow.tsx` chip pattern | exact |
| **EXTEND** `gui/src-tauri/src/lib.rs` (new Tauri cmd returning `Vec<(repo, RepoAdminState)>`) | GUI bridge / backend cmd | request-response | Existing Tauri commands in `gui/src-tauri/src/lib.rs` (planner to confirm exact analog; pattern: `#[tauri::command] fn foo() -> Result<T, String>` calling `harness_data::load_*`) | role-match |
| **EXTEND** Hook-installed `~/.claude/settings.json` (managed by install) | live service config | file I/O (idempotent merge) | Existing `getClaudeHookConfig` in `src/crosslink/hook.ts` lines 182-193 — but only emits the *shape*; Phase 4 writes it from `rly install` | partial (shape exists; writer is new) |
| **EXTEND** `~/.codex/hooks.json` + `~/.codex/config.toml` (`[features].hooks=true`) | live service config | file I/O (idempotent merge) | No existing Codex config writer in repo. Closest analog: `src/install/manifest.ts::writeManifest` atomic-rename pattern (lines 64-69) | role-match (no exact analog; pattern is "idempotent merge + atomic rename") |

## Pattern Assignments

### `src/domain/repo-admin-state.ts` (NEW — domain type / pure transform)

**Analog:** `src/crosslink/types.ts` (zod enum precedent) + `src/lifecycle/types.ts` (string-union state enum).

**Imports pattern** (from `src/crosslink/types.ts` line 1):
```ts
import { z } from "zod";
```

**Enum schema pattern** (from `src/crosslink/types.ts` lines 26-28, 22-24):
```ts
export const ReadyKindSchema = z.enum(["admin", "worker"]);
export type ReadyKind = z.infer<typeof ReadyKindSchema>;
// Phase 4: same shape, four values.
// export const RepoAdminStateSchema = z.enum(["disconnected", "booting", "ready", "stale"]);
// export type RepoAdminState = z.infer<typeof RepoAdminStateSchema>;
```

**Pure transform pattern** (target shape; mirror of Rust `derive_state` — see RESEARCH.md line 432 for the canonical TS mirror sketch):
```ts
// Match the Rust impl byte-for-byte in branch order. STALE_HEARTBEAT_MS
// mirrors the const in src/crosslink/store.ts:19.
export const STALE_HEARTBEAT_MS = 120_000;

export function deriveRepoAdminState(
  session: { pid: number; lastHeartbeat: string; readyAt?: string | null } | null,
  nowMs: number,
  isProcessAlive: (pid: number) => boolean
): RepoAdminState { /* ... */ }
```

**Liveness-check pattern** (from `src/crosslink/hook.ts` lines 161-167):
```ts
function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
```

---

### `crates/harness-data/src/lib.rs` EXTEND (RepoAdminState + derive_state + group_by_admin)

**Analog:** same file. `CrosslinkSession` block (lines 600-621) for the type pattern; `TicketProvider` (lines 660-668) for the four-value enum + serde rename pattern; `load_crosslink_sessions` (lines 633-652) for the read-only enumerator pattern.

**Type pattern** (from same file lines 600-621):
```rust
#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CrosslinkSession {
    pub session_id: String,
    pub pid: u32,
    // ...
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ready_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ready_kind: Option<String>,
}
```

**Four-value enum pattern** (from same file lines 660-668 — `TicketProvider`):
```rust
#[derive(Debug, Deserialize, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TicketProvider {
    Relay,
    Linear,
    None,
    #[serde(other)]
    Unknown,
}
// Phase 4 RepoAdminState: same shape, use rename_all = "kebab-case"
// (matches the canonical wire shape "disconnected" | "booting" | "ready" | "stale").
// Do NOT include #[serde(other)] — the enum is closed.
```

**Read-only enumerator pattern** (from same file lines 633-652 — `load_crosslink_sessions`):
```rust
pub fn load_crosslink_sessions() -> Vec<CrosslinkSession> {
    let dir = harness_root().join("crosslink-session");
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(&dir) else { return out; };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") { continue; }
        let Ok(raw) = std::fs::read_to_string(&path) else { continue; };
        if let Ok(session) = serde_json::from_str::<CrosslinkSession>(&raw) {
            out.push(session);
        }
    }
    out
}
```

**Pure derivation pattern** (Phase 4 addition; see RESEARCH.md Pattern 1):
```rust
pub const STALE_HEARTBEAT_MS: i64 = 120_000;

pub fn derive_state(session: &CrosslinkSession, now_ms: i64) -> RepoAdminState {
    let alive = is_pid_alive(session.pid);
    let hb = parse_iso(&session.last_heartbeat).unwrap_or(0);
    if !alive || now_ms - hb > STALE_HEARTBEAT_MS { return RepoAdminState::Stale; }
    if session.ready_at.is_some() { return RepoAdminState::Ready; }
    RepoAdminState::Booting
}
// Note: Disconnected is decided at the channel level (no CrosslinkSession
// for that repo assignment); derive_state is never called with `None`.
```

**Test pattern** (from same file lines 2676-2767 — Phase 3 added serde + load tests):
```rust
#[test]
fn parses_phase3_session_with_ready_fields() { /* ... */ }
#[test]
fn parses_legacy_session_without_ready_fields() { /* ... */ }
#[test]
fn load_crosslink_sessions_returns_valid_rows_skips_malformed() { /* ... */ }
// Phase 4 adds:
// derive_state_returns_stale_when_pid_dead
// derive_state_returns_stale_when_heartbeat_aged
// derive_state_returns_ready_when_ready_at_set
// derive_state_returns_booting_when_alive_no_ready_at
// group_by_admin_groups_workers_under_admin (forward-compat empty case)
```

---

### `src/crosslink/hook.ts` EXTEND — `generateSessionStartHookScripts()`

**Analog:** same file, `generateHookScripts()` lines 6-32 (sibling generator).

**Generator entry pattern** (lines 6-32):
```ts
export async function generateHookScripts(): Promise<{
  shellScriptPath: string;
  nodeScriptPath: string;
}> {
  const relayDir = getRelayDir();
  const hooksDir = join(relayDir, "crosslink", "hooks");
  await mkdir(hooksDir, { recursive: true });

  const shellScriptPath = join(hooksDir, "check-messages.sh");
  const nodeScriptPath = join(hooksDir, "check-messages.mjs");

  await writeFile(shellScriptPath, buildShellScript(nodeScriptPath));
  await chmod(shellScriptPath, 0o755);
  await writeFile(nodeScriptPath, buildNodeScript(relayDir));

  return { shellScriptPath, nodeScriptPath };
}
// Phase 4: sibling generateSessionStartHookScripts() emitting
// session-start.{sh,mjs} in the same hooksDir.
```

**Shell-wrapper pattern** (lines 34-47):
```ts
function buildShellScript(nodeScriptPath: string): string {
  return `#!/bin/bash
NODE="$(which node 2>/dev/null)"
if [ -z "$NODE" ]; then exit 0; fi
"$NODE" "${nodeScriptPath}" 2>/dev/null
`;
}
```

**Node-script-baked-relay-dir pattern** (lines 49-64):
```ts
function buildNodeScript(relayDir: string): string {
  return `#!/usr/bin/env node
import { readdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";

const RELAY_DIR = ${JSON.stringify(relayDir)};
const SESSIONS_DIR = join(RELAY_DIR, "crosslink-session");
// ...
`;
}
```

**Graceful no-op pattern** (lines 71-99 — critical Phase 4 invariant per Pitfall #2):
```ts
async function main() {
  // ... resolve mySession from env or PID chain ...
  if (!mySession) { process.exit(0); }
  // ... emit context only on success path ...
}
main().catch(() => process.exit(0));
```

**Raw fs session-read pattern** (lines 71-96 — Phase 4 reuses this; do NOT call `discoverSessions()` per Pitfall #3):
```ts
const sessions = await safeReaddir(SESSIONS_DIR);
for (const file of sessions) {
  if (!file.endsWith(".json")) continue;
  try {
    const raw = JSON.parse(await readFile(join(SESSIONS_DIR, file), "utf8"));
    // Phase 4: filter raw.channelId === resolvedChannelId
  } catch { /* skip malformed */ }
}
```

---

### `src/crosslink/session-start-hook-content.ts` (NEW — pure formatter)

**Analog:** `src/cli/print-status-context.ts::formatActiveSessionsBlock` (lines 26-44).

**Pure formatter contract** (lines 26-44):
```ts
export function formatActiveSessionsBlock(sessions: ActiveSessionRow[]): string {
  if (sessions.length === 0) return "";
  const sorted = [...sessions].sort((a, b) => b.pct - a.pct);
  const lines = ["Active sessions:"];
  for (const row of sorted) {
    const usedK = (row.used / 1000).toFixed(0);
    const totalK = (row.total / 1000).toFixed(0);
    const channel = row.channelId ? ` (channel: ${row.channelId})` : "";
    const model = row.model ? ` — ${row.model}` : "";
    lines.push(`- ${row.sessionId}${channel} ctx ${row.pct.toFixed(0)}% ...`);
  }
  return lines.join("\n");
}
```

**Phase 4 application:**
- Input: `{ channelName, repoStates: RepoState[], newFeedEntries?: number }`.
- Empty contract: returns `""` when no repos (caller skips append).
- Sorting: stable presentation; "ready" baseline → mute, "booting" / "stale" emphasized per D-07.
- Glyphs (`●` / `○`) live in the formatter — RESEARCH.md Pattern 3.
- **No IO** — keeps it vitest-friendly in scripted mode.

---

### `src/install/manifest.ts` EXTEND — `hooks: { claude, codex }` manifest block

**Analog:** same file. `SurfaceRecord` / `InstallManifest` / `markInstalled` / `diffSurface`.

**Schema-bump pattern** (lines 21-39):
```ts
interface InstallManifest {
  schemaVersion: 1;
  surfaces: Partial<Record<Surface, SurfaceRecord>>;
  // Phase 4 ADDITIVE: hooks?: Partial<Record<HookTarget, HookRecord>>
  // - additive means schemaVersion stays at 1 (older readers ignore the field)
  // - HookRecord mirrors SurfaceRecord: { sha, installedAt, command }
}
```

**Atomic-rename write pattern** (lines 64-69):
```ts
async function writeManifest(manifest: InstallManifest): Promise<void> {
  const target = manifestPath();
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  await rename(tmp, target);
}
// Phase 4 reuses this for ~/.claude/settings.json + ~/.codex/hooks.json
// idempotent merge writes.
```

**Drift detection pattern** (lines 144-192 — `diffSurface` + `reportDrift`):
```ts
export type SurfaceState = "fresh" | "current" | "behind";
// Phase 4: identical state vocabulary for hook entries.
// "fresh" — never installed (don't nudge)
// "current" — installed sha matches generator output
// "behind" — installed sha differs from generator output
```

**Forward-compat invariant** (lines 36-40): `isManifest` returns false for unrecognized shape; emptyManifest resets. Phase 4's `hooks` field MUST be optional so a manifest written by an old `rly install` still passes the predicate.

---

### `src/cli/install.ts` EXTEND — wire SessionStart hooks for Claude + Codex

**Analog:** same file (`handleInstallCommand` lines 132-164) + `src/install/installer.ts::installSurface` lines 130-182.

**Argv-parse + dispatch pattern** (`install.ts` lines 38-63):
```ts
function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = { surfaces: [], check: false, force: false, ... };
  for (const raw of args) {
    if (raw === "--help" || raw === "-h") parsed.help = true;
    else if (raw === "--check") parsed.check = true;
    // ...
  }
  return parsed;
}
```

**Per-surface install pattern** (`installer.ts` lines 130-176 — the shape Phase 4's hook-install step copies):
```ts
// 1. Read source version + current installed record.
// 2. If matches source SHA → skip with "already at vX".
// 3. Otherwise: run build/write, mark installed via markInstalled().
// 4. Atomic per-surface so partial install still records what succeeded.
```

**Idempotent JSON merge pattern** (Phase 4 addition; RESEARCH.md lines 477-493 for the canonical sketch):
```ts
// 1. readJsonSafe(claudeSettingsPath, { hooks: {} }) — missing file → skeleton
// 2. existing.hooks.SessionStart ??= []
// 3. Filter out entries with matcher === "relay-channel-readiness" (own tag)
// 4. Push fresh entry with current scriptPath + timeout
// 5. writeJsonAtomic (tmp + rename — manifest.ts:64-69 pattern)
```

**Codex feature-flag toggle** (no existing analog; net-new but minimal):
```ts
// Read ~/.codex/config.toml (or treat absent as empty)
// Ensure [features] section has hooks = true
// Idempotent merge — preserve other keys (use a TOML parser, not regex)
// Atomic rename
// Surface a one-line "[rly install] Enabled Codex hooks feature flag." note
// Per Pitfall #5: legacy key codex_hooks is DEPRECATED — write `hooks`.
```

---

### `src/cli/print-status-context.ts` EXTEND — `formatChannelStatesBlock`

**Analog:** same file (lines 26-110 — `formatActiveSessionsBlock` + `loadActiveSessions`).

**Two-function pair pattern**:
- `formatChannelStatesBlock(rows)` — pure formatter, vitest-friendly. Empty list → `""`.
- `loadChannelStates()` — sync IO walk of `~/.relay/channels/` + `~/.relay/crosslink-session/`. Wraps each file read in try/catch (L3 isolation per lines 100-107).

**Empty-block contract** (line 27):
```ts
if (sessions.length === 0) return "";
// Callers do `if (block) { console.log(block); console.log(""); }`
// — see src/index.ts:2816-2821 for the integration site Phase 4 extends.
```

**Synchronous IO + per-file isolation pattern** (lines 57-110):
```ts
export function loadActiveSessions(opts?: { maxAgeMs?: number }): ActiveSessionRow[] {
  const root = join(getRelayDir(), "sessions");
  if (!existsSync(root)) return [];     // L3: missing root → empty
  // ...
  for (const name of entries) {
    try { /* parse last line */ } catch (err) {
      console.warn(`[budget] skipping malformed session file ${file}: ...`);
      continue;
    }
  }
}
// Phase 4 channel-states variant walks `channels/<id>/channel.json`
// + `crosslink-session/*.json` with the same try/catch shell.
```

**Wire-up site** (`src/index.ts` lines 2816-2821):
```ts
const activeSessions = loadActiveSessions();
const activeBlock = formatActiveSessionsBlock(activeSessions);
if (activeBlock) { console.log(activeBlock); console.log(""); }
// Phase 4: identical block-append after Active sessions:
//   const channelStates = loadChannelStates();
//   const channelBlock = formatChannelStatesBlock(channelStates);
//   if (channelBlock) { console.log(channelBlock); console.log(""); }
```

---

### `src/cli/channel-show.ts` (NEW — if planner picks `rly channel show <id>`)

**Analog:** `src/cli/install.ts::handleInstallCommand` (lines 132-164) for argv parse + dispatch shape.

**Subcommand handler signature**:
```ts
export async function handleChannelShowCommand(args: string[]): Promise<number> {
  // 1. parse args (channelId | --json | --help) — same shape as install.ts:38-63
  // 2. Resolve channel by id or name via ChannelStore.listChannels()
  // 3. Load CrosslinkSession records for that channel via raw fs read
  //    (DO NOT call discoverSessions — see Pitfall #3)
  // 4. derive_state per repo
  // 5. Render via formatChannelStatesBlock (same pure formatter)
  // 6. Return 0 on success, 1 on channel-not-found, 2 on argv error
}
```

**Per RESEARCH.md Open Question #2 recommendation:** make `rly channel show` the canonical subcommand; alias `rly project show` to the same handler for deprecation-friendly future-proofing. Both planner's call per CONTEXT.md Claude's Discretion.

---

### `tui/src/ui.rs` EXTEND — state column on channel drill-in

**Analog:** same file (`draw_sidebar` lines 175-298, specifically the icon/color match at lines 235-241 for state→color mapping).

**Per-row styled-span pattern** (lines 230-255 — repo-agent rendering, the exact precedent for repo+state column):
```rust
for repo in &repo_assignments {
    let is_streaming = app.is_worker_streaming(&repo.alias);
    let (icon, icon_color) = if is_streaming {
        ("● ", Color::Green)
    } else if is_active {
        ("◉ ", Color::Cyan)
    } else {
        ("○ ", Color::DarkGray)
    };
    let line = Line::from(vec![
        Span::styled(icon, Style::default().fg(icon_color)),
        Span::styled(format!("@{}", repo.alias), alias_style),
        Span::styled(format!(" {}", repo_short), Style::default().fg(Color::DarkGray)),
    ]);
    agent_items.push(ListItem::new(line));
}
// Phase 4: same Line::from(vec![Span::styled(...)]) shape; the (icon, color)
// match arm is keyed on RepoAdminState rather than is_streaming/is_active.
```

**D-07 color mapping** (Phase 4 application of the precedent):
| State | Glyph | Color | Style |
|-------|-------|-------|-------|
| `ready` | `●` | `Color::DarkGray` | plain (muted baseline per D-07) |
| `booting` | `○` | `Color::Yellow` | warning emphasis |
| `stale` | `×` | `Color::Red` | error emphasis |
| `disconnected` | `·` | `Color::DarkGray` | dimmed |

**Drill-in pattern** (lines 175-215 — `draw_sidebar` channel list iteration; Phase 4 enriches the active-selected channel's expansion):
- The existing `draw_sidebar` iterates `app.channels` and renders one `ListItem` per channel.
- Phase 4 either (a) adds a state-summary suffix to the per-channel label, or (b) replaces the "agent count" parenthetical with a state roll-up (`(2/3 ready)`). Planner picks.

---

### `tui/src/main.rs` EXTEND — load + cache session state on tick

**Analog:** existing `harness_data::load_*` consumer in `main.rs` (planner to confirm exact line; `load_channels()` is referenced at App init around lines 250-368). General pattern: call read-only `load_crosslink_sessions()` from `harness-data` on each App refresh tick; never call mutating `CrosslinkStore.discoverSessions` (Pitfall #3 — that auto-deregisters stale sessions and makes Phase 4's `stale` state unobservable).

**TUI-side liveness check**: `derive_state` must work in Rust. Add `is_pid_alive(pid: u32) -> bool` to `harness-data` (via `nix::sys::signal::kill(pid, None)` or 4-line libc wrapper — per RESEARCH.md A5).

---

### `gui/src/components/ChannelHeader.tsx` EXTEND — state badge row

**Analog:** same file lines 95-112 (`agent-stack` badge row) + `RepoChipRow.tsx` lines 12-80 (chip render with per-item primary/detach UI).

**Badge-stack pattern** (`ChannelHeader.tsx` lines 95-112):
```tsx
<div className="agent-stack">
  {channel.members.slice(0, 4).map((m) => {
    const av = agentAvatar(m.agentId, m.displayName, appearance.avatarStyle);
    return (
      <span key={m.agentId} className="agent-avatar"
        style={{ background: av.background, color: av.color }}
        title={`${m.displayName} · ${m.provider}`}>
        {av.glyph}
      </span>
    );
  })}
</div>
// Phase 4: parallel <div className="repo-state-stack"> rendering one badge
// per repo. Each badge color-coded per D-07 via CSS class .state-ready /
// .state-booting / .state-stale / .state-disconnected.
```

**Tauri-cmd-call pattern** (`RepoChipRow.tsx` line 43, `api.setPrimaryRepo`):
```tsx
await api.setPrimaryRepo(channel.channelId, workspaceId);
// Phase 4 mirror: const states = await api.loadRepoAdminStates(channel.channelId);
// → calls new Tauri cmd in gui/src-tauri/src/lib.rs returning Vec<(repo, RepoAdminState)>.
```

---

### `gui/src-tauri/src/lib.rs` EXTEND — new Tauri cmd returning `Vec<(repo, RepoAdminState)>`

**Analog:** existing `#[tauri::command]` functions in `gui/src-tauri/src/lib.rs` that call `harness_data::load_*` (planner to confirm exact analog; pattern is the same one used by Sidebar to load channels).

**Pattern shape**:
```rust
#[tauri::command]
fn load_repo_admin_states(channel_id: String) -> Result<Vec<(String, RepoAdminState)>, String> {
    // 1. harness_data::load_channel(&channel_id) → repoAssignments
    // 2. harness_data::load_crosslink_sessions() filtered by channel_id
    // 3. For each repoAssignment: derive_state(matching session, now)
    //    OR RepoAdminState::Disconnected if no session
    // 4. Return Vec of (alias, state) tuples
}
```

**Critical:** consumes the same `harness_data::derive_state` as TUI. No re-derivation in `lib.rs` (anti-pattern from RESEARCH.md line 303).

---

### Hook config writes — `~/.claude/settings.json` + `~/.codex/hooks.json`

**Analog:** `src/crosslink/hook.ts::getClaudeHookConfig` (lines 182-193 — emits the *shape* but doesn't write it; today `rly crosslink init` prints instructions for the user to paste).

**Phase 4 change:** `rly install` writes both files directly, idempotently, with drift detection.

**Existing shape** (`hook.ts` lines 182-193):
```ts
export function getClaudeHookConfig(shellScriptPath: string): object {
  return {
    hooks: {
      UserPromptSubmit: [{ type: "command", command: shellScriptPath }],
    },
  };
}
// Phase 4: parallel getClaudeSessionStartHookConfig() returning
// { hooks: { SessionStart: [{ matcher: "relay-channel-readiness",
//   hooks: [{ type: "command", command: scriptPath, timeout: 30 }] }] } }
// + getCodexSessionStartHookConfig() with identical shape.
```

**Critical idempotent-merge invariant** (Phase 4 must add — no current writer exists):
- Read existing file → preserve user-configured hooks.
- Filter out prior Relay entries (own tag `matcher === "relay-channel-readiness"`).
- Append fresh entry.
- Atomic rename write.
- Surface SHA in `installed.json` `hooks` block for `rly install --check` drift detection.

---

## Shared Patterns

### Schema versioning + back-compat (TS/Rust mirror)
**Source:** Phase 1 `SessionBudget`, Phase 3 `CrosslinkSession.readyAt`. Convention: optional fields with `#[serde(default, skip_serializing_if = "Option::is_none")]` (Rust) + `.optional()` (zod). Old files deserialize cleanly; new fields surface only when present.

**Apply to:** All Phase 4 schema changes — `RepoAdminState` enum, optional `lastSeenFeedIdx` watermark on `CrosslinkSession`, manifest `hooks` block, hook script entries.

**Excerpt** (`crates/harness-data/src/lib.rs` lines 617-621):
```rust
#[serde(default, skip_serializing_if = "Option::is_none")]
pub ready_at: Option<String>,
#[serde(default, skip_serializing_if = "Option::is_none")]
pub ready_kind: Option<String>,
```

### Atomic-rename file writes
**Source:** `src/install/manifest.ts::writeManifest` lines 64-69; same pattern in `CrosslinkStore.updateHeartbeat`.

**Apply to:** All Phase 4 disk writes — hook script files (`session-start.{sh,mjs}`), `~/.claude/settings.json` merges, `~/.codex/hooks.json` merges, `~/.codex/config.toml` updates, watermark advancement on `CrosslinkSession`.

```ts
const tmp = `${target}.${process.pid}.tmp`;
await writeFile(tmp, JSON.stringify(manifest, null, 2) + "\n", "utf8");
await rename(tmp, target);
```

### L3 per-file isolation
**Source:** `src/cli/print-status-context.ts::loadActiveSessions` lines 100-107; mirrored in `src/crosslink/hook.ts::main` lines 92-95 (`/* skip malformed */`), `crates/harness-data/src/lib.rs::load_crosslink_sessions` lines 644-651 (`let Ok(...) = ... else { continue; }`).

**Apply to:** All Phase 4 fs walks — hook node script's session enumeration, `loadChannelStates` channel walk, Tauri cmd's session aggregation, TUI tick refresh.

```ts
for (const file of files) {
  try { /* parse + process one file */ }
  catch (err) { /* log + continue — one bad file must not poison the list */ }
}
```

### Graceful no-op hook degradation
**Source:** `src/crosslink/hook.ts` lines 98-100 (`if (!mySession) process.exit(0)`) + line 178 (`main().catch(() => process.exit(0))`).

**Apply to:** Phase 4 SessionStart hook. Exit 0 with empty stdout when:
- No `RELAY_CHANNEL_ID` env AND no `cwd`-prefix match in any `Channel.repoAssignments[]`.
- Resolved channel has zero `repoAssignments`.
- Any unhandled exception in the script.

Critical per Pitfall #2 — hook fires globally on every Claude/Codex session; non-Relay sessions MUST see no error output.

### Forbidden API: `CrosslinkStore.discoverSessions()`
**Source:** `src/crosslink/store.ts` lines 265-268 — auto-deregisters stale sessions.

**Apply to:** All Phase 4 surfaces (hook, TUI, GUI, CLI). Read raw via:
- Rust: `harness_data::load_crosslink_sessions()` (lines 633-652 — no cleanup).
- TS hook node script: direct `readdir + readFile` of `crosslink-session/*.json` (matches existing pattern in `hook.ts` lines 71-96).
- TS CLI (`loadChannelStates`): direct `readdirSync + readFileSync`.

Calling `discoverSessions` makes the `stale` state unobservable — Phase 4's exact failure mode.

### Pure formatter + isolated IO loader
**Source:** `src/cli/print-status-context.ts` (formatActiveSessionsBlock + loadActiveSessions); `gui/src-tauri` Tauri cmd pattern (planner to confirm exact analog).

**Apply to:** Every Phase 4 render path — `formatSessionStartContext` (hook), `formatChannelStatesBlock` (CLI), TUI state-column render (already follows this — pure function maps state → `Span::styled`), GUI badge component (props-driven, no fetching inside render).

Tests assert formatter output via structured shape (not stringified blob — per Project Constraint "No snapshot tests for orchestrator output").

### Closed enum, named consistently TS↔Rust
**Source:** `src/crosslink/types.ts::ReadyKindSchema` (TS) ↔ `crates/harness-data/src/lib.rs::CrosslinkSession.ready_kind` (Rust `Option<String>` — Phase 3 left as string for forward-compat).

**Apply to:** `RepoAdminState`. Wire format: kebab-case (`"disconnected" | "booting" | "ready" | "stale"`). Phase 4 ships this enum closed (no `#[serde(other)] Unknown`) — the four states cover every possible session+channel pairing per D-06.

**Naming check (RESEARCH.md A7, Pitfall #1):** zero overlap with `LifecycleState = "planning" | "dispatching" | "winding_down" | "audit" | "done" | "killed"` (`src/lifecycle/types.ts` lines 7-13). Slight conceptual proximity to `RepoAdminSession._state` field (deferred Phase 3 follow-up). Planner option: bundle the `_state → _processState` rename into Phase 4 PR-1 (RESEARCH.md Pitfall #1 recommendation).

---

## No Analog Found

| File | Role | Data Flow | Reason | Mitigation |
|------|------|-----------|--------|-----------|
| `~/.codex/config.toml` `[features].hooks = true` writer | install integration | TOML merge | No existing TOML writer in repo (Relay is JSON-everywhere internally) | Add a tiny TOML read-merge-write helper. Use a parsed-AST approach (e.g. `@iarna/toml` or `toml` package), NOT regex — Codex users may have hand-edited the file with comments/sections that regex would clobber. Use atomic-rename write per `manifest.ts:64-69`. |
| Codex CLI version probe | install diagnostics | subprocess | No precedent in repo for parsing `codex --version` | One-shot `spawnSync("codex", ["--version"], { encoding: "utf8" })` then split on whitespace + parse semver. Fail-soft per RESEARCH.md Open Question #1 — log a one-line note if `< v0.130`, write config anyway. |
| `lastSeenFeedIdx` watermark advance site | hook write | best-effort field update | No existing per-session watermark on `CrosslinkSession` | RESEARCH.md A4 recommendation: add as optional field with `#[serde(default)]` + `.optional()`. Advance via atomic-rename write at end of hook (after rendering succeeds). If write fails (permission/disk full), hook still exits 0 — watermark is best-effort. **Droppable per D-04 if cost exceeds value.** |

## Metadata

**Analog search scope:**
- `src/crosslink/` (hook generator, store, types)
- `src/cli/` (install, print-status-context, paths)
- `src/install/` (installer, manifest)
- `src/domain/` (channel, session-budget references)
- `src/lifecycle/` (collision check for state naming)
- `crates/harness-data/src/lib.rs` (Rust authoritative read path + four-value enum precedent)
- `tui/src/` (main.rs sidebar, ui.rs render, install_drift.rs drift footer)
- `gui/src/components/` (ChannelHeader, RepoChipRow, Sidebar)
- `gui/src-tauri/` (Tauri cmd pattern — exact file confirmed by planner)

**Files scanned:** ~14 files Read (within 2000-line cap, no re-reads); strategic `grep` for line locations in `tui/src/main.rs` (2960 lines) and `tui/src/ui.rs` (2781 lines) and `crates/harness-data/src/lib.rs` (2910 lines).

**Pattern extraction date:** 2026-05-11

**Key insight for planner:** Phase 4 has **zero greenfield rendering work**. Every surface (hook stdout, TUI sidebar/drill-in, GUI badge, CLI block) has a direct precedent in shipped Phase 1/3 code. The two genuinely new surfaces are (a) `derive_state` in Rust + thin TS mirror, and (b) the `rly install` writers for `~/.claude/settings.json` and `~/.codex/{hooks.json,config.toml}`. Both follow established patterns (closed enum + serde mirror; atomic-rename idempotent merge). The riskiest single line of Phase 4 is the Codex feature-flag toggle in `config.toml` — no TOML writer precedent in the repo, planner should land it in its own PR with focused tests (idempotent on re-run, preserves comments/other keys, atomic).
