/* Direction A — Sidebar (channels, DMs, starred, activity, repos) */

const { A, I, Avatar, agentColor, WorkspaceRail } = window.RELAY_A;
function SidebarSection({ title, count, collapsed, onToggle, action, children }) {
  return (
    <div style={{ marginBottom: 6 }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 4,
        padding: '4px 12px 4px 10px', color: A.textOnDarkMuted,
        fontSize: 11, fontWeight: 600, letterSpacing: '0.04em',
        textTransform: 'uppercase',
      }}>
        <button onClick={onToggle} style={{
          background: 'none', border: 'none', cursor: 'pointer',
          color: A.textOnDarkMuted, padding: '2px 4px', marginLeft: -4,
          display: 'flex', alignItems: 'center',
        }}>
          {collapsed ? <I.chevR /> : <I.chevD />}
        </button>
        <span style={{ flex: 1 }}>{title}{count !== undefined && ` · ${count}`}</span>
        {action && (
          <button onClick={action.onClick} title={action.title} style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: A.textOnDarkMuted, padding: '2px 4px',
            display: 'flex', alignItems: 'center', borderRadius: 4,
          }}>
            <I.plus />
          </button>
        )}
      </div>
      {!collapsed && children}
    </div>
  );
}

function SidebarRow({ active, unread, mentions, onClick, children, indent = 22, dense = false }) {
  return (
    <div onClick={onClick} style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: dense ? `3px ${indent}px` : `5px ${indent}px`,
      cursor: 'pointer',
      background: active ? A.coral : 'transparent',
      color: active ? '#fff' : (unread ? A.textOnDark : A.textOnDarkMuted),
      fontWeight: unread && !active ? 600 : 400,
      fontSize: 13.5, lineHeight: 1.3,
      position: 'relative',
    }}
    onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = A.inkRaised; }}
    onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent'; }}
    >
      {children}
      {mentions > 0 && (
        <span style={{
          background: A.coral, color: '#fff',
          fontSize: 10, fontWeight: 700,
          padding: '1px 6px', borderRadius: 10,
          marginLeft: 'auto',
          border: active ? '1.5px solid #fff' : 'none',
        }}>{mentions}</span>
      )}
      {unread > 0 && !mentions && !active && (
        <span style={{
          width: 6, height: 6, borderRadius: '50%',
          background: A.coral, marginLeft: 'auto',
        }} />
      )}
    </div>
  );
}

function ChannelRow({ channel, active, onClick }) {
  return (
    <SidebarRow active={active} unread={channel.unread} mentions={channel.mentions} onClick={onClick}>
      <I.hash style={{ flexShrink: 0, opacity: 0.8 }} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {channel.name}
      </span>
    </SidebarRow>
  );
}

function DmRow({ dm, agent, active, onClick, avatarStyle }) {
  if (!agent) return null;
  return (
    <SidebarRow active={active} unread={dm.unread} onClick={onClick} indent={12}>
      <Avatar agent={agent} size={20} style={avatarStyle} showStatus />
      <span style={{
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        flex: 1,
      }}>
        {agent.name}
        {agent.activity && (
          <span style={{
            display: 'block', fontSize: 11, color: active ? 'rgba(255,255,255,0.85)' : A.amber,
            fontWeight: 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            marginTop: 1,
          }}>
            ⚙ {agent.activity}
          </span>
        )}
      </span>
    </SidebarRow>
  );
}

function ActivityRow({ item, onClick, active }) {
  const iconMap = {
    approval:    { icon: <I.spark />, color: A.coral,   label: 'Approval' },
    ci_fail:     { icon: <I.flask />, color: A.coral,   label: 'CI' },
    pr_review:   { icon: <I.pr />,    color: A.amber,   label: 'Review' },
    mention:     { icon: <I.at />,    color: A.sky,     label: 'Mention' },
    ticket_fail: { icon: <I.close />, color: A.coral,   label: 'Failed' },
  };
  const m = iconMap[item.kind];
  return (
    <SidebarRow active={active} unread={true} onClick={onClick} indent={12}>
      <span style={{
        width: 18, height: 18, borderRadius: 4,
        background: active ? 'rgba(255,255,255,0.18)' : `${m.color}22`,
        color: active ? '#fff' : m.color,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0,
      }}>{m.icon}</span>
      <span style={{
        flex: 1, overflow: 'hidden', textOverflow: 'ellipsis',
        whiteSpace: 'nowrap', fontSize: 13,
      }}>
        {item.title}
      </span>
      <span style={{
        fontSize: 11, color: active ? 'rgba(255,255,255,0.75)' : A.textOnDarkMuted,
      }}>{item.time}</span>
    </SidebarRow>
  );
}

function RepoRow({ repo, active, onClick, attachedChannels }) {
  return (
    <SidebarRow active={active} onClick={onClick} indent={12} dense>
      <I.repo style={{ opacity: 0.8, flexShrink: 0 }} />
      <span style={{
        overflow: 'hidden', textOverflow: 'ellipsis',
        whiteSpace: 'nowrap', flex: 1,
      }}>
        {repo.alias}
        {repo.primary && (
          <span style={{
            marginLeft: 6, fontSize: 10, opacity: 0.7,
            padding: '0 5px', borderRadius: 3,
            background: active ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.06)',
          }}>primary</span>
        )}
      </span>
      <span style={{
        fontSize: 11, color: active ? 'rgba(255,255,255,0.75)' : A.textOnDarkMuted,
      }}>{attachedChannels}</span>
    </SidebarRow>
  );
}

function Sidebar({
  channels, dms, activity, repos,
  selection, onSelect, onNewChannel, onOpenActivity,
  avatarStyle,
}) {
  const [collapsed, setCollapsed] = useState({ starred: false, channels: false, dms: false, activity: false, repos: false });
  const toggle = (k) => setCollapsed((c) => ({ ...c, [k]: !c[k] }));
  const starred = channels.filter((c) => c.starred);
  const unstarred = channels.filter((c) => !c.starred && c.activeAt !== undefined);
  const totalUnread = [...channels, ...dms].reduce((n, x) => n + (x.unread || 0), 0);

  return (
    <div style={{
      width: 260, background: A.inkDeep, color: A.textOnDark,
      display: 'flex', flexDirection: 'column',
      borderRight: `1px solid ${A.inkLine}`,
      flexShrink: 0, overflow: 'hidden',
    }}>
      {/* Workspace header */}
      <div style={{
        padding: '14px 14px 12px',
        borderBottom: `1px solid ${A.inkLine}`,
        display: 'flex', alignItems: 'center', gap: 10,
      }}>
        <div style={{
          width: 30, height: 30, borderRadius: 8,
          background: `linear-gradient(135deg, ${A.coral}, ${A.amber})`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: '#fff', fontWeight: 700, fontSize: 15,
        }}>R</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 14, color: '#fff' }}>Relay</div>
          <div style={{ fontSize: 11.5, color: A.textOnDarkMuted }}>
            jcast · 3 repos · {AGENTS.filter(a=>a.status==='working').length} working
          </div>
        </div>
      </div>

      {/* Quick actions */}
      <div style={{ padding: '10px 10px 4px', display: 'flex', flexDirection: 'column', gap: 2 }}>
        <button onClick={onOpenActivity} style={quickBtnStyle(selection.type === 'activity')}>
          <I.bell style={{ opacity: 0.85 }} /> Activity
          {ACTIVITY.length > 0 && <span style={{
            marginLeft: 'auto', background: A.coral, color: '#fff',
            fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 10,
          }}>{ACTIVITY.length}</span>}
        </button>
        <button onClick={() => onSelect({ type: 'threads' })} style={quickBtnStyle(selection.type === 'threads')}>
          <I.book style={{ opacity: 0.85 }} /> Threads
        </button>
        <button onClick={() => onSelect({ type: 'running' })} style={quickBtnStyle(selection.type === 'running')}>
          <I.spark style={{ opacity: 0.85 }} /> Running
          <span style={{
            marginLeft: 'auto', fontSize: 11, color: A.textOnDarkMuted,
          }}>{AGENTS.filter(a=>a.status==='working').length}</span>
        </button>
      </div>

      <div style={{ height: 1, background: A.inkLine, margin: '6px 12px' }} />

      <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 12 }}>
        {/* Starred */}
        {starred.length > 0 && (
          <SidebarSection title="Starred" collapsed={collapsed.starred} onToggle={() => toggle('starred')}>
            {starred.map((c) => (
              <SidebarRow key={c.id} active={selection.type === 'channel' && selection.id === c.id}
                          unread={c.unread} mentions={c.mentions}
                          onClick={() => onSelect({ type: 'channel', id: c.id })}>
                <I.starFill style={{ opacity: 0.85, color: A.amber, flexShrink: 0 }} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {c.name}
                </span>
              </SidebarRow>
            ))}
          </SidebarSection>
        )}

        {/* Channels */}
        <SidebarSection
          title="Channels" count={unstarred.length}
          collapsed={collapsed.channels} onToggle={() => toggle('channels')}
          action={{ onClick: onNewChannel, title: 'New channel' }}
        >
          {unstarred.map((c) => (
            <ChannelRow key={c.id} channel={c}
                        active={selection.type === 'channel' && selection.id === c.id}
                        onClick={() => onSelect({ type: 'channel', id: c.id })} />
          ))}
        </SidebarSection>

        {/* DMs */}
        <SidebarSection
          title="Direct Messages" count={dms.length}
          collapsed={collapsed.dms} onToggle={() => toggle('dms')}
          action={{ onClick: () => {}, title: 'New DM' }}
        >
          {dms.map((dm) => {
            const agent = AGENTS.find((a) => a.id === dm.agentId);
            return (
              <DmRow key={dm.id} dm={dm} agent={agent}
                     active={selection.type === 'dm' && selection.id === dm.id}
                     onClick={() => onSelect({ type: 'dm', id: dm.id })}
                     avatarStyle={avatarStyle} />
            );
          })}
        </SidebarSection>

        {/* Repos — only rendered if explicitly passed (A still passes them
             as a "before" reference; C passes [] since repos are channel-scoped) */}
        {repos.length > 0 && (
          <SidebarSection title="Repos" count={repos.length}
                          collapsed={collapsed.repos} onToggle={() => toggle('repos')}>
            {repos.map((r) => {
              const attached = channels.filter((c) => c.repos.includes(r.alias)).length;
              return <RepoRow key={r.alias} repo={r} attachedChannels={attached} onClick={() => {}} />;
            })}
          </SidebarSection>
        )}
      </div>

      {/* Footer: your presence */}
      <div style={{
        padding: '10px 14px', borderTop: `1px solid ${A.inkLine}`,
        display: 'flex', alignItems: 'center', gap: 10,
      }}>
        <div style={{
          width: 28, height: 28, borderRadius: 7,
          background: A.inkRaised,
          color: A.textOnDark, fontSize: 12, fontWeight: 600,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>jc</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12.5, color: A.textOnDark }}>jcast</div>
          <div style={{ fontSize: 11, color: A.mint, display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: A.mint }} /> active
          </div>
        </div>
      </div>
    </div>
  );
}

function quickBtnStyle(active) {
  return {
    display: 'flex', alignItems: 'center', gap: 10,
    padding: '6px 10px', borderRadius: 6,
    background: active ? A.coral : 'transparent',
    color: active ? '#fff' : A.textOnDark,
    border: 'none', cursor: 'pointer',
    fontSize: 13, fontWeight: 500,
    textAlign: 'left', width: '100%',
    transition: 'background 0.12s',
  };
}

window.RELAY_A_SIDEBAR = { Sidebar };
