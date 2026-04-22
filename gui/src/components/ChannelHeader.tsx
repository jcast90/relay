import { api } from "../api";
import { agentAvatar } from "../lib/agents";
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
}: Props) {
  const isDm = channel.kind === "dm";
  const toggleStar = async () => {
    try {
      await api.setChannelStarred(channel.channelId, !channel.starred);
      onRefresh();
    } catch (err) {
      console.warn("[star] failed:", err);
    }
  };

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
        </div>
        <button
          className={`channel-header-star ${channel.starred ? "starred" : ""}`}
          onClick={toggleStar}
          title={channel.starred ? "Unstar" : "Star"}
        >
          {channel.starred ? "★" : "☆"}
        </button>
        {channel.description && <div className="channel-header-topic">{channel.description}</div>}
        <div className="agent-stack">
          {channel.members.slice(0, 4).map((m) => {
            const av = agentAvatar(m.agentId, m.displayName);
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
        </div>
        <button className="rail-toggle" onClick={onToggleRail} title="Toggle right rail">
          {rightRailOpen ? "⋮›" : "‹⋮"}
        </button>
      </div>
      {!hideTabs && (
        <div className="channel-header-row2">
          <div className="channel-tabs">
            {(["chat", "board", "decisions"] as ChannelTab[]).map((t) => (
              <div
                key={t}
                className={`channel-tab ${tab === t ? "active" : ""}`}
                onClick={() => onTabChange(t)}
              >
                {t === "chat" ? "Chat" : t === "board" ? "Board" : "Decisions"}
              </div>
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
