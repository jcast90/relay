import { useEffect, useState } from "react";
import { api } from "../api";
import type { WorkspaceEntry } from "../types";

type Props = {
  open: boolean;
  onClose: () => void;
  onCreated: (channelId: string) => void;
};

type RepoRow = {
  workspace: WorkspaceEntry;
  selected: boolean;
  alias: string;
};

export function NewChannelModal({ open, onClose, onCreated }: Props) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [repos, setRepos] = useState<RepoRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName("");
    setDescription("");
    setError(null);
    api.listWorkspaces().then((ws) => {
      setRepos(
        ws.map((w) => ({
          workspace: w,
          selected: false,
          alias: defaultAlias(w.repoPath),
        })),
      );
    });
  }, [open]);

  if (!open) return null;

  const submit = async () => {
    if (!name.trim()) {
      setError("Name is required");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const selected = repos
        .filter((r) => r.selected)
        .map((r) => ({
          alias: r.alias.trim() || defaultAlias(r.workspace.repoPath),
          workspaceId: r.workspace.workspaceId,
          repoPath: r.workspace.repoPath,
        }));
      const result = await api.createChannel(name.trim(), description.trim(), selected);
      onCreated(result.channelId);
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">New channel</div>
        <div className="modal-body">
          <label>
            Name
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. proposal-pilot"
            />
          </label>
          <label>
            Description
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional"
            />
          </label>
          <div className="repo-list">
            <div className="modal-subhead">Repos</div>
            {repos.length === 0 && (
              <div className="empty">
                No registered workspaces. Run `agent-harness up` in a repo first.
              </div>
            )}
            {repos.map((r, i) => (
              <div key={r.workspace.workspaceId} className="repo-row">
                <input
                  type="checkbox"
                  checked={r.selected}
                  onChange={(e) =>
                    setRepos((prev) =>
                      prev.map((row, j) =>
                        i === j ? { ...row, selected: e.target.checked } : row,
                      ),
                    )
                  }
                />
                <span className="repo-path" title={r.workspace.repoPath}>
                  {basename(r.workspace.repoPath)}
                </span>
                <input
                  className="alias-input"
                  value={r.alias}
                  onChange={(e) =>
                    setRepos((prev) =>
                      prev.map((row, j) =>
                        i === j ? { ...row, alias: e.target.value } : row,
                      ),
                    )
                  }
                  placeholder="alias"
                  disabled={!r.selected}
                />
              </div>
            ))}
          </div>
          {error && <div className="error">{error}</div>}
        </div>
        <div className="modal-footer">
          <button onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="primary" onClick={submit} disabled={busy}>
            {busy ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}

function basename(p: string): string {
  return p.split("/").filter(Boolean).pop() ?? p;
}

function defaultAlias(repoPath: string): string {
  return basename(repoPath).replace(/[^a-z0-9-]/gi, "").toLowerCase().slice(0, 12);
}
