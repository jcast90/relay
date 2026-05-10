import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { resolveContextWindow } from "../domain/model-context-windows.js";
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
