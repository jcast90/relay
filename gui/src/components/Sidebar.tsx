import { useState } from "react";
import { api } from "../api";
import type { Channel } from "../types";

type Props = {
  channels: Channel[];
  selectedId: string | null;
  includeArchived: boolean;
  onSelect: (id: string) => void;
  onNewChannel: () => void;
  onToggleIncludeArchived: (next: boolean) => void;
  onArchived: (id: string) => void;
  onRefresh: () => void;
};

/**
 * Sort by most-recent activity (updatedAt desc) so the channel you're
 * actively working in — or last worked in — stays at the top. Falls back to
 * createdAt, then name. Channels missing both timestamps sink to the bottom.
 * Pure, safe to call every render.
 */
function sortByActivity(channels: Channel[]): Channel[] {
  const activityTs = (c: Channel): number => {
    const raw = c.updatedAt ?? c.createdAt;
    if (!raw) return 0;
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return [...channels].sort((a, b) => {
    const diff = activityTs(b) - activityTs(a);
    if (diff !== 0) return diff;
    return a.name.localeCompare(b.name);
  });
}

export function Sidebar({
  channels,
  selectedId,
  includeArchived,
  onSelect,
  onNewChannel,
  onToggleIncludeArchived,
  onArchived,
  onRefresh,
}: Props) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const sorted = sortByActivity(channels);

  const handleArchive = async (c: Channel) => {
    if (busyId) return;
    const label = c.status === "archived" ? "Unarchive" : "Archive";
    if (!confirm(`${label} #${c.name}?`)) return;
    setBusyId(c.channelId);
    try {
      if (c.status === "archived") {
        await api.unarchiveChannel(c.channelId);
      } else {
        await api.archiveChannel(c.channelId);
        // Intentionally only on archive — unarchive never needs to drop the
        // selection since the row stays visible (either under the
        // "Show archived" toggle or after it becomes active again).
        onArchived(c.channelId);
      }
      onRefresh();
    } catch (err) {
      alert(`${label} failed: ${err}`);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="panel">
      <div className="panel-header">
        <span>Channels</span>
        <button onClick={onNewChannel} title="New channel">
          +
        </button>
      </div>
      <label className="sidebar-toggle">
        <input
          type="checkbox"
          checked={includeArchived}
          onChange={(e) => onToggleIncludeArchived(e.target.checked)}
        />
        Show archived
      </label>
      <div className="list">
        {sorted.length === 0 && (
          <div className="empty">{includeArchived ? "No channels" : "No active channels"}</div>
        )}
        {sorted.map((c) => {
          const archived = c.status === "archived";
          return (
            <div
              key={c.channelId}
              className={`list-item ${c.channelId === selectedId ? "active" : ""} ${
                archived ? "archived" : ""
              }`}
              onClick={() => onSelect(c.channelId)}
            >
              <div className="list-item-row">
                <div className="list-item-body">
                  <div className="name">
                    #{c.name}
                    {archived && <span className="archived-badge">archived</span>}
                  </div>
                  <div className="meta">
                    {c.members.length} agents · {c.repoAssignments.length} repos
                  </div>
                </div>
                <button
                  type="button"
                  className="channel-archive-btn"
                  title={archived ? "Unarchive channel" : "Archive channel"}
                  disabled={busyId === c.channelId}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleArchive(c);
                  }}
                >
                  {archived ? "↺" : "✕"}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
