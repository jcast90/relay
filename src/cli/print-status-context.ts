import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import type { Channel, RepoAssignment } from "../domain/channel.js";
import { resolveContextWindow } from "../domain/model-context-windows.js";
import {
  deriveRepoAdminState,
  type RepoAdminState,
  type RepoAdminStateSessionInput,
} from "../domain/repo-admin-state.js";
import type { SessionKind } from "../domain/session-budget.js";
import { getRelayDir } from "./paths.js";

export interface ActiveSessionRow {
  sessionId: string;
  channelId?: string;
  pct: number;
  used: number;
  total: number;
  model?: string;
  kind?: SessionKind;
}

/**
 * Pure formatter for the `Active sessions:` block in `rly status`. Takes
 * the rows resolved by `loadActiveSessions()` and returns the printable
 * lines. No `~/.relay/` reads here — keeps the formatter unit-testable.
 *
 * Returns `""` for an empty list so callers can append-then-skip-on-empty
 * without a separate length check.
 */
export function formatActiveSessionsBlock(sessions: ActiveSessionRow[]): string {
  if (sessions.length === 0) return "";

  // Worst-percent first so an operator scanning the block sees the most
  // budget-pressured session at the top.
  const sorted = [...sessions].sort((a, b) => b.pct - a.pct);

  const lines = ["Active sessions:"];
  for (const row of sorted) {
    const usedK = (row.used / 1000).toFixed(0);
    const totalK = (row.total / 1000).toFixed(0);
    const channel = row.channelId ? ` (channel: ${row.channelId})` : "";
    const model = row.model ? ` — ${row.model}` : "";
    lines.push(
      `- ${row.sessionId}${channel} ctx ${row.pct.toFixed(0)}% (${usedK}K / ${totalK}K tokens)${model}`
    );
  }
  return lines.join("\n");
}

/**
 * Walk `~/.relay/sessions/<id>/budget.jsonl` files and resolve the rows
 * that should surface in `rly status`. Filters to `kind === "chat"` (M3 /
 * M4 — admin and orchestrator-run keyspaces are excluded). L3 isolation:
 * guards against missing root + per-file parse errors so one bad file
 * doesn't poison the whole list.
 *
 * Synchronous: this runs at most once per `rly status` invocation and the
 * caller already prints synchronously to stdout. Sync IO keeps the surface
 * simple for tests and matches the rest of the status-print path.
 */
export function loadActiveSessions(opts?: { maxAgeMs?: number }): ActiveSessionRow[] {
  const root = join(getRelayDir(), "sessions");
  if (!existsSync(root)) return []; // L3: missing root → empty, no throw.

  const maxAge = opts?.maxAgeMs ?? 24 * 60 * 60 * 1000;
  const now = Date.now();

  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }

  const rows: ActiveSessionRow[] = [];
  for (const name of entries) {
    const file = join(root, name, "budget.jsonl");
    try {
      const st = statSync(file);
      if (now - st.mtimeMs > maxAge) continue;

      const content = readFileSync(file, "utf8");
      const lastLine = content.trim().split("\n").filter(Boolean).pop();
      if (!lastLine) continue;

      const parsed = JSON.parse(lastLine);
      if (parsed.kind !== "chat") continue; // M3 / M4: chat sessions only.

      const used = typeof parsed.cumulativeUsed === "number" ? parsed.cumulativeUsed : 0;
      const model = typeof parsed.model === "string" ? parsed.model : undefined;
      const channelId = typeof parsed.channelId === "string" ? parsed.channelId : undefined;
      const total = resolveContextWindow(model);
      const pct = total === 0 ? 0 : (used / total) * 100;

      rows.push({
        sessionId: name,
        channelId,
        pct,
        used,
        total,
        model,
        kind: "chat",
      });
    } catch (err) {
      // L3: per-file error isolation. A single malformed `budget.jsonl`
      // (e.g. partial flush, hand-edited line) must not block other
      // sessions from surfacing.
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[budget] skipping malformed session file ${file}: ${message}`);
      continue;
    }
  }
  return rows;
}

/**
 * Phase 4 Plan 05: shape consumed by the `Channels:` block in `rly status`
 * and the per-channel detail view in `rly channel show`. Mirrors what the
 * Tauri command `load_repo_admin_states` returns on the GUI side.
 */
export interface ChannelRepoRow {
  alias: string;
  state: RepoAdminState;
  /**
   * Display alias of the admin agent currently bound to this repo, when one
   * exists. Only meaningful when `state` is `"ready"` or `"booting"`. Per
   * D-03 in 04-CONTEXT.md this is a pure presentation detail — never used
   * for state derivation.
   */
  adminAlias?: string;
  /** Underlying repo path — surfaced for the `channel show` detail view. */
  repoPath?: string;
}

export interface ChannelStateRow {
  channelId: string;
  name: string;
  status: string;
  /** Channel `updatedAt` so callers can re-sort or display recency. */
  updatedAt?: string;
  repos: ChannelRepoRow[];
}

/**
 * Pure formatter for the `Channels:` block in `rly status`. Mirrors the
 * `formatActiveSessionsBlock` empty contract: returns `""` for an empty
 * list so callers can append-then-skip without a separate length check.
 *
 * The state vocabulary (`disconnected | booting | ready | stale`) is the
 * same four kebab-case words the SessionStart hook, TUI sidebar, and GUI
 * badge row use — single source of truth per D-06.
 */
export function formatChannelStatesBlock(rows: ChannelStateRow[]): string {
  if (rows.length === 0) return "";

  const lines = ["Channels:"];
  for (const ch of rows) {
    lines.push(`- ${ch.name} (${ch.repos.length} repos)`);
    for (const r of ch.repos) {
      const admin = r.adminAlias ? ` admin=${r.adminAlias}` : "";
      lines.push(`    ${r.alias.padEnd(12)} ${r.state}${admin}`);
    }
  }
  return lines.join("\n");
}

/**
 * Default `isProcessAlive` helper. Mirrors the inline shim in
 * `src/crosslink/store.ts::isProcessAlive` and `src/crosslink/hook.ts`'s
 * generated runtime helper — kept here as a thin export so callers
 * (`loadChannelStates`, `handleChannelShowCommand`) can inject a
 * deterministic stub in tests without each one growing its own copy.
 */
export function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface RawCrosslinkSession {
  sessionId: string;
  pid?: number;
  repoPath?: string;
  channelId?: string;
  lastHeartbeat?: string;
  readyAt?: string;
  readyKind?: string;
  displayName?: string;
}

interface LoadChannelStatesOptions {
  /** Filter to channels with `status === "active"`. Defaults to `true` (D-01). */
  onlyActive?: boolean;
  /** Injected for tests; production resolves via `process.kill(pid, 0)`. */
  isProcessAlive?: (pid: number) => boolean;
  /** Injected for tests so we don't have to mock the system clock. */
  now?: () => number;
}

/**
 * Walk `~/.relay/channels/<id>.json` directly (NEVER through
 * `CrosslinkStore.discoverSessions` — Pitfall #3 enforces this: the
 * discover path mutates state by garbage-collecting stale records).
 *
 * Returns one `ChannelStateRow` per active channel, with one
 * `ChannelRepoRow` per `repoAssignments[i]` resolved against the live
 * `~/.relay/crosslink-session/*.json` files. The session-to-repo
 * predicate matches the Rust `load_repo_admin_states` exactly:
 * `session.channelId === channel.channelId && session.readyKind !== "worker"
 *  && session.repoPath === ra.repoPath`.
 *
 * L3 isolation: any malformed channel.json or session.json is skipped
 * with a single `console.warn`; one bad file must not block the rest.
 */
export function loadChannelStates(opts?: LoadChannelStatesOptions): ChannelStateRow[] {
  const onlyActive = opts?.onlyActive ?? true;
  const isAlive = opts?.isProcessAlive ?? defaultIsProcessAlive;
  const nowMs = opts?.now ? opts.now() : Date.now();

  const relayRoot = getRelayDir();
  const channelsDir = join(relayRoot, "channels");
  const sessionsDir = join(relayRoot, "crosslink-session");

  if (!existsSync(channelsDir)) return [];

  // 1. Slurp all crosslink-session/*.json ONCE up front (raw — no
  //    discoverSessions). One try/catch per file; one bad entry must not
  //    poison the rest.
  const sessions: RawCrosslinkSession[] = [];
  if (existsSync(sessionsDir)) {
    let sessionEntries: string[] = [];
    try {
      sessionEntries = readdirSync(sessionsDir);
    } catch {
      sessionEntries = [];
    }
    for (const file of sessionEntries) {
      if (!file.endsWith(".json")) continue;
      const path = join(sessionsDir, file);
      try {
        const raw = readFileSync(path, "utf8");
        const parsed = JSON.parse(raw) as RawCrosslinkSession;
        if (parsed && typeof parsed === "object") {
          sessions.push(parsed);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[channels] skipping malformed session file ${path}: ${message}`);
        continue;
      }
    }
  }

  // 2. Walk every `channels/<id>.json` and assemble the rows.
  let channelFiles: string[] = [];
  try {
    channelFiles = readdirSync(channelsDir);
  } catch {
    return [];
  }

  const rows: ChannelStateRow[] = [];
  for (const file of channelFiles) {
    if (!file.endsWith(".json")) continue;
    const path = join(channelsDir, file);
    let channel: Channel;
    try {
      channel = JSON.parse(readFileSync(path, "utf8")) as Channel;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[channels] skipping malformed channel file ${path}: ${message}`);
      continue;
    }

    if (onlyActive && channel.status !== "active") continue;

    const assignments: RepoAssignment[] = channel.repoAssignments ?? [];
    const repos: ChannelRepoRow[] = assignments.map((ra) => {
      // SAME predicate as the Rust `load_repo_admin_states` so all four
      // surfaces (hook, TUI, GUI, CLI) bind the same session to the same
      // repo for the same channel.
      const sess = sessions.find(
        (s) =>
          s.channelId === channel.channelId &&
          s.readyKind !== "worker" &&
          s.repoPath === ra.repoPath
      );

      let state: RepoAdminState;
      let adminAlias: string | undefined;
      if (!sess || typeof sess.pid !== "number" || typeof sess.lastHeartbeat !== "string") {
        state = "disconnected";
      } else {
        const input: RepoAdminStateSessionInput = {
          pid: sess.pid,
          lastHeartbeat: sess.lastHeartbeat,
          readyAt: sess.readyAt ?? null,
        };
        state = deriveRepoAdminState(input, nowMs, isAlive);
        if (state === "ready" || state === "booting") {
          adminAlias = sess.displayName;
        }
      }

      return {
        alias: ra.alias,
        state,
        adminAlias,
        repoPath: ra.repoPath,
      };
    });

    rows.push({
      channelId: channel.channelId,
      name: channel.name,
      status: channel.status,
      updatedAt: channel.updatedAt,
      repos,
    });
  }

  // Most recently active first — same default the channel sidebar uses
  // so operators eyeballing `rly status` see the freshest channels.
  rows.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  return rows;
}
