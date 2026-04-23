import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { basename, deriveAlias } from "../lib/alias";
import { notifyError } from "../lib/dialogs";
import type { Channel, WorkspaceEntry } from "../types";

type Props = {
  channel: Channel;
  onChanged: () => void;
};

export function RepoChipRow({ channel, onChanged }: Props) {
  const [openChipId, setOpenChipId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClickOutside = (e: MouseEvent) => {
      if (!rowRef.current) return;
      if (!rowRef.current.contains(e.target as Node)) {
        setOpenChipId(null);
        setAddOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpenChipId(null);
        setAddOpen(false);
      }
    };
    document.addEventListener("mousedown", onClickOutside);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClickOutside);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  const primaryId = channel.primaryWorkspaceId ?? channel.repoAssignments[0]?.workspaceId;

  const setPrimary = async (workspaceId: string) => {
    try {
      await api.setPrimaryRepo(channel.channelId, workspaceId);
      onChanged();
      setOpenChipId(null);
    } catch (err) {
      await notifyError(`Promote failed: ${err}`);
    }
  };

  const detach = async (workspaceId: string) => {
    const remaining = channel.repoAssignments.filter((r) => r.workspaceId !== workspaceId);
    try {
      const result = await api.updateChannelRepos(
        channel.channelId,
        remaining.map((r) => ({
          alias: r.alias,
          workspaceId: r.workspaceId,
          repoPath: r.repoPath,
        }))
      );
      if (result.droppedRepos && result.droppedRepos.length > 0) {
        // Not fatal — the detach succeeded. Surface the skipped rows so
        // the user knows which legacy entries got cleaned up in the round-trip.
        await notifyError(
          `${result.droppedRepos.length} unrepresentable repo(s) cleaned up: ${result.droppedRepos.join(", ")}`,
          { title: "Cleanup" }
        );
      }
      onChanged();
      setOpenChipId(null);
    } catch (err) {
      await notifyError(`Detach failed: ${err}`);
    }
  };

  const spawnInTerminal = async (alias: string, repoPath: string) => {
    try {
      await api.spawnAgent(channel.channelId, alias, repoPath);
      setOpenChipId(null);
    } catch (err) {
      await notifyError(`Spawn failed: ${err}`);
    }
  };

  return (
    <div className="repo-chip-row" ref={rowRef}>
      {channel.repoAssignments.map((r) => {
        const isPrimary = r.workspaceId === primaryId;
        const open = openChipId === r.workspaceId;
        return (
          <div key={r.workspaceId} style={{ position: "relative" }}>
            <button
              className={`repo-chip ${isPrimary ? "primary" : "attached"}`}
              onClick={() => setOpenChipId(open ? null : r.workspaceId)}
              title={r.repoPath}
            >
              <span>@{r.alias}</span>
              {!isPrimary && (
                <span
                  className="detach-x"
                  onClick={(e) => {
                    e.stopPropagation();
                    detach(r.workspaceId);
                  }}
                  title="Detach"
                >
                  ×
                </span>
              )}
            </button>
            {open && (
              <div className="popover" style={{ top: "calc(100% + 4px)", left: 0 }}>
                <div className="popover-header">@{r.alias}</div>
                {!isPrimary && (
                  <div className="popover-item" onClick={() => setPrimary(r.workspaceId)}>
                    Set as primary
                  </div>
                )}
                <div className="popover-item" onClick={() => spawnInTerminal(r.alias, r.repoPath)}>
                  Spawn in Terminal
                </div>
                {!isPrimary ? (
                  <div className="popover-item danger" onClick={() => detach(r.workspaceId)}>
                    Detach
                  </div>
                ) : (
                  <div className="popover-item disabled" title="Promote another repo first">
                    Detach (primary)
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}

      <div style={{ position: "relative" }}>
        <button className="repo-chip add" onClick={() => setAddOpen((v) => !v)} title="Attach repo">
          +
        </button>
        {addOpen && (
          <AddRepoPopover
            channel={channel}
            onClose={() => setAddOpen(false)}
            onAttached={() => {
              onChanged();
              setAddOpen(false);
            }}
          />
        )}
      </div>
    </div>
  );
}

function AddRepoPopover({
  channel,
  onClose,
  onAttached,
}: {
  channel: Channel;
  onClose: () => void;
  onAttached: () => void;
}) {
  const [workspaces, setWorkspaces] = useState<WorkspaceEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());

  useEffect(() => {
    api
      .listWorkspaces()
      .then(setWorkspaces)
      .catch(() => setWorkspaces([]));
  }, []);

  const attachedIds = new Set(channel.repoAssignments.map((r) => r.workspaceId));
  const available = workspaces.filter((w) => !attachedIds.has(w.workspaceId));
  const q = query.trim().toLowerCase();
  const filtered = q
    ? available.filter((w) => basename(w.repoPath).toLowerCase().includes(q))
    : available;

  const toggle = (id: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const attach = async () => {
    if (busy || picked.size === 0) return;
    setBusy(true);
    const taken = new Set(channel.repoAssignments.map((r) => r.alias));
    const toAdd = available.filter((w) => picked.has(w.workspaceId));
    const additions = toAdd.map((w) => {
      let alias = deriveAlias(w.repoPath);
      if (taken.has(alias)) {
        let n = 2;
        while (taken.has(`${alias}-${n}`)) n++;
        alias = `${alias}-${n}`;
      }
      taken.add(alias);
      return { alias, workspaceId: w.workspaceId, repoPath: w.repoPath };
    });
    const next = [
      ...channel.repoAssignments.map((r) => ({
        alias: r.alias,
        workspaceId: r.workspaceId,
        repoPath: r.repoPath,
      })),
      ...additions,
    ];
    try {
      const result = await api.updateChannelRepos(channel.channelId, next);
      if (result.droppedRepos && result.droppedRepos.length > 0) {
        await notifyError(
          `${result.droppedRepos.length} unrepresentable repo(s) skipped: ${result.droppedRepos.join(", ")}`,
          { title: "Attach" }
        );
      }
      onAttached();
    } catch (err) {
      await notifyError(`Attach failed: ${err}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="attach-popover" style={{ top: "calc(100% + 4px)", right: 0 }}>
      <div className="attach-popover-head">
        <div className="attach-popover-title">
          Attach repos{picked.size > 0 && ` · ${picked.size} selected`}
        </div>
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search workspaces…"
          className="attach-popover-search"
        />
      </div>
      <div className="attach-popover-list">
        {filtered.length === 0 ? (
          <div className="attach-popover-empty">
            {available.length === 0 ? "All workspaces already attached." : "No matches."}
          </div>
        ) : (
          filtered.map((w) => {
            const isPicked = picked.has(w.workspaceId);
            return (
              <button
                type="button"
                key={w.workspaceId}
                className={`attach-row ${isPicked ? "picked" : ""}`}
                onClick={() => toggle(w.workspaceId)}
                title={w.repoPath}
              >
                <span className={`attach-check ${isPicked ? "on" : ""}`} aria-hidden>
                  {isPicked ? "✓" : ""}
                </span>
                <span className="attach-row-name">{basename(w.repoPath)}</span>
              </button>
            );
          })
        )}
      </div>
      <div className="attach-popover-foot">
        <button type="button" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="primary" onClick={attach} disabled={busy || picked.size === 0}>
          {busy ? "Attaching…" : picked.size > 1 ? `Attach ${picked.size} repos` : "Attach repo"}
        </button>
      </div>
    </div>
  );
}

