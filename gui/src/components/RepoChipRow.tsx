import { useEffect, useRef, useState } from "react";
import { api } from "../api";
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
      alert(`Promote failed: ${err}`);
    }
  };

  const detach = async (workspaceId: string) => {
    const remaining = channel.repoAssignments.filter((r) => r.workspaceId !== workspaceId);
    try {
      await api.updateChannelRepos(
        channel.channelId,
        remaining.map((r) => ({
          alias: r.alias,
          workspaceId: r.workspaceId,
          repoPath: r.repoPath,
        }))
      );
      onChanged();
      setOpenChipId(null);
    } catch (err) {
      alert(`Detach failed: ${err}`);
    }
  };

  const spawnInTerminal = async (alias: string, repoPath: string) => {
    try {
      await api.spawnAgent(channel.channelId, alias, repoPath);
      setOpenChipId(null);
    } catch (err) {
      alert(`Spawn failed: ${err}`);
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
                <div
                  className="popover-item"
                  onClick={() => spawnInTerminal(r.alias, r.repoPath)}
                >
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

  useEffect(() => {
    api.listWorkspaces().then(setWorkspaces).catch(() => setWorkspaces([]));
  }, []);

  const attachedIds = new Set(channel.repoAssignments.map((r) => r.workspaceId));
  const available = workspaces.filter((w) => !attachedIds.has(w.workspaceId));

  const attach = async (w: WorkspaceEntry) => {
    if (busy) return;
    setBusy(true);
    const alias = basename(w.repoPath).replace(/[^a-z0-9-]/gi, "").toLowerCase().slice(0, 12);
    const next = [
      ...channel.repoAssignments.map((r) => ({
        alias: r.alias,
        workspaceId: r.workspaceId,
        repoPath: r.repoPath,
      })),
      { alias, workspaceId: w.workspaceId, repoPath: w.repoPath },
    ];
    try {
      await api.updateChannelRepos(channel.channelId, next);
      onAttached();
    } catch (err) {
      alert(`Attach failed: ${err}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="popover" style={{ top: "calc(100% + 4px)", right: 0 }}>
      <div className="popover-header">Attach repo</div>
      {available.length === 0 ? (
        <div className="popover-item disabled" onClick={onClose}>
          No unattached workspaces
        </div>
      ) : (
        available.map((w) => (
          <div key={w.workspaceId} className="popover-item" onClick={() => attach(w)}>
            <span>{basename(w.repoPath)}</span>
            <span className="item-sub">{w.repoPath}</span>
          </div>
        ))
      )}
    </div>
  );
}

function basename(p: string): string {
  return p.split("/").filter(Boolean).pop() ?? p;
}
