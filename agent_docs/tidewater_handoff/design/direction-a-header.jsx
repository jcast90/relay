/* Direction A — Channel center pane: header, pinned Board canvas,
   message feed, composer. */

const { A, I, Avatar, agentColor } = window.RELAY_A;
// ─────────────────────────────────────────────────────────────
// Channel header bar
// ─────────────────────────────────────────────────────────────
function ChannelHeader({ channel, agents, onOpenDecisions, decisionsOpen }) {
  return (
    <div style={{
      padding: '11px 18px 11px 20px',
      borderBottom: `1px solid ${A.paperLine}`,
      display: 'flex', alignItems: 'center', gap: 14,
      background: A.paper, flexShrink: 0,
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <I.hash style={{ color: A.textMuted }} />
          <span style={{ fontSize: 16, fontWeight: 600, color: A.text }}>{channel.name}</span>
          <span style={{
            fontSize: 10, fontWeight: 600, letterSpacing: '0.04em',
            textTransform: 'uppercase', padding: '2px 7px', borderRadius: 4,
            background: tierColor(channel.tier).bg, color: tierColor(channel.tier).fg,
          }}>{channel.tier.replace('_', ' ')}</span>
          <button style={{
            border: 'none', background: 'none', padding: 4, cursor: 'pointer',
            color: channel.starred ? A.amber : A.textDim,
          }}>{channel.starred ? <I.starFill /> : <I.star />}</button>
        </div>
        <div style={{
          fontSize: 12.5, color: A.textMuted, marginTop: 2,
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <span>{channel.topic}</span>
        </div>
      </div>

      {/* Agent stack */}
      <div style={{ display: 'flex', alignItems: 'center' }}>
        {agents.slice(0, 4).map((a, i) => (
          <div key={a.id} style={{ marginLeft: i === 0 ? 0 : -8 }}>
            <Avatar agent={a} size={26} showStatus />
          </div>
        ))}
        {agents.length > 4 && (
          <div style={{
            marginLeft: -8, width: 26, height: 26, borderRadius: 6,
            background: A.paperAlt, color: A.textMuted,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 11, fontWeight: 600, border: `2px solid ${A.paper}`,
          }}>+{agents.length - 4}</div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 4 }}>
        <HeaderButton onClick={onOpenDecisions} active={decisionsOpen}>
          <I.book /> Decisions <span style={{
            fontSize: 11, padding: '0 5px', borderRadius: 3,
            background: decisionsOpen ? 'rgba(255,255,255,0.25)' : A.paperAlt,
            color: decisionsOpen ? '#fff' : A.textMuted, marginLeft: 4,
          }}>2</span>
        </HeaderButton>
        <HeaderButton><I.search /></HeaderButton>
      </div>
    </div>
  );
}

function HeaderButton({ children, onClick, active }) {
  return (
    <button onClick={onClick} style={{
      padding: '6px 10px', borderRadius: 6,
      background: active ? A.coral : 'transparent',
      color: active ? '#fff' : A.textMuted,
      border: active ? 'none' : `1px solid ${A.paperLine}`,
      fontSize: 12.5, fontWeight: 500, cursor: 'pointer',
      display: 'flex', alignItems: 'center', gap: 6,
    }}>{children}</button>
  );
}

function tierColor(tier) {
  switch (tier) {
    case 'feature_large':   return { bg: '#fce7c7', fg: '#8a4e0e' };
    case 'feature_small':   return { bg: '#d6ead7', fg: '#2e5c33' };
    case 'architectural':   return { bg: '#e1dcf2', fg: '#4a3d8c' };
    case 'bugfix':          return { bg: '#fcd9d4', fg: '#933b30' };
    case 'trivial':         return { bg: '#e5e1d5', fg: '#5b6579' };
    case 'multi_repo':      return { bg: '#d1e5e9', fg: '#26545b' };
    default:                return { bg: '#e5e1d5', fg: '#5b6579' };
  }
}

// ─────────────────────────────────────────────────────────────
// Pinned Board Canvas — collapsible strip at the top of the channel
// showing ticket board + active PRs + repo assignments at a glance
// ─────────────────────────────────────────────────────────────
function PinnedCanvas({ channel, collapsed, onToggle, onOpenTicket, onOpenPr }) {
  const statusGroups = {
    executing: channel.tickets.filter((t) => t.status === 'executing' || t.status === 'verifying' || t.status === 'retry'),
    ready:     channel.tickets.filter((t) => t.status === 'ready'),
    blocked:   channel.tickets.filter((t) => t.status === 'blocked' || t.status === 'pending'),
    done:      channel.tickets.filter((t) => t.status === 'completed'),
    failed:    channel.tickets.filter((t) => t.status === 'failed'),
  };

  return (
    <div style={{
      background: A.paperAlt,
      borderBottom: `1px solid ${A.paperLine}`,
      flexShrink: 0,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '8px 18px 8px 20px',
        cursor: 'pointer',
      }} onClick={onToggle}>
        <I.canvas style={{ color: A.coral }} />
        <span style={{ fontSize: 12, fontWeight: 600, color: A.text, letterSpacing: '0.02em' }}>
          BOARD · CANVAS
        </span>
        <span style={{ fontSize: 11, color: A.textMuted }}>
          {channel.tickets.length} tickets · {channel.prs.length} PRs · {channel.repos.length} repos
        </span>
        <div style={{ flex: 1 }} />
        <ProgressBar tickets={channel.tickets} />
        <button style={{
          background: 'none', border: 'none', cursor: 'pointer',
          color: A.textMuted, padding: 4, display: 'flex',
        }}>{collapsed ? <I.chevR /> : <I.chevD />}</button>
      </div>

      {!collapsed && (
        <div style={{
          padding: '4px 18px 14px 20px',
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 2.2fr) minmax(0, 1fr)',
          gap: 16,
        }}>
          {/* Tickets */}
          <div>
            <MiniColumn title="In flight" tickets={statusGroups.executing} onOpen={onOpenTicket} tone="amber" />
            <MiniColumn title="Ready" tickets={statusGroups.ready} onOpen={onOpenTicket} tone="sky" />
            {statusGroups.failed.length > 0 && (
              <MiniColumn title="Failed" tickets={statusGroups.failed} onOpen={onOpenTicket} tone="coral" />
            )}
            <MiniColumn title="Blocked / pending" tickets={statusGroups.blocked} onOpen={onOpenTicket} tone="neutral" />
            <MiniColumn title="Done" tickets={statusGroups.done} onOpen={onOpenTicket} tone="mint" muted />
          </div>

          {/* PRs + repos */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{
              background: A.paper, borderRadius: 8,
              border: `1px solid ${A.paperLine}`,
              padding: '10px 12px',
            }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: A.textMuted, marginBottom: 6, letterSpacing: '0.02em' }}>
                TRACKED PRS
              </div>
              {channel.prs.length === 0 && (
                <div style={{ fontSize: 12, color: A.textDim }}>None yet</div>
              )}
              {channel.prs.map((pr) => (
                <PrMini key={pr.number} pr={pr} onOpen={() => onOpenPr(pr)} />
              ))}
            </div>
            <div style={{
              background: A.paper, borderRadius: 8,
              border: `1px solid ${A.paperLine}`,
              padding: '10px 12px',
            }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: A.textMuted, marginBottom: 6, letterSpacing: '0.02em' }}>
                REPOS
              </div>
              {channel.repos.map((alias) => {
                const r = REPOS.find((x) => x.alias === alias);
                const isPrimary = channel.primaryRepo === alias;
                return (
                  <div key={alias} style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '3px 0', fontSize: 12.5, color: A.text,
                  }}>
                    <I.repo style={{ color: A.textMuted }} />
                    <span style={{ fontWeight: 500 }}>@{alias}</span>
                    {isPrimary && <span style={{
                      fontSize: 10, fontWeight: 700, letterSpacing: '0.04em',
                      padding: '1px 5px', borderRadius: 3,
                      background: A.coralSoft, color: A.coral,
                    }}>PRIMARY</span>}
                    <span style={{ marginLeft: 'auto', fontSize: 11, color: A.textDim, fontFamily: 'ui-monospace, Menlo, monospace' }}>
                      {r?.path || ''}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ProgressBar({ tickets }) {
  const total = tickets.length || 1;
  const done = tickets.filter((t) => t.status === 'completed').length;
  const active = tickets.filter((t) => ['executing', 'verifying', 'retry'].includes(t.status)).length;
  const failed = tickets.filter((t) => t.status === 'failed').length;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{
        width: 120, height: 6, borderRadius: 3, background: A.paperLine,
        display: 'flex', overflow: 'hidden',
      }}>
        <div style={{ width: `${(done/total)*100}%`, background: A.mint }} />
        <div style={{ width: `${(active/total)*100}%`, background: A.amber }} />
        <div style={{ width: `${(failed/total)*100}%`, background: A.coral }} />
      </div>
      <span style={{ fontSize: 11.5, color: A.textMuted, fontVariantNumeric: 'tabular-nums' }}>
        {done}/{total}
      </span>
    </div>
  );
}

function MiniColumn({ title, tickets, onOpen, tone, muted }) {
  if (tickets.length === 0) return null;
  const toneMap = {
    amber: A.amber, sky: A.sky, coral: A.coral, mint: A.mint, neutral: A.textDim,
  };
  const c = toneMap[tone];
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{
        fontSize: 11, fontWeight: 600, color: A.textMuted,
        letterSpacing: '0.02em', marginBottom: 6,
        display: 'flex', alignItems: 'center', gap: 6,
      }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: c }} />
        {title.toUpperCase()}
        <span style={{ color: A.textDim, fontWeight: 500 }}>· {tickets.length}</span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {tickets.map((t) => <TicketChip key={t.id} ticket={t} onOpen={() => onOpen(t)} muted={muted} />)}
      </div>
    </div>
  );
}

function TicketChip({ ticket, onOpen, muted }) {
  const agent = AGENTS.find((a) => a.id === ticket.agent);
  const statusColor = A.statusFill[ticket.status] || A.textDim;
  return (
    <div onClick={onOpen} style={{
      background: A.paper, border: `1px solid ${A.paperLine}`,
      borderRadius: 6, padding: '6px 9px', cursor: 'pointer',
      display: 'flex', alignItems: 'center', gap: 8,
      opacity: muted ? 0.65 : 1,
      minWidth: 200, maxWidth: 360,
      boxShadow: '0 1px 0 rgba(0,0,0,0.02)',
    }}>
      <span style={{ width: 3, height: 20, borderRadius: 2, background: statusColor, flexShrink: 0 }} />
      <span style={{
        fontFamily: 'ui-monospace, Menlo, monospace',
        fontSize: 11, color: A.textMuted, fontWeight: 500,
      }}>{ticket.id}</span>
      <span style={{
        fontSize: 12.5, color: A.text, flex: 1,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>{ticket.title}</span>
      {agent && <Avatar agent={agent} size={18} />}
    </div>
  );
}

function PrMini({ pr, onOpen }) {
  const ciColor = pr.ci === 'passing' ? A.mint : pr.ci === 'failing' ? A.coral : A.textDim;
  const reviewColor = pr.review === 'approved' ? A.mint : pr.review === 'changes_requested' ? A.coral : A.amber;
  return (
    <div onClick={onOpen} style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '5px 0', cursor: 'pointer',
      fontSize: 12.5, borderTop: `1px solid ${A.paperLine}`,
    }}>
      <I.pr style={{ color: A.textMuted, flexShrink: 0 }} />
      <span style={{ fontFamily: 'ui-monospace, Menlo, monospace', color: A.coral, fontWeight: 600 }}>
        #{pr.number}
      </span>
      <span style={{
        flex: 1, overflow: 'hidden', textOverflow: 'ellipsis',
        whiteSpace: 'nowrap', color: A.text,
      }}>{pr.title}</span>
      <span style={{
        fontSize: 10, padding: '1px 5px', borderRadius: 3,
        background: `${ciColor}22`, color: ciColor, fontWeight: 600,
      }}>{pr.ci}</span>
      <span style={{
        fontSize: 10, padding: '1px 5px', borderRadius: 3,
        background: `${reviewColor}22`, color: reviewColor, fontWeight: 600,
      }}>{pr.review === 'changes_requested' ? 'changes' : pr.review}</span>
    </div>
  );
}

window.RELAY_A_HEADER = { ChannelHeader, PinnedCanvas };
