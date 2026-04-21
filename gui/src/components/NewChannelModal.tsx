import { useEffect, useMemo, useRef, useState } from "react";
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
  const [filter, setFilter] = useState("");
  const [highlightIdx, setHighlightIdx] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const filterRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setName("");
    setDescription("");
    setFilter("");
    setHighlightIdx(0);
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

  // Visible rows after filter. `origIndex` keeps a pointer back to the master
  // `repos` array so toggles / alias edits never corrupt non-visible
  // selections when the filter changes.
  const visible = useMemo(() => {
    const tokens = filter.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return repos
      .map((r, origIndex) => ({ row: r, origIndex }))
      .filter(({ row }) => {
        if (tokens.length === 0) return true;
        const haystack = [
          row.workspace.repoPath,
          row.workspace.workspaceId,
          row.alias,
        ]
          .join(" ")
          .toLowerCase();
        return tokens.every((tok) => haystack.includes(tok));
      });
  }, [repos, filter]);

  useEffect(() => {
    if (highlightIdx >= visible.length) {
      setHighlightIdx(Math.max(0, visible.length - 1));
    }
  }, [visible.length, highlightIdx]);

  if (!open) return null;

  const toggleSelected = (origIndex: number) => {
    setRepos((prev) =>
      prev.map((row, j) =>
        j === origIndex ? { ...row, selected: !row.selected } : row,
      ),
    );
  };

  const updateAlias = (origIndex: number, alias: string) => {
    setRepos((prev) =>
      prev.map((row, j) => (j === origIndex ? { ...row, alias } : row)),
    );
  };

  const onFilterKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightIdx((i) => Math.min(visible.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIdx((i) => Math.max(0, i - 1));
    } else if (e.key === " ") {
      // Space toggles the currently highlighted row when the filter field has
      // focus. Avoids the built-in "space in a text input" conflict by only
      // intercepting when there's a highlighted visible row.
      const target = visible[highlightIdx];
      if (target) {
        e.preventDefault();
        toggleSelected(target.origIndex);
      }
    } else if (e.key === "Escape") {
      if (filter.length > 0) {
        e.preventDefault();
        setFilter("");
      }
    }
  };

  const selectedCount = repos.filter((r) => r.selected).length;

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
            <div className="repo-list-head">
              <span className="modal-subhead">
                Repos ({visible.length}/{repos.length}
                {selectedCount > 0 ? ` · ${selectedCount} selected` : ""})
              </span>
            </div>
            {repos.length === 0 ? (
              <div className="empty">
                No registered workspaces. Run `rly up` in a repo first.
              </div>
            ) : (
              <>
                <input
                  ref={filterRef}
                  className="repo-filter"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  onKeyDown={onFilterKeyDown}
                  placeholder="filter by path, alias, or workspace id · ↑↓ navigate · Space toggle · Esc clear"
                />
                <div className="repo-rows">
                  {visible.length === 0 ? (
                    <div className="empty">No repos match “{filter}”.</div>
                  ) : (
                    visible.map(({ row, origIndex }, i) => (
                      <div
                        key={row.workspace.workspaceId}
                        className={`repo-row ${i === highlightIdx ? "highlighted" : ""}`}
                        onClick={() => setHighlightIdx(i)}
                      >
                        <input
                          type="checkbox"
                          checked={row.selected}
                          onChange={() => toggleSelected(origIndex)}
                        />
                        <span
                          className="repo-path"
                          title={row.workspace.repoPath}
                        >
                          {basename(row.workspace.repoPath)}
                        </span>
                        <input
                          className="alias-input"
                          value={row.alias}
                          onChange={(e) => updateAlias(origIndex, e.target.value)}
                          placeholder="alias"
                          disabled={!row.selected}
                        />
                      </div>
                    ))
                  )}
                </div>
              </>
            )}
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
