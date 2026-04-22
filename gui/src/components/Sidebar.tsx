import { useMemo, useState } from "react";
import { api } from "../api";
import type { Channel } from "../types";

type Props = {
  channels: Channel[];
  selectedId: string | null;
  includeArchived: boolean;
  sessionCounts: Record<string, number>;
  runningStreams: number;
  onSelect: (id: string) => void;
  onNewChannel: () => void;
  onNewDm: () => void;
  onToggleIncludeArchived: (next: boolean) => void;
  onRefresh: () => void;
};

function sortByActivity(channels: Channel[]): Channel[] {
  const ts = (c: Channel): number => {
    const raw = c.updatedAt ?? c.createdAt;
    const parsed = raw ? Date.parse(raw) : NaN;
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return [...channels].sort((a, b) => {
    const diff = ts(b) - ts(a);
    if (diff !== 0) return diff;
    return a.name.localeCompare(b.name);
  });
}

export function Sidebar({
  channels,
  selectedId,
  includeArchived,
  sessionCounts,
  runningStreams,
  onSelect,
  onNewChannel,
  onNewDm,
  onToggleIncludeArchived,
  onRefresh,
}: Props) {
  const [starredOpen, setStarredOpen] = useState(true);
  const [channelsOpen, setChannelsOpen] = useState(true);
  const [dmsOpen, setDmsOpen] = useState(true);

  const sorted = useMemo(() => sortByActivity(channels), [channels]);
  const isDm = (c: Channel) => c.kind === "dm";
  const starred = sorted.filter((c) => c.starred && c.status === "active" && !isDm(c));
  const active = sorted.filter((c) => !c.starred && c.status === "active" && !isDm(c));
  const dms = sorted.filter((c) => c.status === "active" && isDm(c));
  const archived = sorted.filter((c) => c.status === "archived");

  const toggleStar = async (c: Channel) => {
    try {
      await api.setChannelStarred(c.channelId, !c.starred);
      onRefresh();
    } catch (err) {
      alert(`Failed to ${c.starred ? "unstar" : "star"} #${c.name}: ${err}`);
    }
  };

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <div className="ws-avatar">R</div>
        <div>
          <div className="ws-title">Relay</div>
          <div className="ws-sub">local workspace</div>
        </div>
      </div>

      <div className="sidebar-scroll">
        <ActivityBlock
          channels={active}
          sessionCounts={sessionCounts}
          runningStreams={runningStreams}
        />

        <section className="sidebar-section">
          <header
            className="sidebar-section-head"
            onClick={() => setStarredOpen((v) => !v)}
            role="button"
          >
            <span>★ Starred</span>
            <span className="count">{starred.length}</span>
          </header>
          {starredOpen && (
            <div>
              {starred.length === 0 && <div className="sidebar-empty">No starred channels</div>}
              {starred.map((c) => (
                <ChannelRow
                  key={c.channelId}
                  channel={c}
                  active={c.channelId === selectedId}
                  onSelect={() => onSelect(c.channelId)}
                  onStarToggle={() => toggleStar(c)}
                />
              ))}
            </div>
          )}
        </section>

        <section className="sidebar-section">
          <header
            className="sidebar-section-head"
            onClick={() => setChannelsOpen((v) => !v)}
            role="button"
          >
            <span># Channels</span>
            <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
              <span className="count">{active.length}</span>
              <button
                className="add-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  onNewChannel();
                }}
                title="New channel"
              >
                +
              </button>
            </span>
          </header>
          {channelsOpen && (
            <div>
              {active.length === 0 && <div className="sidebar-empty">No active channels</div>}
              {active.map((c) => (
                <ChannelRow
                  key={c.channelId}
                  channel={c}
                  active={c.channelId === selectedId}
                  onSelect={() => onSelect(c.channelId)}
                  onStarToggle={() => toggleStar(c)}
                />
              ))}
            </div>
          )}
        </section>

        <section className="sidebar-section">
          <header
            className="sidebar-section-head"
            onClick={() => setDmsOpen((v) => !v)}
            role="button"
          >
            <span>✉ Direct messages</span>
            <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
              <span className="count">{dms.length}</span>
              <button
                className="add-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  onNewDm();
                }}
                title="Start a DM"
              >
                +
              </button>
            </span>
          </header>
          {dmsOpen && (
            <div>
              {dms.length === 0 && <div className="sidebar-empty">No DMs</div>}
              {dms.map((c) => (
                <div
                  key={c.channelId}
                  className={`sidebar-item ${c.channelId === selectedId ? "active" : ""}`}
                  onClick={() => onSelect(c.channelId)}
                >
                  <span className="ch-sigil">✉</span>
                  <span className="ch-name">{c.name}</span>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="sidebar-section">
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "6px 12px",
              color: "var(--color-text-on-dark-muted)",
              fontSize: "var(--font-size-xs)",
              cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={(e) => onToggleIncludeArchived(e.target.checked)}
            />
            Show archived
          </label>
          {includeArchived &&
            archived.map((c) => (
              <ChannelRow
                key={c.channelId}
                channel={c}
                active={c.channelId === selectedId}
                onSelect={() => onSelect(c.channelId)}
                onStarToggle={() => toggleStar(c)}
                archived
              />
            ))}
        </section>
      </div>
    </div>
  );
}

function ChannelRow({
  channel,
  active,
  onSelect,
  onStarToggle,
  archived,
}: {
  channel: Channel;
  active: boolean;
  onSelect: () => void;
  onStarToggle: () => void;
  archived?: boolean;
}) {
  return (
    <div
      className={`sidebar-item ${active ? "active" : ""} ${archived ? "archived" : ""}`}
      onClick={onSelect}
    >
      <span className="ch-sigil">#</span>
      <span className="ch-name">{channel.name}</span>
      {channel.repoAssignments.length > 0 && (
        <span className="ch-badge">{channel.repoAssignments.length}</span>
      )}
      <button
        className="add-btn"
        style={{ color: channel.starred ? "var(--color-accent-amber)" : undefined }}
        onClick={(e) => {
          e.stopPropagation();
          onStarToggle();
        }}
        title={channel.starred ? "Unstar" : "Star"}
      >
        {channel.starred ? "★" : "☆"}
      </button>
    </div>
  );
}

function ActivityBlock({
  channels,
  sessionCounts,
  runningStreams,
}: {
  channels: Channel[];
  sessionCounts: Record<string, number>;
  runningStreams: number;
}) {
  // Activity = channels updated in the last hour.
  // Threads = total sessions across all channels (from list_session_counts).
  // Running = count of active chat streams (pushed up from CenterPane).
  const recentThreshold = Date.now() - 60 * 60 * 1000;
  const activeCount = channels.filter((c) => {
    const raw = c.updatedAt ?? c.createdAt;
    if (!raw) return false;
    const ts = Date.parse(raw);
    return Number.isFinite(ts) && ts >= recentThreshold;
  }).length;
  const threadCount = Object.values(sessionCounts).reduce((a, b) => a + b, 0);
  return (
    <section className="sidebar-section">
      <NavRow label="Activity" sigil="◔" count={activeCount} />
      <NavRow label="Threads" sigil="☰" count={threadCount} />
      <RunningRow active={runningStreams > 0} />
    </section>
  );
}

function NavRow({ label, sigil, count }: { label: string; sigil: string; count: number }) {
  return (
    <div className="sidebar-item" style={{ cursor: "default", opacity: count > 0 ? 1 : 0.6 }}>
      <span className="ch-sigil">{sigil}</span>
      <span className="ch-name">{label}</span>
      {count > 0 && <span className="ch-badge">{count}</span>}
    </div>
  );
}

// Running is a presence signal, not a counter — the shell only ever has
// one center pane, so "N streams" would cap at 1 and read as noise. Pulse
// dot when a stream is live; dim when idle.
function RunningRow({ active }: { active: boolean }) {
  return (
    <div className="sidebar-item" style={{ cursor: "default", opacity: active ? 1 : 0.6 }}>
      <span className="ch-sigil">▶</span>
      <span className="ch-name">Running</span>
      {active && (
        <span
          aria-label="agent streaming"
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: "var(--color-accent-amber)",
            animation: "var(--anim-pulse)",
            display: "inline-block",
          }}
        />
      )}
    </div>
  );
}
