import { agentAvatar } from "../lib/agents";
import { useAppearance } from "../lib/appearance";
import type { Channel } from "../types";

type Props = {
  channel: Channel;
  rightRailOpen: boolean;
  onToggleRail: () => void;
  onPromote: () => void;
};

/**
 * DMs are 1:1 kickoff surfaces with a single agent. Header shows the agent's
 * avatar + provider + live activity, a Promote-to-channel CTA, and a
 * paper-alt "kickoff surface" banner below — mirrors the Tidewater design.
 */
export function DmHeader({ channel, rightRailOpen, onToggleRail, onPromote }: Props) {
  const [appearance] = useAppearance();
  const agent = channel.members[0];
  const av = agent
    ? agentAvatar(agent.agentId, agent.displayName, appearance.avatarStyle)
    : agentAvatar(channel.name);
  const working = agent?.status === "working";

  return (
    <div className="dm-header-wrap">
      <div className="dm-header">
        <div
          className="dm-header-avatar"
          style={{ background: av.background, color: av.color }}
          aria-hidden
        >
          {av.glyph}
          {working && <span className="dm-header-status-dot" />}
        </div>
        <div className="dm-header-meta">
          <div className="dm-header-name">{agent?.displayName ?? channel.name}</div>
          <div className="dm-header-sub">
            {agent?.provider ?? "agent"}
            {agent && (
              <>
                {" · "}
                <span className={working ? "dm-header-working" : "dm-header-idle"}>
                  {working ? "⚙ working" : agent.status || "idle"}
                </span>
              </>
            )}
          </div>
        </div>
        <button className="dm-promote-btn" onClick={onPromote} type="button">
          # Promote to channel
        </button>
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
      <div className="dm-banner">
        <span className="dm-banner-spark" aria-hidden>
          ✦
        </span>
        <span>
          DMs are <strong>kickoff surfaces</strong> — your first request here can promote into a
          channel with attached repos. Try <code>/new</code> in the composer when work gets real.
        </span>
      </div>
    </div>
  );
}
