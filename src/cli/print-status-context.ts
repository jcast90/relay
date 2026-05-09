import type { SessionKind } from "../domain/session-budget.js";

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
 * **Phase 1 PR-1:** stub. Implementation lands in PR-4 (Task 11). The
 * shape ships in PR-1 so RED tests compile.
 */
export function formatActiveSessionsBlock(_sessions: ActiveSessionRow[]): string {
  throw new Error("formatActiveSessionsBlock: not yet implemented (Phase 1 PR-4 / Task 11)");
}

/**
 * Walk `~/.relay/sessions/<id>/budget.jsonl` files and resolve the rows
 * that should surface in `rly status`. Filters to `kind === "chat"`;
 * skips malformed individual files (per L3 isolation) and returns `[]`
 * cleanly when the sessions root does not exist.
 *
 * **Phase 1 PR-1:** stub. Implementation lands in PR-4 (Task 11).
 */
export function loadActiveSessions(): ActiveSessionRow[] {
  throw new Error("loadActiveSessions: not yet implemented (Phase 1 PR-4 / Task 11)");
}
