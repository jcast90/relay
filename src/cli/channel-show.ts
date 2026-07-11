/**
 * Phase 4 Plan 05 (SURFACE-05 + SURFACE-07): `rly channel show <id|name>`
 * (and the `rly project show <id|name>` alias — D-01: channel IS the
 * project, so `project` is a deprecation-friendly alias that dispatches
 * to the same handler).
 *
 * Mirrors the read pattern from `loadChannelStates` in
 * `print-status-context.ts`: walks `~/.relay/channels/<id>.json` +
 * `~/.relay/crosslink-session/*.json` directly, NEVER through
 * `CrosslinkStore.discoverSessions` (Pitfall #3 — the discover path
 * mutates state by GC'ing records).
 *
 * Output:
 *   - Human mode (default): aligned text — channel header, status, repo
 *     state table, recent feed tail.
 *   - JSON mode (`--json`): a single JSON object with the same fields,
 *     for downstream tooling.
 *
 * Exit codes:
 *   - 0: success (channel rendered).
 *   - 1: channel not found, or unexpected IO error.
 *   - 2: usage error (missing positional).
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import type { Channel, ChannelEntry, RepoAssignment } from "../domain/channel.js";
import {
  deriveRepoAdminState,
  type RepoAdminState,
  type RepoAdminStateSessionInput,
} from "../domain/repo-admin-state.js";
import { getRelayDir } from "./paths.js";
import { defaultIsProcessAlive } from "./print-status-context.js";

const DEFAULT_FEED_TAIL = 5;

const USAGE = [
  "Usage: rly channel show <channelId|name> [--json] [--feed-tail=N]",
  "       rly project show <channelId|name> [--json] [--feed-tail=N]",
  "",
  "Options:",
  "  --json            Emit a machine-readable JSON object.",
  "  --feed-tail=N     Number of recent feed entries to render (default 5).",
  "  --help, -h        Show this message.",
].join("\n");

export interface ChannelShowOptions {
  json: boolean;
  feedTail: number;
  help: boolean;
  errors: string[];
}

export interface ChannelShowRepoView {
  alias: string;
  repoPath: string;
  state: RepoAdminState;
  adminAlias?: string;
}

export interface ChannelShowFeedEntry {
  entryId: string;
  type: string;
  from: string | null;
  content: string;
  createdAt: string;
}

export interface ChannelShowView {
  channelId: string;
  name: string;
  status: string;
  description: string;
  updatedAt?: string;
  repos: ChannelShowRepoView[];
  recentFeed: ChannelShowFeedEntry[];
}

export function parseChannelShowArgs(args: string[]): {
  positional: string | null;
  options: ChannelShowOptions;
} {
  const options: ChannelShowOptions = {
    json: false,
    feedTail: DEFAULT_FEED_TAIL,
    help: false,
    errors: [],
  };
  let positional: string | null = null;

  for (const raw of args) {
    if (raw === "--help" || raw === "-h") {
      options.help = true;
    } else if (raw === "--json") {
      options.json = true;
    } else if (raw.startsWith("--feed-tail=")) {
      const value = raw.slice("--feed-tail=".length);
      const n = Number.parseInt(value, 10);
      if (!Number.isFinite(n) || n < 0) {
        options.errors.push(`Invalid --feed-tail value: ${value}`);
      } else {
        options.feedTail = n;
      }
    } else if (raw.startsWith("--")) {
      options.errors.push(`Unknown flag: ${raw}`);
    } else if (positional === null) {
      positional = raw;
    } else {
      options.errors.push(`Unexpected positional argument: ${raw}`);
    }
  }

  return { positional, options };
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

function readSessions(sessionsDir: string): RawCrosslinkSession[] {
  if (!existsSync(sessionsDir)) return [];
  let files: string[];
  try {
    files = readdirSync(sessionsDir);
  } catch {
    return [];
  }
  const out: RawCrosslinkSession[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const path = join(sessionsDir, file);
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as RawCrosslinkSession;
      if (parsed && typeof parsed === "object") out.push(parsed);
    } catch {
      // L3: malformed session — skip silently. The channel-show view is
      // best-effort; one corrupt file must not block the rest.
      continue;
    }
  }
  return out;
}

function readChannels(channelsDir: string): Channel[] {
  if (!existsSync(channelsDir)) return [];
  let files: string[];
  try {
    files = readdirSync(channelsDir);
  } catch {
    return [];
  }
  const out: Channel[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const path = join(channelsDir, file);
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Channel;
      if (parsed && typeof parsed === "object") out.push(parsed);
    } catch {
      continue;
    }
  }
  return out;
}

/**
 * Resolve a user-supplied `<channelId|name>` to a single channel:
 *   1. Exact `channelId` match wins (handles cleanly-typed UUID/slug ids).
 *   2. Fall back to case-insensitive `name` match. Among ties, prefer
 *      `status === "active"`, then most-recent `updatedAt`.
 *   3. Returns `null` when nothing matches.
 *
 * Documented in T-04-18 of the threat register.
 */
export function resolveChannel(channels: Channel[], idOrName: string): Channel | null {
  const byId = channels.find((c) => c.channelId === idOrName);
  if (byId) return byId;

  const lower = idOrName.toLowerCase();
  const nameMatches = channels.filter((c) => c.name.toLowerCase() === lower);
  if (nameMatches.length === 0) return null;
  if (nameMatches.length === 1) return nameMatches[0] ?? null;

  // Tie-break: active first, then updatedAt desc.
  const sorted = [...nameMatches].sort((a, b) => {
    const aActive = a.status === "active" ? 0 : 1;
    const bActive = b.status === "active" ? 0 : 1;
    if (aActive !== bActive) return aActive - bActive;
    return (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
  });
  return sorted[0] ?? null;
}

function readFeedTail(feedPath: string, n: number): ChannelShowFeedEntry[] {
  if (n <= 0) return [];
  if (!existsSync(feedPath)) return [];
  let raw: string;
  try {
    raw = readFileSync(feedPath, "utf8");
  } catch {
    return [];
  }
  const lines = raw.trim().split("\n").filter(Boolean);
  const tail = lines.slice(-n);
  const out: ChannelShowFeedEntry[] = [];
  for (const line of tail) {
    try {
      const parsed = JSON.parse(line) as ChannelEntry;
      out.push({
        entryId: parsed.entryId,
        type: parsed.type,
        from: parsed.fromDisplayName ?? null,
        content: parsed.content,
        createdAt: parsed.createdAt,
      });
    } catch {
      // L3 per-entry isolation.
      continue;
    }
  }
  return out;
}

/**
 * Assemble the detailed view for a single channel. Pure given an injected
 * `now` + `isProcessAlive` + `relayDir` — used by both the human
 * (`rendering`) and `--json` modes, and unit-testable without spawning
 * any subprocess.
 */
export function buildChannelShowView(
  channel: Channel,
  options: {
    sessions: RawCrosslinkSession[];
    now: number;
    isProcessAlive: (pid: number) => boolean;
    feedPath: string;
    feedTail: number;
  }
): ChannelShowView {
  const assignments: RepoAssignment[] = channel.repoAssignments ?? [];
  const repos: ChannelShowRepoView[] = assignments.map((ra) => {
    const sess = options.sessions.find(
      (s) =>
        s.channelId === channel.channelId && s.readyKind !== "worker" && s.repoPath === ra.repoPath
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
      state = deriveRepoAdminState(input, options.now, options.isProcessAlive);
      if (state === "ready" || state === "booting") {
        adminAlias = sess.displayName;
      }
    }

    return {
      alias: ra.alias,
      repoPath: ra.repoPath,
      state,
      adminAlias,
    };
  });

  const recentFeed = readFeedTail(options.feedPath, options.feedTail);

  return {
    channelId: channel.channelId,
    name: channel.name,
    status: channel.status,
    description: channel.description,
    updatedAt: channel.updatedAt,
    repos,
    recentFeed,
  };
}

function renderHumanView(view: ChannelShowView): string {
  const lines: string[] = [];
  lines.push(`Channel: ${view.name} (${view.channelId})`);
  lines.push(`Status: ${view.status}`);
  if (view.description) lines.push(`Description: ${view.description}`);
  if (view.updatedAt) lines.push(`Updated: ${view.updatedAt}`);
  lines.push("");

  lines.push(`Repos (${view.repos.length}):`);
  if (view.repos.length === 0) {
    lines.push("  (none assigned)");
  } else {
    for (const r of view.repos) {
      const admin = r.adminAlias ? ` admin=${r.adminAlias}` : "";
      lines.push(`  ${r.alias.padEnd(12)} ${r.state.padEnd(13)}${admin}`);
    }
  }
  lines.push("");

  lines.push(`Recent feed (last ${view.recentFeed.length}):`);
  if (view.recentFeed.length === 0) {
    lines.push("  (no entries)");
  } else {
    for (const e of view.recentFeed) {
      const from = e.from ?? "system";
      // Single-line summary: clip overly long bodies so the table stays scan-friendly.
      const body = e.content.replace(/\n/g, " ").slice(0, 120);
      lines.push(`  [${e.createdAt}] ${e.type} ${from}: ${body}`);
    }
  }

  return lines.join("\n");
}

export interface HandleChannelShowDeps {
  relayDir?: string;
  now?: () => number;
  isProcessAlive?: (pid: number) => boolean;
  stdout?: { write(s: string): void };
  stderr?: { write(s: string): void };
}

/**
 * Subcommand entry point. Exported so both `rly channel show` and the
 * `rly project show` alias dispatch to the SAME function reference
 * (verified by the alias-equivalence test in test/cli/channel-show.test.ts).
 *
 * The dependencies object is purely for test injection — production
 * callers pass nothing and the real fs / clock / `process.kill` are used.
 */
export async function handleChannelShowCommand(
  args: string[],
  deps: HandleChannelShowDeps = {}
): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;

  const { positional, options } = parseChannelShowArgs(args);

  if (options.help) {
    stdout.write(USAGE + "\n");
    return 0;
  }

  if (options.errors.length > 0) {
    for (const err of options.errors) stderr.write(err + "\n");
    stderr.write(USAGE + "\n");
    return 2;
  }

  if (!positional) {
    stderr.write("rly channel show: missing <channelId|name>\n");
    stderr.write(USAGE + "\n");
    return 2;
  }

  const relayRoot = deps.relayDir ?? getRelayDir();
  const channelsDir = join(relayRoot, "channels");
  const sessionsDir = join(relayRoot, "crosslink-session");
  const isAlive = deps.isProcessAlive ?? defaultIsProcessAlive;
  const nowMs = deps.now ? deps.now() : Date.now();

  // Channel resolution: this read path NEVER calls discoverSessions
  // (Pitfall #3). We read channel manifests + session records as raw
  // JSON via readFileSync.
  let channels: Channel[];
  try {
    channels = readChannels(channelsDir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr.write(`channel show: failed to read channels directory: ${msg}\n`);
    return 1;
  }

  const channel = resolveChannel(channels, positional);
  if (!channel) {
    stderr.write(`Channel not found: ${positional}\n`);
    return 1;
  }

  const sessions = readSessions(sessionsDir);
  const feedPath = join(channelsDir, channel.channelId, "feed.jsonl");
  // Quick stat-existence check — surfacing IO problems beyond ENOENT is
  // covered inside readFeedTail.
  try {
    if (existsSync(feedPath)) statSync(feedPath);
  } catch {
    // Non-fatal: empty feed is acceptable.
  }

  const view = buildChannelShowView(channel, {
    sessions,
    now: nowMs,
    isProcessAlive: isAlive,
    feedPath,
    feedTail: options.feedTail,
  });

  if (options.json) {
    stdout.write(JSON.stringify(view, null, 2) + "\n");
  } else {
    stdout.write(renderHumanView(view) + "\n");
  }
  return 0;
}

/**
 * Dispatch table for the canonical command + its alias. Both keys MUST
 * point at the SAME function reference so the alias-equivalence test
 * (test/cli/channel-show.test.ts case 8 — Option A) can assert
 * `COMMANDS.project.show === COMMANDS.channel.show`. If you wrap one of
 * these in a closure you've broken the alias contract.
 *
 * Note (D-01): `project` is a deprecation-friendly alias — if "project"
 * later becomes a first-class entity distinct from a channel, point
 * `COMMANDS.project.show` at a new handler and ship a deprecation
 * warning here.
 */
export const COMMANDS = {
  channel: { show: handleChannelShowCommand },
  project: { show: handleChannelShowCommand },
} as const;
