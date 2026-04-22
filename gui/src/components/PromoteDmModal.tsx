import { useEffect, useState } from "react";
import { api } from "../api";
import type { Channel, WorkspaceEntry } from "../types";

type Props = {
  channel: Channel;
  onClose: () => void;
  onPromoted: (channelId: string) => void;
};

type Row = {
  workspace: WorkspaceEntry;
  selected: boolean;
  alias: string;
};

// Promote-to-channel modal: takes the DM's single agent/repo as the seed
// primary and lets the user tack on additional repos + rename before
// flipping `kind` to "channel". Shares shape with NewChannelModal step 2,
// but skips the kickoff step — the DM's existing session already has
// history the user can keep working from after promotion.
export function PromoteDmModal({ channel, onClose, onPromoted }: Props) {
  const seed = channel.repoAssignments[0];
  const [name, setName] = useState(stripAtPrefix(channel.name));
  const [topic, setTopic] = useState(channel.description);
  const [workspaces, setWorkspaces] = useState<WorkspaceEntry[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [primaryWorkspaceId, setPrimaryWorkspaceId] = useState<string | null>(
    seed?.workspaceId ?? null
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listWorkspaces()
      .then((ws) => {
        setWorkspaces(ws);
        setRows(
          ws.map((w) => ({
            workspace: w,
            selected: w.workspaceId === seed?.workspaceId,
            alias:
              w.workspaceId === seed?.workspaceId
                ? seed.alias
                : defaultAlias(w.repoPath),
          }))
        );
      })
      .catch(() => setWorkspaces([]));
  }, [seed?.workspaceId, seed?.alias]);

  const toggle = (id: string) => {
    setRows((prev) =>
      prev.map((r) =>
        r.workspace.workspaceId === id ? { ...r, selected: !r.selected } : r
      )
    );
    setPrimaryWorkspaceId((current) => {
      const selected = rows
        .map((r) =>
          r.workspace.workspaceId === id ? { ...r, selected: !r.selected } : r
        )
        .filter((r) => r.selected);
      if (selected.length === 0) return null;
      if (current && selected.some((r) => r.workspace.workspaceId === current)) return current;
      return selected[0].workspace.workspaceId;
    });
  };

  const submit = async () => {
    const slug = slugify(name);
    if (!slug) {
      setError("Channel name is required");
      return;
    }
    const selected = rows.filter((r) => r.selected);
    if (selected.length === 0) {
      setError("Pick at least one repo");
      return;
    }
    if (!primaryWorkspaceId) {
      setError("Pick a primary repo");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.promoteDm(
        channel.channelId,
        slug,
        topic.trim(),
        selected.map((r) => ({
          alias: r.alias,
          workspaceId: r.workspace.workspaceId,
          repoPath: r.workspace.repoPath,
        })),
        primaryWorkspaceId
      );
      onPromoted(channel.channelId);
      onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          Promote DM to channel
          <button className="close-btn" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="modal-body">
          <p className="help" style={{ margin: 0, color: "var(--color-text-muted)" }}>
            The DM's message history is preserved — you'll land in the new channel
            with the same session open.
          </p>
          <label>
            Channel name
            <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </label>
          <label>
            Topic
            <input value={topic} onChange={(e) => setTopic(e.target.value)} />
          </label>
          <div className="repo-list-step">
            <div className="modal-subhead" style={{ fontSize: "var(--font-size-xs)" }}>
              Attached repos
            </div>
            <div className="repo-rows">
              {rows.length === 0 && workspaces.length === 0 ? (
                <div className="rail-empty">No workspaces registered.</div>
              ) : (
                rows.map((r) => {
                  const isPrimary =
                    r.selected && primaryWorkspaceId === r.workspace.workspaceId;
                  return (
                    <div key={r.workspace.workspaceId} className="repo-row">
                      <input
                        type="checkbox"
                        checked={r.selected}
                        onChange={() => toggle(r.workspace.workspaceId)}
                      />
                      <span className="repo-path" title={r.workspace.repoPath}>
                        {basename(r.workspace.repoPath)}
                        {isPrimary && <span className="primary-badge">primary</span>}
                      </span>
                      <input
                        className="alias-input"
                        value={r.alias}
                        onChange={(e) =>
                          setRows((prev) =>
                            prev.map((row) =>
                              row.workspace.workspaceId === r.workspace.workspaceId
                                ? { ...row, alias: e.target.value }
                                : row
                            )
                          )
                        }
                        disabled={!r.selected}
                      />
                      {r.selected ? (
                        <label className="repo-primary-radio">
                          <input
                            type="radio"
                            name="primary"
                            checked={isPrimary}
                            onChange={() =>
                              setPrimaryWorkspaceId(r.workspace.workspaceId)
                            }
                          />
                          primary
                        </label>
                      ) : (
                        <span className="repo-primary-radio placeholder" />
                      )}
                      <span className="repo-spawn-toggle placeholder" />
                    </div>
                  );
                })
              )}
            </div>
          </div>
          {error && <div className="error">{error}</div>}
        </div>
        <div className="modal-footer" style={{ justifyContent: "flex-end" }}>
          <button onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="primary" onClick={submit} disabled={busy}>
            {busy ? "Promoting…" : "Promote"}
          </button>
        </div>
      </div>
    </div>
  );
}

function stripAtPrefix(s: string): string {
  return s.startsWith("@") ? s.slice(1) : s;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function basename(p: string): string {
  return p.split("/").filter(Boolean).pop() ?? p;
}

function defaultAlias(repoPath: string): string {
  return basename(repoPath).replace(/[^a-z0-9-]/gi, "").toLowerCase().slice(0, 12);
}
