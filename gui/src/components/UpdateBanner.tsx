import { useCallback, useEffect, useState } from "react";
import { api } from "../api";

type Status = Awaited<ReturnType<typeof api.checkRelayUpdate>>;

const REFRESH_MS = 60_000;
const DISMISS_KEY = "relay.updateBanner.dismissedSha";

/**
 * Decide whether to show the banner. Two cases trigger it:
 *   1. The install manifest's `gui` record is behind the source on disk
 *      — i.e. `rly install gui` would do something. The user needs to
 *      run an install.
 *   2. The running GUI's compiled-in SHA differs from the source SHA
 *      reported by `rly install --check`. This catches the gap between
 *      "the user installed a newer GUI" and "the user has actually
 *      relaunched it" — without this, the banner would disappear the
 *      moment the install stamps the manifest, and the still-running
 *      old binary would never tell the user to relaunch.
 *
 * Either signal alone is enough.
 */
function shouldShow(status: Status, dismissedSha: string | null): boolean {
  const sourceSha = status.drift.source.sourceSha;
  if (sourceSha && dismissedSha === sourceSha) return false;
  if (status.runningBehindSource) return true;
  if (status.drift.behind.includes("gui")) return true;
  return false;
}

function shortSha(sha: string | null | undefined): string {
  if (!sha) return "—";
  return sha.slice(0, 7);
}

export function UpdateBanner() {
  const [status, setStatus] = useState<Status | null>(null);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissedSha, setDismissedSha] = useState<string | null>(() => {
    try {
      return localStorage.getItem(DISMISS_KEY);
    } catch {
      return null;
    }
  });

  const refresh = useCallback(async () => {
    try {
      const next = await api.checkRelayUpdate();
      setStatus(next);
      setError(null);
    } catch (e) {
      // Don't surface check errors — they tend to be transient (rly
      // not on PATH yet, repo moved, manifest mid-write). The banner
      // just doesn't show; user can still install via terminal.
      setError(e instanceof Error ? e.message : String(e));
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(t);
  }, [refresh]);

  const handleInstall = useCallback(async () => {
    setInstalling(true);
    try {
      await api.triggerRelayInstallGui();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setInstalling(false);
    }
  }, []);

  const handleDismiss = useCallback(() => {
    if (!status?.drift.source.sourceSha) return;
    const sha = status.drift.source.sourceSha;
    setDismissedSha(sha);
    try {
      localStorage.setItem(DISMISS_KEY, sha);
    } catch {
      // Storage blocked — the dismiss is in-memory for this session
      // only, which is fine; nothing to surface to the user.
    }
  }, [status]);

  if (!status) return null;
  if (!shouldShow(status, dismissedSha)) return null;

  const sourceLabel = `v${status.drift.source.version} (${shortSha(status.drift.source.sourceSha)})`;
  const runningLabel = `v${status.runningVersion}${status.runningSha ? ` (${shortSha(status.runningSha)})` : ""}`;

  // Live region is the message-only span; the buttons and error sit
  // outside so action labels don't get re-announced on every refresh.
  return (
    <div className="update-banner">
      <span className="update-banner__icon" aria-hidden="true">
        ↻
      </span>
      <span className="update-banner__text" role="status" aria-live="polite">
        Update available — running {runningLabel}, source {sourceLabel}
      </span>
      <button
        type="button"
        className="update-banner__install"
        onClick={handleInstall}
        disabled={installing}
      >
        {installing ? "Opening Terminal…" : "Install"}
      </button>
      <button
        type="button"
        className="update-banner__dismiss"
        onClick={handleDismiss}
        title="Dismiss until source moves again"
      >
        Dismiss
      </button>
      {error && <span className="update-banner__error">{error}</span>}
    </div>
  );
}
