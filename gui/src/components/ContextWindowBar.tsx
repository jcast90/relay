import { tokenPctSeverity } from "../lib/tokenSeverity";

export interface ContextWindowBarProps {
  /** Cumulative tokens consumed so far. */
  used: number;
  /** Resolved context-window ceiling for the session's model. */
  total: number;
  /** Claude session id — surfaced in the title attribute for tooltips. */
  sessionId: string;
  /** Optional human-friendly model label (e.g. `"Sonnet 4.5"`). */
  model?: string;
}

/**
 * Phase 1 (per-session token-usage telemetry) — chat-mode percent
 * bar rendered inside the channel/session header. Severity-colored
 * via `tokenPctSeverity` from `gui/src/lib/tokenSeverity.ts` so the
 * tier classes (`metric--tokens-{ok|warn|hot|overrun}`) line up with
 * the worst-session chip in the sidebar.
 *
 * Pure / synchronous: takes `used` + `total` directly. The parent
 * (`CenterPane`) owns polling `api.getChatSessionBudget` on the
 * App-level `refreshTick` and threading the snapshot through. Keeping
 * the component pure means the test suite can render it without
 * mocking the Tauri IPC bridge.
 *
 * Renders nothing when `used === 0` — a chat session that hasn't
 * burned tokens yet (no `budget.jsonl` line written) shouldn't take
 * vertical space below the header. The `metric--tokens-overrun` tier
 * caps the visual fill at 100% width while preserving the literal pct
 * in the label, so a 113% overrun reads "ctx 113%" with a fully-
 * filled magenta rail.
 */
export function ContextWindowBar({
  used,
  total,
  sessionId,
  model,
}: ContextWindowBarProps): JSX.Element | null {
  if (!total || used <= 0) return null;
  const pct = (used / total) * 100;
  const severity = tokenPctSeverity(pct);
  const usedK = (used / 1000).toFixed(1);
  const totalK = (total / 1000).toFixed(0);
  const fillPct = Math.min(100, pct);
  return (
    <div className={`context-window-bar metric--tokens-${severity}`} title={`session ${sessionId}`}>
      <span className="context-window-bar__label">ctx {pct.toFixed(0)}%</span>
      <span className="context-window-bar__counts">
        {usedK}K / {totalK}K tokens
      </span>
      {model && <span className="context-window-bar__model">{model}</span>}
      <div className="context-window-bar__rail" aria-hidden="true">
        <div className="context-window-bar__fill" style={{ width: `${fillPct}%` }} />
      </div>
    </div>
  );
}
