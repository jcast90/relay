/* Direction A — Main app: activity view, DM view, channel view, orchestration */

const { A, I, Avatar, WorkspaceRail } = window.RELAY_A;
const { Sidebar } = window.RELAY_A_SIDEBAR;
const { ChannelHeader, PinnedCanvas } = window.RELAY_A_HEADER;
const { MessageList, Composer } = window.RELAY_A_CHAT;
const { DecisionsDrawer, PrThread, ApprovalThread, TicketDetail } = window.RELAY_A_RIGHT;
// ─────────────────────────────────────────────────────────────
// Activity view — center when "Activity" is selected
// ─────────────────────────────────────────────────────────────
function ActivityView({ onGoTo }) {
  const grouped = {
    approvals: ACTIVITY.filter((a) => a.kind === 'approval'),
    ci:        ACTIVITY.filter((a) => a.kind === 'ci_fail' || a.kind === 'ticket_fail'),
    reviews:   ACTIVITY.filter((a) => a.kind === 'pr_review'),
    mentions:  ACTIVITY.filter((a) => a.kind === 'mention'),
  };
  return (
    <div style={{ flex: 1, overflowY: 'auto', background: A.paper }}>
      <div style={{ padding: '18px 28px 8px' }}>
        <div style={{ fontSize: 20, fontWeight: 700, color: A.text, display: 'flex', alignItems: 'center', gap: 10 }}>
          <I.bell style={{ color: A.coral }} /> Activity
        </div>
        <div style={{ fontSize: 13, color: A.textMuted, marginTop: 2 }}>
          Plan approvals, CI failures, PR reviews, and @mentions — across every channel
        </div>
      </div>
      <ActivityGroup title="Needs approval" items={grouped.approvals} accent={A.coral} onGoTo={onGoTo} />
      <ActivityGroup title="CI failing · ticket failed" items={grouped.ci} accent={A.coral} onGoTo={onGoTo} />
      <ActivityGroup title="Reviews" items={grouped.reviews} accent={A.amber} onGoTo={onGoTo} />
      <ActivityGroup title="Mentions" items={grouped.mentions} accent={A.sky} onGoTo={onGoTo} />
    </div>
  );
}

function ActivityGroup({ title, items, accent, onGoTo }) {
  if (!items.length) return null;
  return (
    <div style={{ padding: '12px 28px' }}>
      <div style={{
        fontSize: 11, fontWeight: 700, color: A.textMuted,
        letterSpacing: '0.04em', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: accent }} />
        {title.toUpperCase()} · {items.length}
      </div>
      {items.map((a) => {
        const agent = AGENTS.find((x) => x.id === a.agent);
        return (
          <div key={a.id} onClick={() => onGoTo(a)} style={{
            display: 'flex', gap: 12, alignItems: 'flex-start',
            padding: '12px 14px', marginBottom: 6,
            background: A.paper, border: `1px solid ${A.paperLine}`,
            borderRadius: 8, cursor: 'pointer', transition: 'all 0.12s',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.borderColor = accent; e.currentTarget.style.background = A.paperAlt; }}
          onMouseLeave={(e) => { e.currentTarget.style.borderColor = A.paperLine; e.currentTarget.style.background = A.paper; }}
          >
            {agent && <Avatar agent={agent} size={32} />}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13.5, fontWeight: 600, color: A.text }}>{a.title}</div>
              <div style={{ fontSize: 12.5, color: A.textMuted, marginTop: 2 }}>{a.detail}</div>
              <div style={{ fontSize: 11, color: A.textDim, marginTop: 4, display: 'flex', gap: 8 }}>
                <span>#{a.channel}</span><span>·</span><span>{a.time} ago</span>
              </div>
            </div>
            <button style={{
              padding: '5px 10px', borderRadius: 5, fontSize: 11.5, fontWeight: 600,
              background: accent, color: '#fff', border: 'none', cursor: 'pointer',
              flexShrink: 0,
            }}>Go to</button>
          </div>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// DM view
// ─────────────────────────────────────────────────────────────
function DmView({ dm, agent, avatarStyle, onPromote }) {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, background: A.paper }}>
      <div style={{
        padding: '12px 20px', borderBottom: `1px solid ${A.paperLine}`,
        display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0,
      }}>
        <Avatar agent={agent} size={36} style={avatarStyle} showStatus />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: A.text }}>{agent.name}</div>
          <div style={{ fontSize: 12, color: A.textMuted }}>
            {agent.provider} · {agent.status === 'working' ? (
              <span style={{ color: A.amber }}>⚙ {agent.activity || 'working'}</span>
            ) : (
              <span>{agent.status}</span>
            )}
          </div>
        </div>
        <button onClick={onPromote} style={{
          padding: '7px 12px', borderRadius: 6,
          background: A.coral, color: '#fff', border: 'none',
          fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
          display: 'flex', alignItems: 'center', gap: 6,
        }}><I.hash /> Promote to channel</button>
      </div>

      <div style={{
        padding: '8px 20px', background: A.paperAlt,
        borderBottom: `1px solid ${A.paperLine}`,
        fontSize: 12, color: A.textMuted, display: 'flex', gap: 10, alignItems: 'center',
      }}>
        <I.spark style={{ color: A.coral }} />
        <span>
          DMs are <strong style={{ color: A.text }}>kickoff surfaces</strong> — your first request here can promote into a channel with attached repos. Crosslink messages from {agent.name} show up here.
        </span>
      </div>

      <MessageList messages={dm.messages} avatarStyle={avatarStyle} />
      <Composer placeholder={`Message ${agent.name}... (paste an issue URL or /new to spin up a channel)`} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Channel view
// ─────────────────────────────────────────────────────────────
function ChannelView({
  channel, avatarStyle, onOpenDecisions, decisionsOpen,
  onOpenTicket, onOpenPr, rightOpen,
}) {
  const [canvasCollapsed, setCanvasCollapsed] = useState(false);
  const agents = channel.agents.map((id) => AGENTS.find((a) => a.id === id)).filter(Boolean);

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, background: A.paper }}>
      <ChannelHeader channel={channel} agents={agents}
                    onOpenDecisions={onOpenDecisions} decisionsOpen={decisionsOpen} />
      <PinnedCanvas channel={channel}
                    collapsed={canvasCollapsed}
                    onToggle={() => setCanvasCollapsed(!canvasCollapsed)}
                    onOpenTicket={onOpenTicket}
                    onOpenPr={onOpenPr} />
      <MessageList messages={channel.messages} avatarStyle={avatarStyle} />
      <Composer channel={channel} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Empty state
// ─────────────────────────────────────────────────────────────
function EmptyState({ title, subtitle, icon }) {
  return (
    <div style={{
      flex: 1, background: A.paper, display: 'flex',
      alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{ textAlign: 'center', maxWidth: 400, padding: 40 }}>
        <div style={{
          width: 60, height: 60, margin: '0 auto 18px',
          borderRadius: 14, background: A.coralSoft, color: A.coral,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 28,
        }}>{icon}</div>
        <div style={{ fontSize: 18, fontWeight: 700, color: A.text, marginBottom: 6 }}>{title}</div>
        <div style={{ fontSize: 13.5, color: A.textMuted, lineHeight: 1.55 }}>{subtitle}</div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Main App
// ─────────────────────────────────────────────────────────────
function DirectionA({ tweaks }) {
  const [selection, setSelection] = useState({ type: 'channel', id: 'oauth-api-users' });
  const [right, setRight] = useState(null); // { kind, payload }
  const avatarStyle = tweaks?.avatarStyle || 'glyph';

  const channel = selection.type === 'channel'
    ? CHANNELS.find((c) => c.id === selection.id)
    : null;
  const dm = selection.type === 'dm'
    ? DMS.find((d) => d.id === selection.id)
    : null;
  const dmAgent = dm ? AGENTS.find((a) => a.id === dm.agentId) : null;

  // Reset right pane when selection changes
  useEffect(() => { setRight(null); }, [selection.type, selection.id]);

  const handleGoTo = (activityItem) => {
    setSelection({ type: 'channel', id: activityItem.channel });
    if (activityItem.kind === 'approval') setRight({ kind: 'approval' });
    else if (activityItem.kind === 'ci_fail' || activityItem.kind === 'pr_review') {
      const ch = CHANNELS.find((c) => c.id === activityItem.channel);
      const pr = ch?.prs?.[activityItem.kind === 'ci_fail' ? 1 : 0];
      if (pr) setRight({ kind: 'pr', payload: pr });
    }
  };

  return (
    <div style={{
      width: '100%', height: '100%', display: 'flex',
      background: A.inkDeepest, color: A.text,
      fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", system-ui, sans-serif',
      fontSize: 14,
    }}>
      <WorkspaceRail current="relay" />
      <Sidebar
        channels={CHANNELS} dms={DMS} activity={ACTIVITY} repos={REPOS}
        selection={selection} onSelect={setSelection}
        onNewChannel={() => alert('Open new channel modal')}
        onOpenActivity={() => setSelection({ type: 'activity' })}
        avatarStyle={avatarStyle}
      />

      {/* Main area */}
      {selection.type === 'channel' && channel && (
        <ChannelView
          channel={channel} avatarStyle={avatarStyle}
          onOpenDecisions={() => setRight(right?.kind === 'decisions' ? null : { kind: 'decisions' })}
          decisionsOpen={right?.kind === 'decisions'}
          onOpenTicket={(t) => setRight({ kind: 'ticket', payload: t })}
          onOpenPr={(pr) => setRight({ kind: 'pr', payload: pr })}
        />
      )}
      {selection.type === 'dm' && dm && dmAgent && (
        <DmView dm={dm} agent={dmAgent} avatarStyle={avatarStyle}
               onPromote={() => alert(`Promote DM with ${dmAgent.name} to a new channel`)} />
      )}
      {selection.type === 'activity' && <ActivityView onGoTo={handleGoTo} />}
      {selection.type === 'threads' && (
        <EmptyState icon="🧵" title="Threads"
                    subtitle="Your recent right-pane threads — PR reviews, approvals, ticket discussions — will live here." />
      )}
      {selection.type === 'running' && (
        <EmptyState icon="⚙" title="Running tasks"
                    subtitle="Every active agent across every workspace. Same data as `rly running`." />
      )}

      {/* Right pane */}
      {right?.kind === 'decisions' && channel && (
        <DecisionsDrawer channel={channel} onClose={() => setRight(null)} />
      )}
      {right?.kind === 'pr' && (
        <PrThread pr={right.payload} channel={channel} onClose={() => setRight(null)} />
      )}
      {right?.kind === 'approval' && channel && (
        <ApprovalThread channel={channel} onClose={() => setRight(null)}
                       onApprove={() => { alert('Plan approved — 6 tickets dispatched'); setRight(null); }}
                       onReject={() => { alert('Plan rejected'); setRight(null); }} />
      )}
      {right?.kind === 'ticket' && channel && (
        <TicketDetail ticket={right.payload} channel={channel} onClose={() => setRight(null)} />
      )}
    </div>
  );
}

window.DirectionA = DirectionA;
