import type { Channel } from "../types";

type Props = {
  channels: Channel[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNewChannel: () => void;
};

export function Sidebar({ channels, selectedId, onSelect, onNewChannel }: Props) {
  return (
    <div className="panel">
      <div className="panel-header">
        <span>Channels</span>
        <button onClick={onNewChannel} title="New channel">
          +
        </button>
      </div>
      <div className="list">
        {channels.length === 0 && <div className="empty">No active channels</div>}
        {channels.map((c) => (
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
