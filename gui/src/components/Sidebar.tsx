import type { Channel } from "../types";

type Props = {
  channels: Channel[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNewChannel: () => void;
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

export function Sidebar({ channels, selectedId, onSelect, onNewChannel }: Props) {
  const sorted = sortByActivity(channels);
  return (
    <div className="panel">
      <div className="panel-header">
        <span>Channels</span>
        <button onClick={onNewChannel} title="New channel">
          +
        </button>
      </div>
      <div className="list">
        {sorted.length === 0 && <div className="empty">No active channels</div>}
        {sorted.map((c) => (
          <div
            key={c.channelId}
            className={`list-item ${c.channelId === selectedId ? "active" : ""}`}
            onClick={() => onSelect(c.channelId)}
          >
            <div className="name">#{c.name}</div>
            <div className="meta">
              {c.members.length} agents · {c.repoAssignments.length} repos
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
