import { useEffect, useState } from "react";
import { api } from "../api";
import { deriveAlias } from "../lib/alias";
import type { WorkspaceEntry } from "../types";

type Props = {
  open: boolean;
  onClose: () => void;
  onCreated: (channelId: string) => void;
};

export function NewDmModal({ open, onClose, onCreated }: Props) {
  const [workspaces, setWorkspaces] = useState<WorkspaceEntry[]>([]);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setFilter("");
    setError(null);
    api
      .listWorkspaces()
      .then(setWorkspaces)
      .catch(() => setWorkspaces([]));
  }, [open]);

  if (!open) return null;

  const filtered = workspaces.filter((w) =>
    w.repoPath.toLowerCase().includes(filter.trim().toLowerCase())
  );

  const startDm = async (w: WorkspaceEntry) => {
    setBusy(w.workspaceId);
    setError(null);
    try {
      const alias = defaultAlias(w.repoPath);
      const result = await api.createDm(w.workspaceId, w.repoPath, alias);
      onCreated(result.channelId);
      onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-sm" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          New direct message
          <button className="close-btn" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="modal-body">
          <p className="help" style={{ margin: 0, color: "var(--color-text-muted)" }}>
            Pick a workspace to DM its default agent. DMs are kickoff surfaces — promote to a full
            channel when work gets real.
          </p>
          <input
            className="repo-filter"
            placeholder="Filter workspaces…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            autoFocus
          />
          <div className="repo-rows">
            {filtered.length === 0 ? (
              <div className="rail-empty">
                {workspaces.length === 0
                  ? "No registered workspaces. Run `rly up` in a repo first."
                  : "No match"}
              </div>
            ) : (
              filtered.map((w) => (
                <div
                  key={w.workspaceId}
                  className="repo-row"
                  style={{ gridTemplateColumns: "1fr auto", cursor: "pointer" }}
                  onClick={() => !busy && startDm(w)}
                >
                  <span>
                    <div style={{ fontWeight: 600 }}>@{defaultAlias(w.repoPath)}</div>
                    <div
                      style={{
                        fontSize: "var(--font-size-xs)",
                        color: "var(--color-text-dim)",
                      }}
                    >
                      {w.repoPath}
                    </div>
                  </span>
                  <button disabled={busy === w.workspaceId}>
                    {busy === w.workspaceId ? "…" : "Start"}
                  </button>
                </div>
              ))
            )}
          </div>
          {error && <div className="error">{error}</div>}
        </div>
      </div>
    </div>
  );
}

function defaultAlias(repoPath: string): string {
  return deriveAlias(repoPath);
}
