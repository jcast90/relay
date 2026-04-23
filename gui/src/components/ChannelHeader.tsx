import { api } from "../api";
import { agentAvatar } from "../lib/agents";
import { useAppearance } from "../lib/appearance";
import type { Channel, ChannelTier } from "../types";
import { RepoChipRow } from "./RepoChipRow";

export type ChannelTab = "chat" | "board" | "decisions";

type Props = {
  channel: Channel;
  tab: ChannelTab;
  onTabChange: (t: ChannelTab) => void;
  rightRailOpen: boolean;
  onToggleRail: () => void;
  onOpenSettings: () => void;
  onRefresh: () => void;
  hideTabs?: boolean;
  tabCounts?: { board: number; decisions: number };
};

const TIER_LABELS: Record<ChannelTier, string> = {
  feature_large: "feature+",
  feature: "feature",
  bugfix: "bugfix",
  chore: "chore",
  question: "question",
};

export function ChannelHeader({
  channel,
  tab,
  onTabChange,
  rightRailOpen,
  onToggleRail,
  onOpenSettings,
  onRefresh,
  hideTabs,
  tabCounts,
}: Props) {
  const isDm = channel.kind === "dm";
  const [appearance] = useAppearance();
  const toggleStar = async () => {
    try {
      await api.setChannelStarred(channel.channelId, !channel.starred);
      onRefresh();
    } catch (err) {
      console.warn("[star] failed:", err);
    }
  };

  const tabs: { id: ChannelTab; label: string; count?: number }[] = [
    { id: "chat", label: "Chat" },
    { id: "board", label: "Board", count: tabCounts?.board },
    { id: "decisions", label: "Decisions", count: tabCounts?.decisions },
  ];

  return (
    <div className="channel-header">
      <div className="channel-header-row1">
        <div className="channel-header-name">
          <span className="sigil">{isDm ? "✉" : "#"}</span>
          <span>{channel.name}</span>
          {channel.tier && (
            <span className={`channel-header-tier tier-${channel.tier}`}>
              {TIER_LABELS[channel.tier]}
            </span>
          )}
          <button
            className={`channel-header-star ${channel.starred ? "starred" : ""}`}
            onClick={toggleStar}
            title={channel.starred ? "Unstar" : "Star"}
          >
            {channel.starred ? "★" : "☆"}
          </button>
        </div>
        {channel.description && (
          <>
            <span className="channel-header-divider" />
            <div className="channel-header-topic">{channel.description}</div>
          </>
        )}
        <div className="agent-stack">
          {channel.members.slice(0, 4).map((m) => {
            const av = agentAvatar(m.agentId, m.displayName, appearance.avatarStyle);
            return (
              <span
                key={m.agentId}
                className="agent-avatar"
                style={{ background: av.background, color: av.color }}
                title={`${m.displayName} · ${m.provider}`}
              >
                {av.glyph}
              </span>
            );
          })}
          {channel.members.length > 4 && (
            <span className="agent-avatar agent-overflow">+{channel.members.length - 4}</span>
          )}
        </div>
        <button
          className={`rail-toggle ${rightRailOpen ? "active" : ""}`}
          onClick={onToggleRail}
          title="Toggle right rail"
          aria-label="Toggle right rail"
          aria-pressed={rightRailOpen}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
            <rect
              x="2"
              y="3"
              width="10"
              height="8"
              rx="1"
              stroke="currentColor"
              strokeWidth="1.3"
            />
            <path d="M9 3v8" stroke="currentColor" strokeWidth="1.3" />
          </svg>
        </button>
      </div>
      {!hideTabs && (
        <div className="channel-header-row2">
          <div className="channel-tabs">
            {tabs.map((t) => (
              <button
                type="button"
                key={t.id}
                className={`channel-tab ${tab === t.id ? "active" : ""}`}
                onClick={() => onTabChange(t.id)}
              >
                {t.label}
                {typeof t.count === "number" && t.count > 0 && (
                  <span className="tab-count">{t.count}</span>
                )}
              </button>
            ))}
          </div>
          <div className="row2-right">
            <RepoChipRow channel={channel} onChanged={onRefresh} />
            <button className="gear-btn" onClick={onOpenSettings} title="Channel settings">
              ⚙
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
