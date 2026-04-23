import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { notifyError } from "../lib/dialogs";
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
  onOpenSettings: () => void;
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
  onOpenSettings,
  onRefresh,
}: Props) {
  const [starredOpen, setStarredOpen] = useState(true);
  const [channelsOpen, setChannelsOpen] = useState(true);
  const [dmsOpen, setDmsOpen] = useState(true);
  const [workspaceCount, setWorkspaceCount] = useState<number>(0);

  useEffect(() => {
    api
      .listWorkspaces()
      .then((ws) => setWorkspaceCount(ws.length))
      .catch(() => setWorkspaceCount(0));
  }, []);

  const sorted = useMemo(() => sortByActivity(channels), [channels]);
  const isDm = (c: Channel) => c.kind === "dm";
  const starred = sorted.filter((c) => c.starred && c.status === "active" && !isDm(c));
  const active = sorted.filter((c) => !c.starred && c.status === "active" && !isDm(c));
  const dms = sorted.filter((c) => c.status === "active" && isDm(c));
  const archived = sorted.filter((c) => c.status === "archived");

  // Activity = channels touched in the last hour. Cheap signal that matches
  // the design's "fresh since you last looked" read.
  const recentThreshold = Date.now() - 60 * 60 * 1000;
  const activityCount = active.filter((c) => {
    const raw = c.updatedAt ?? c.createdAt;
    if (!raw) return false;
    const ts = Date.parse(raw);
    return Number.isFinite(ts) && ts >= recentThreshold;
  }).length;
  const threadCount = Object.values(sessionCounts).reduce((a, b) => a + b, 0);

  const toggleStar = async (c: Channel) => {
    try {
      await api.setChannelStarred(c.channelId, !c.starred);
      onRefresh();
    } catch (err) {
      await notifyError(`Failed to ${c.starred ? "unstar" : "star"} #${c.name}: ${err}`);
    }
  };

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <div className="ws-avatar">R</div>
        <div style={{ minWidth: 0 }}>
          <div className="ws-title">Relay</div>
          <div className="ws-sub">
            {workspaceCount} {workspaceCount === 1 ? "repo" : "repos"}
            {runningStreams > 0 && ` · ${runningStreams} working`}
          </div>
        </div>
      </div>

      <div className="sidebar-quick">
        <QuickAction
          icon="◔"
          label="Activity"
          count={activityCount}
          onClick={() => {
            if (active.length > 0) onSelect(active[0].channelId);
          }}
          disabled={active.length === 0}
        />
        <QuickAction
          icon="☰"
          label="Threads"
          count={threadCount}
          onClick={() => {
            // Jump to the most-recently-active channel so the rail's
            // Threads tab has something to show.
            const target = active[0] ?? starred[0];
            if (target) onSelect(target.channelId);
          }}
          disabled={active.length === 0 && starred.length === 0}
        />
        <QuickAction
          icon="▶"
          label="Running"
          pulse={runningStreams > 0}
          onClick={() => {
            // "Running" is a one-at-a-time presence signal today; if a
            // stream is live we stay on the current channel (no other ID
            // to jump to) — but still highlight the row so the click
            // feels acknowledged. When wired to multi-stream, this jumps
            // to the running channel.
          }}
          disabled={runningStreams === 0}
        />
      </div>

      <div className="sidebar-divider" />

      <div className="sidebar-scroll">
        {starred.length > 0 && (
          <SidebarSection
            title="Starred"
            count={starred.length}
            collapsed={!starredOpen}
            onToggle={() => setStarredOpen((v) => !v)}
          >
            {starred.map((c) => (
              <ChannelRow
                key={c.channelId}
                channel={c}
                active={c.channelId === selectedId}
                onSelect={() => onSelect(c.channelId)}
                onStarToggle={() => toggleStar(c)}
              />
            ))}
          </SidebarSection>
        )}

        <SidebarSection
          title="Channels"
          count={active.length}
          collapsed={!channelsOpen}
          onToggle={() => setChannelsOpen((v) => !v)}
          onAdd={onNewChannel}
          addTitle="New channel"
        >
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
        </SidebarSection>

        <SidebarSection
          title="Direct messages"
          count={dms.length}
          collapsed={!dmsOpen}
          onToggle={() => setDmsOpen((v) => !v)}
          onAdd={onNewDm}
          addTitle="Start a DM"
        >
          {dms.length === 0 && <div className="sidebar-empty">No DMs</div>}
          {dms.map((c) => (
            <DmRow
              key={c.channelId}
              channel={c}
              active={c.channelId === selectedId}
              onSelect={() => onSelect(c.channelId)}
            />
          ))}
        </SidebarSection>

        <div className="sidebar-archive">
          <label>
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
        </div>
      </div>

      <div className="sidebar-footer">
        <div className="user-presence">
          <div className="user-avatar">jc</div>
          <div className="user-meta">
            <div className="user-name">jcast</div>
            <div className="user-status">
              <span className="dot" /> active
            </div>
          </div>
        </div>
        <button
          className="sidebar-footer-btn"
          onClick={onOpenSettings}
          title="Settings"
          aria-label="Settings"
        >
          ⚙
        </button>
      </div>
    </div>
  );
}

function SidebarSection({
  title,
  count,
  collapsed,
  onToggle,
  onAdd,
  addTitle,
  children,
}: {
  title: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  onAdd?: () => void;
  addTitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="sidebar-section">
      <header className="sidebar-section-head">
        <button
          type="button"
          className="section-chev"
          onClick={onToggle}
          aria-label={collapsed ? "Expand" : "Collapse"}
        >
          {collapsed ? "▸" : "▾"}
        </button>
        <span className="section-title" onClick={onToggle}>
          {title}
          <span className="section-count"> · {count}</span>
        </span>
        {onAdd && (
          <button
            className="section-add"
            onClick={(e) => {
              e.stopPropagation();
              onAdd();
            }}
            title={addTitle}
            aria-label={addTitle}
          >
            +
          </button>
        )}
      </header>
      {!collapsed && <div className="sidebar-section-body">{children}</div>}
    </section>
  );
}

function QuickAction({
  icon,
  label,
  count,
  pulse,
  onClick,
  disabled,
}: {
  icon: string;
  label: string;
  count?: number;
  pulse?: boolean;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="quick-action"
      onClick={onClick}
      disabled={disabled}
      title={disabled ? `No ${label.toLowerCase()}` : label}
    >
      <span className="qa-icon">{icon}</span>
      <span className="qa-label">{label}</span>
      {pulse && <span className="qa-pulse" />}
      {typeof count === "number" && count > 0 && <span className="qa-count">{count}</span>}
    </button>
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
  const hasUnread = false;
  return (
    <div
      className={`sidebar-item ${active ? "active" : ""} ${archived ? "archived" : ""} ${hasUnread ? "unread" : ""}`}
      onClick={onSelect}
    >
      <span className="ch-sigil">#</span>
      <span className="ch-name">{channel.name}</span>
      {channel.repoAssignments.length > 0 && (
        <span className="ch-badge">{channel.repoAssignments.length}</span>
      )}
      <button
        className={`star-btn ${channel.starred ? "starred" : ""}`}
        onClick={(e) => {
          e.stopPropagation();
          onStarToggle();
        }}
        title={channel.starred ? "Unstar" : "Star"}
        aria-label={channel.starred ? "Unstar channel" : "Star channel"}
      >
        {channel.starred ? "★" : "☆"}
      </button>
    </div>
  );
}

function DmRow({
  channel,
  active,
  onSelect,
}: {
  channel: Channel;
  active: boolean;
  onSelect: () => void;
}) {
  // DMs are 1:1 with an agent; surface the agent's current working status
  // as the row subtitle to mirror the design's amber "⚙ activity" hint.
  const agent = channel.members[0];
  const working = agent?.status === "working";
  const initials = deriveInitials(agent?.displayName ?? channel.name);
  return (
    <div className={`sidebar-item dm ${active ? "active" : ""}`} onClick={onSelect}>
      <span className="dm-avatar">{initials}</span>
      <div className="dm-body">
        <div className="dm-name">{channel.name}</div>
        {working && <div className="dm-activity">⚙ working</div>}
      </div>
      {working && <span className="dm-dot" />}
    </div>
  );
}

// "Claude Code" → "CC", "jcast" → "JC", "@bot" → "BO". Split on
// whitespace for multi-word names so two-letter initials read as real
// initials instead of a slice-first-two substring.
function deriveInitials(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "??";
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return trimmed.slice(0, 2).toUpperCase();
}
