import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { confirmAction, notifyError } from "../lib/dialogs";
import type { Channel, Section } from "../types";

type Props = {
  channels: Channel[];
  selectedId: string | null;
  includeArchived: boolean;
  sessionCounts: Record<string, number>;
  runningStreams: number;
  onSelect: (id: string) => void;
  onNewChannel: (sectionId?: string | null) => void;
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
  const [dmsOpen, setDmsOpen] = useState(true);
  const [uncategorizedOpen, setUncategorizedOpen] = useState(true);
  const [sectionOpen, setSectionOpen] = useState<Record<string, boolean>>({});
  const [sections, setSections] = useState<Section[]>([]);
  const [workspaceCount, setWorkspaceCount] = useState<number>(0);

  useEffect(() => {
    api
      .listWorkspaces()
      .then((ws) => setWorkspaceCount(ws.length))
      .catch(() => setWorkspaceCount(0));
  }, []);

  const refreshSections = () =>
    api
      .listSections()
      .then(setSections)
      .catch(() => setSections([]));

  useEffect(() => {
    refreshSections();
  }, [channels]);

  const isSectionOpen = (id: string) => sectionOpen[id] !== false;
  const toggleSectionOpen = (id: string) =>
    setSectionOpen((prev) => ({ ...prev, [id]: !isSectionOpen(id) }));

  const newSection = async () => {
    const name = window.prompt("Section name");
    if (!name?.trim()) return;
    try {
      await api.createSection(name.trim());
      await refreshSections();
    } catch (err) {
      await notifyError(`Failed to create section: ${err}`);
    }
  };

  const renameSection = async (section: Section) => {
    const name = window.prompt("Rename section", section.name);
    if (!name?.trim() || name.trim() === section.name) return;
    try {
      await api.renameSection(section.sectionId, name.trim());
      await refreshSections();
    } catch (err) {
      await notifyError(`Rename failed: ${err}`);
    }
  };

  const decommissionSection = async (section: Section) => {
    const ok = await confirmAction(
      `Decommission "${section.name}"? Its channels will move to Uncategorized. You can restore it later.`,
      { title: "Decommission section" }
    );
    if (!ok) return;
    try {
      await api.decommissionSection(section.sectionId);
      await refreshSections();
      onRefresh();
    } catch (err) {
      await notifyError(`Decommission failed: ${err}`);
    }
  };

  const deleteSection = async (section: Section) => {
    const ok = await confirmAction(
      `Delete "${section.name}" permanently? Only works if no channel is still in this section.`,
      { title: "Delete section", kind: "warning" }
    );
    if (!ok) return;
    try {
      await api.deleteSection(section.sectionId);
      await refreshSections();
    } catch (err) {
      await notifyError(`Delete failed: ${err}`);
    }
  };

  const sorted = useMemo(() => sortByActivity(channels), [channels]);
  const isDm = (c: Channel) => c.kind === "dm";
  const starred = sorted.filter((c) => c.starred && c.status === "active" && !isDm(c));
  const active = sorted.filter((c) => !c.starred && c.status === "active" && !isDm(c));
  const dms = sorted.filter((c) => c.status === "active" && isDm(c));
  const archived = sorted.filter((c) => c.status === "archived");

  // Bucket active channels by section. Channels whose sectionId doesn't
  // resolve to an active section land in Uncategorized — matches the
  // Rust-side migration + decommission behavior.
  const activeSectionIds = new Set(sections.map((s) => s.sectionId));
  const grouped = new Map<string, Channel[]>();
  const uncategorized: Channel[] = [];
  for (const c of active) {
    if (c.sectionId && activeSectionIds.has(c.sectionId)) {
      const arr = grouped.get(c.sectionId) ?? [];
      arr.push(c);
      grouped.set(c.sectionId, arr);
    } else {
      uncategorized.push(c);
    }
  }

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

        {sections.map((s) => {
          const members = grouped.get(s.sectionId) ?? [];
          return (
            <SidebarSection
              key={s.sectionId}
              title={s.name}
              count={members.length}
              collapsed={!isSectionOpen(s.sectionId)}
              onToggle={() => toggleSectionOpen(s.sectionId)}
              onAdd={() => onNewChannel(s.sectionId)}
              addTitle={`New channel in ${s.name}`}
              menu={{
                onRename: () => renameSection(s),
                onDecommission: () => decommissionSection(s),
                onDelete: members.length === 0 ? () => deleteSection(s) : undefined,
                deleteDisabledHint:
                  members.length > 0 ? "Move channels out first" : undefined,
              }}
            >
              {members.length === 0 && (
                <div className="sidebar-empty">No channels — press + to add one</div>
              )}
              {members.map((c) => (
                <ChannelRow
                  key={c.channelId}
                  channel={c}
                  active={c.channelId === selectedId}
                  onSelect={() => onSelect(c.channelId)}
                  onStarToggle={() => toggleStar(c)}
                />
              ))}
            </SidebarSection>
          );
        })}

        <SidebarSection
          title={sections.length === 0 ? "Channels" : "Uncategorized"}
          count={uncategorized.length}
          collapsed={!uncategorizedOpen}
          onToggle={() => setUncategorizedOpen((v) => !v)}
          onAdd={() => onNewChannel(null)}
          addTitle="New channel"
          onHeaderPlus={sections.length === 0 ? newSection : undefined}
          headerPlusTitle="New section"
        >
          {uncategorized.length === 0 && sections.length === 0 && (
            <div className="sidebar-empty">No active channels</div>
          )}
          {uncategorized.map((c) => (
            <ChannelRow
              key={c.channelId}
              channel={c}
              active={c.channelId === selectedId}
              onSelect={() => onSelect(c.channelId)}
              onStarToggle={() => toggleStar(c)}
            />
          ))}
        </SidebarSection>

        {sections.length > 0 && (
          <button type="button" className="sidebar-new-section" onClick={newSection}>
            + New section
          </button>
        )}

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
  onHeaderPlus,
  headerPlusTitle,
  menu,
  children,
}: {
  title: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  onAdd?: () => void;
  addTitle?: string;
  /** Extra `+` rendered alongside the section name — used for "New section"
   * on the first uncategorized bucket when no real sections exist yet. */
  onHeaderPlus?: () => void;
  headerPlusTitle?: string;
  menu?: {
    onRename?: () => void;
    onDecommission?: () => void;
    onDelete?: () => void;
    deleteDisabledHint?: string;
  };
  children: React.ReactNode;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [menuOpen]);
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
        {onHeaderPlus && (
          <button
            className="section-add"
            onClick={(e) => {
              e.stopPropagation();
              onHeaderPlus();
            }}
            title={headerPlusTitle}
            aria-label={headerPlusTitle}
          >
            +
          </button>
        )}
        {menu && (
          <div className="section-menu-wrap" onClick={(e) => e.stopPropagation()}>
            <button
              className="section-add"
              onClick={() => setMenuOpen((v) => !v)}
              title="Section actions"
              aria-label="Section actions"
            >
              ⋯
            </button>
            {menuOpen && (
              <div className="section-menu">
                {menu.onRename && (
                  <button onClick={menu.onRename}>Rename</button>
                )}
                {menu.onDecommission && (
                  <button onClick={menu.onDecommission}>Decommission</button>
                )}
                <button
                  onClick={menu.onDelete}
                  disabled={!menu.onDelete}
                  className="danger"
                  title={menu.deleteDisabledHint}
                >
                  Delete
                  {menu.deleteDisabledHint && !menu.onDelete && (
                    <span className="menu-hint"> · {menu.deleteDisabledHint}</span>
                  )}
                </button>
              </div>
            )}
          </div>
        )}
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
  const initials =
    (agent?.displayName ?? channel.name).slice(0, 2).toUpperCase() ||
    channel.name.slice(0, 2).toUpperCase();
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
