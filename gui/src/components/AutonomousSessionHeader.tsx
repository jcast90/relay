import { useEffect, useState } from "react";
import { api } from "../api";
import type { AutonomousSessionState } from "../types";

type Props = {
  sessionId: string;
  refreshTick: number;
  onStopped?: () => void;
};

/**
 * AL-10: compact status strip rendered inside the CenterPane whenever the
 * selected channel has an active autonomous session attached. Polls
 * `get_session_state` on every parent `refreshTick` bump (App runs a 5s
 * interval) so tokens %, hours remaining, and lifecycle state stay fresh
 * without the header managing its own interval.
 *
 * No-flicker policy: when a poll fails or the session disappears mid-tick,
 * the header keeps rendering the last-known state rather than blanking.
 * Only when `get_session_state` resolves to `null` (session terminated)
 * AND the previous state was terminal (`done`/`killed`) do we stop
 * rendering, because the user should see the final state briefly before
 * the strip unmounts.
 *
 * Theme: every color comes from `--color-*` tokens (tokens.css). No
 * hex drift; the header reads as part of the existing Catppuccin palette.
 */
export function AutonomousSessionHeader({ sessionId, refreshTick, onStopped }: Props) {
  const [state, setState] = useState<AutonomousSessionState | null>(null);
  const [fetching, setFetching] = useState(false);
  const [stopConfirmOpen, setStopConfirmOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setFetching(true);
    api
      .getSessionState(sessionId)
      .then((next) => {
        if (cancelled) return;
        // Preserve previous snapshot on transient nulls — lifecycle.json
        // is rewritten atomically but a narrow window exists where the
        // rename finishes before the metadata read lands. Next tick will
        // resync. Only clear when we're sure the session is gone (state
        // returned null AND metadata was never present for it).
        if (next !== null) setState(next);
      })
      .catch((err) => {
        console.warn("[autonomous-header] getSessionState failed", err);
      })
      .finally(() => {
        if (!cancelled) setFetching(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, refreshTick]);

  if (!state) {
    // First-poll state. Render a placeholder row so the CenterPane layout
    // doesn't jump when the fetch resolves — the strip is load-bearing for
    // vertical alignment beneath the channel header.
    return <div className="autonomous-session-header autonomous-session-header--pending" />;
  }

  const terminal = state.state === "done" || state.state === "killed";
  const budgetPctLabel = formatPct(state.budgetPct);
  const hoursRemainingLabel = formatHours(state.hoursRemaining);
  const tokenSeverity = tokenPctSeverity(state.budgetPct);

  const requestStop = () => {
    setStopError(null);
    setStopConfirmOpen(true);
  };

  const confirmStop = async () => {
    setStopping(true);
    setStopError(null);
    try {
      await api.stopSession(sessionId);
      setStopConfirmOpen(false);
      onStopped?.();
    } catch (err) {
      setStopError(err instanceof Error ? err.message : String(err));
    } finally {
      setStopping(false);
    }
  };

  return (
    <div
      className={`autonomous-session-header autonomous-session-header--state-${state.state}`}
      data-fetching={fetching ? "true" : "false"}
    >
      <div className="autonomous-session-header__row">
        <span className={`autonomous-session-header__pill pill-state-${state.state}`}>
          {prettyState(state.state)}
        </span>
        <span className="autonomous-session-header__trust">
          trust: <strong>{state.trust || "supervised"}</strong>
        </span>
        <span className={`autonomous-session-header__metric metric--tokens-${tokenSeverity}`}>
          tokens{" "}
          <strong>
            {formatNumber(state.budgetUsed)} / {formatNumber(state.budgetTokens)}
          </strong>{" "}
          ({budgetPctLabel})
        </span>
        <span className="autonomous-session-header__metric">
          wall-clock <strong>{hoursRemainingLabel}</strong> left
        </span>
        {state.currentTicketId && (
          <span className="autonomous-session-header__metric">
            ticket{" "}
            <a
              href={`#ticket-${state.currentTicketId}`}
              className="autonomous-session-header__ticket-link"
              title={state.currentTicketId}
            >
              {state.currentTicketId.slice(0, 10)}
            </a>
          </span>
        )}
        <span className="autonomous-session-header__spacer" />
        {!terminal && (
          <button
            type="button"
            className="autonomous-session-header__kill"
            onClick={requestStop}
            disabled={stopping}
            title="Stop the autonomous session (writes STOP file)"
          >
            {stopping ? "Stopping…" : "Stop session"}
          </button>
        )}
      </div>
      {stopConfirmOpen && (
        <StopConfirmDialog
          sessionId={sessionId}
          onCancel={() => setStopConfirmOpen(false)}
          onConfirm={confirmStop}
          busy={stopping}
          error={stopError}
        />
      )}
    </div>
  );
}

function StopConfirmDialog({
  sessionId,
  onCancel,
  onConfirm,
  busy,
  error,
}: {
  sessionId: string;
  onCancel: () => void;
  onConfirm: () => void;
  busy: boolean;
  error: string | null;
}) {
  // I5: Escape dismisses the confirm dialog. Keeps muscle memory consistent
  // with every other modal in the GUI; without this, users had to click
  // "Cancel" or the stop button to exit. We wire to `document` rather than
  // the rendered div because the dialog isn't focused by default (the
  // "Stop session" button steals focus via autoFocus) so an unfocused key
  // event on the document needs to reach us.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) {
        e.preventDefault();
        onCancel();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel, busy]);
  return (
    <div className="autonomous-session-header__confirm">
      <div className="autonomous-session-header__confirm-body">
        Stop session <code>{sessionId}</code>? The autonomous driver will wind down on its next
        check; in-flight ticket work may land in a partial state.
      </div>
      {error && <div className="autonomous-session-header__confirm-error">{error}</div>}
      <div className="autonomous-session-header__confirm-actions">
        <button type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="danger" onClick={onConfirm} disabled={busy} autoFocus>
          {busy ? "Stopping…" : "Stop session"}
        </button>
      </div>
    </div>
  );
}

// Exported for unit tests — the pure helpers encode the AL-10 acceptance
// criteria (tokens %, hours remaining, threshold severity) and are worth
// asserting directly instead of through the React tree.
export function prettyStateForTesting(s: string): string {
  return prettyState(s);
}
export function formatPctForTesting(n: number): string {
  return formatPct(n);
}
export function formatHoursForTesting(hours: number): string {
  return formatHours(hours);
}
export function tokenPctSeverityForTesting(pct: number): "ok" | "warn" | "hot" | "overrun" {
  return tokenPctSeverity(pct);
}

function prettyState(s: string): string {
  // Normalize the snake_case lifecycle states into a single-word badge.
  switch (s) {
    case "planning":
      return "Planning";
    case "dispatching":
      return "Dispatching";
    case "winding_down":
      return "Winding down";
    case "audit":
      return "Audit";
    case "done":
      return "Done";
    case "killed":
      return "Killed";
    default:
      return s;
  }
}

function formatPct(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return `${Math.round(n)}%`;
}

function formatHours(hours: number): string {
  if (!Number.isFinite(hours) || hours < 0) return "—";
  if (hours >= 1) {
    const whole = Math.floor(hours);
    const minutes = Math.round((hours - whole) * 60);
    return minutes > 0 ? `${whole}h ${minutes}m` : `${whole}h`;
  }
  const minutes = Math.round(hours * 60);
  return `${minutes}m`;
}

function formatNumber(n: number): string {
  return n.toLocaleString();
}

/** Color severity for the tokens pill. Matches the AL-1 threshold tiers so
 * the header's visual language lines up with what the TokenTracker emits
 * via its `threshold` event. */
function tokenPctSeverity(pct: number): "ok" | "warn" | "hot" | "overrun" {
  if (pct >= 100) return "overrun";
  if (pct >= 85) return "hot";
  if (pct >= 60) return "warn";
  return "ok";
}
