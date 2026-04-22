/* Direction A — Right-pane threads: Decisions drawer, PR thread, Approval thread, Ticket detail */

const { A, I, Avatar } = window.RELAY_A;
const { markdownMini } = window.RELAY_A_CHAT;
// ─────────────────────────────────────────────────────────────
// Right-pane container: header + close
// ─────────────────────────────────────────────────────────────
function RightPane({ title, subtitle, icon, onClose, children, width = 380 }) {
  return (
    <div style={{
      width, flexShrink: 0,
      borderLeft: `1px solid ${A.paperLine}`,
      background: A.paper, display: 'flex', flexDirection: 'column',
      boxShadow: '-8px 0 24px rgba(0,0,0,0.04)',
    }}>
      <div style={{
        padding: '12px 16px', borderBottom: `1px solid ${A.paperLine}`,
        display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0,
      }}>
        {icon && <span style={{ color: A.coral }}>{icon}</span>}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: A.text }}>{title}</div>
          {subtitle && <div style={{ fontSize: 12, color: A.textMuted, marginTop: 1 }}>{subtitle}</div>}
        </div>
        <button onClick={onClose} style={{
          background: 'none', border: 'none', cursor: 'pointer',
          color: A.textMuted, padding: 6, borderRadius: 5,
          display: 'flex',
        }}><I.close /></button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>{children}</div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Decisions drawer
// ─────────────────────────────────────────────────────────────
function DecisionsDrawer({ channel, onClose }) {
  return (
    <RightPane
      title="Decisions" icon={<I.book />}
      subtitle={`${channel.decisions.length} recorded · #${channel.name}`}
      onClose={onClose}
    >
      {channel.decisions.length === 0 && (
        <div style={{ padding: 20, color: A.textDim, fontSize: 13 }}>
          No decisions recorded yet. Agents record decisions via{' '}
          <code style={inlineCode}>channel_record_decision</code>.
        </div>
      )}
      {channel.decisions.map((d) => (
        <div key={d.id} style={{
          padding: '14px 16px', borderBottom: `1px solid ${A.paperLine}`,
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6,
          }}>
            <span style={{
              fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 11,
              color: A.textMuted, fontWeight: 500,
            }}>{d.id}</span>
            <span style={{ fontSize: 11, color: A.textDim }}>·</span>
            <span style={{ fontSize: 12, color: A.textMuted }}>by {d.by} · {d.at}</span>
          </div>
          <div style={{ fontSize: 14.5, fontWeight: 600, color: A.text, marginBottom: 6, lineHeight: 1.35 }}>
            {d.title}
          </div>
          <div style={{ fontSize: 13, color: A.text, lineHeight: 1.55, marginBottom: 10 }}>
            {d.description}
          </div>
          <div style={{
            padding: '8px 10px', background: A.paperAlt, borderRadius: 6,
            borderLeft: `3px solid ${A.mint}`, marginBottom: 8,
          }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: A.mint, letterSpacing: '0.04em', marginBottom: 3 }}>
              RATIONALE
            </div>
            <div style={{ fontSize: 13, color: A.text, lineHeight: 1.5 }}>{d.rationale}</div>
          </div>
          {d.alternatives.length > 0 && (
            <div>
              <div style={{
                fontSize: 11, fontWeight: 600, color: A.textMuted,
                letterSpacing: '0.04em', marginBottom: 4,
              }}>ALTERNATIVES CONSIDERED</div>
              {d.alternatives.map((a, i) => (
                <div key={i} style={{
                  fontSize: 12.5, color: A.textMuted, paddingLeft: 12, marginBottom: 2,
                  position: 'relative',
                }}>
                  <span style={{ position: 'absolute', left: 0, color: A.textDim }}>·</span>
                  {a}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </RightPane>
  );
}

const inlineCode = {
  background: A.paperAlt, padding: '1px 5px', borderRadius: 3,
  fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12,
};

// ─────────────────────────────────────────────────────────────
// PR Thread
// ─────────────────────────────────────────────────────────────
function PrThread({ pr, channel, onClose }) {
  const author = AGENTS.find((a) => a.name === pr.author);
  const ciColor = pr.ci === 'passing' ? A.mint : pr.ci === 'failing' ? A.coral : A.textDim;
  const reviewColor = pr.review === 'approved' ? A.mint : pr.review === 'changes_requested' ? A.coral : A.amber;

  const events = pr.ci === 'failing' ? [
    { at: '18m', kind: 'ci_fail', text: 'CI failed — **2 tests** in `test/auth/providers.test.ts`' },
    { at: '24m', kind: 'commit', text: 'Titan pushed `fix: handle 429 from github`' },
    { at: '1h',  kind: 'open', text: 'PR opened by Titan' },
  ] : [
    { at: '12m', kind: 'approve', text: 'Approved by jcast' },
    { at: '45m', kind: 'review', text: 'Saturn requested self-review · all comments resolved' },
    { at: '1h',  kind: 'open',   text: 'PR opened by Saturn' },
  ];

  return (
    <RightPane
      title={`#${pr.number}`} icon={<I.pr />}
      subtitle={pr.title}
      onClose={onClose} width={420}
    >
      {/* Status pills */}
      <div style={{ padding: '12px 16px 8px', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        <StatusPill color={A.mint} label={`open · ${pr.branch}`} />
        <StatusPill color={ciColor} label={`ci: ${pr.ci}`} />
        <StatusPill color={reviewColor} label={`review: ${pr.review === 'changes_requested' ? 'changes' : pr.review}`} />
      </div>

      <div style={{ padding: '0 16px 12px', color: A.textMuted, fontSize: 12.5 }}>
        Tracked by the PR watcher every 30s · on CI fail, a follow-up ticket is enqueued automatically
      </div>

      {/* Actions */}
      <div style={{ padding: '0 16px 14px', display: 'flex', gap: 6 }}>
        <ActionBtn primary>Open on GitHub</ActionBtn>
        <ActionBtn>View diff</ActionBtn>
        <ActionBtn>Unwatch</ActionBtn>
      </div>

      <div style={{ padding: '12px 16px', background: A.paperAlt, borderTop: `1px solid ${A.paperLine}`, borderBottom: `1px solid ${A.paperLine}` }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: A.textMuted, letterSpacing: '0.04em', marginBottom: 8 }}>
          TIMELINE
        </div>
        {events.map((e, i) => (
          <div key={i} style={{
            display: 'flex', gap: 10, padding: '6px 0',
            fontSize: 13, color: A.text,
          }}>
            <span style={{
              width: 22, height: 22, borderRadius: '50%',
              background: e.kind === 'ci_fail' || e.kind === 'changes_requested' ? A.coralSoft :
                         e.kind === 'approve' ? '#dceed7' :
                         A.paperLine,
              color: e.kind === 'ci_fail' ? A.coral : e.kind === 'approve' ? A.mint : A.textMuted,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexShrink: 0,
            }}>
              {e.kind === 'ci_fail' ? <I.close /> : e.kind === 'approve' ? <I.check /> : e.kind === 'commit' ? <I.spark /> : <I.pr />}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div dangerouslySetInnerHTML={{ __html: markdownMini(e.text) }} />
              <div style={{ fontSize: 11, color: A.textDim, marginTop: 1 }}>{e.at} ago</div>
            </div>
          </div>
        ))}
      </div>

      {/* Discussion */}
      <div style={{ padding: '14px 16px' }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: A.textMuted, letterSpacing: '0.04em', marginBottom: 10 }}>
          DISCUSSION
        </div>

        {author && (
          <ThreadMessage agent={author} time={`${pr.ci === 'failing' ? '1h' : '1h'} ago`}
                        text={`Opened **#${pr.number}**. Branch \`${pr.branch}\`. Summary in the PR description.`} />
        )}
        {pr.ci === 'failing' && (
          <>
            <ThreadMessage system text={`CI failing on \`pnpm test\` — 2 tests in \`test/auth/providers.test.ts\`. A follow-up ticket was enqueued automatically.`} />
            {AGENTS.find((a) => a.id === 'titan') && (
              <ThreadMessage agent={AGENTS.find((a) => a.id === 'titan')} time="18m ago"
                            text="Fetched error — github adapter isn't handling 429 from `/user/emails`. Adding backoff + retry." />
            )}
          </>
        )}
      </div>

      <ThreadComposer placeholder={`Reply to #${pr.number}...`} />
    </RightPane>
  );
}

function ActionBtn({ children, primary, onClick }) {
  return (
    <button onClick={onClick} style={{
      padding: '6px 12px', borderRadius: 6, cursor: 'pointer',
      background: primary ? A.coral : A.paper,
      color: primary ? '#fff' : A.text,
      border: primary ? 'none' : `1px solid ${A.paperLine}`,
      fontSize: 12.5, fontWeight: 600,
    }}>{children}</button>
  );
}

function StatusPill({ color, label }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: '3px 8px', borderRadius: 10,
      background: `${color}1c`, color,
      fontSize: 11.5, fontWeight: 600,
    }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: color }} />
      {label}
    </span>
  );
}

function ThreadMessage({ agent, system, text, time }) {
  if (system) {
    return (
      <div style={{
        padding: '8px 10px', margin: '0 0 12px',
        background: A.paperAlt, borderLeft: `3px solid ${A.coral}`,
        borderRadius: 6, fontSize: 13, color: A.text, lineHeight: 1.5,
      }} dangerouslySetInnerHTML={{ __html: markdownMini(text) }} />
    );
  }
  return (
    <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
      <Avatar agent={agent} size={28} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 2 }}>
          <span style={{ fontSize: 13.5, fontWeight: 700, color: A.text }}>{agent.name}</span>
          <span style={{ fontSize: 11, color: A.textDim }}>{time}</span>
        </div>
        <div style={{ fontSize: 13.5, color: A.text, lineHeight: 1.5 }}
             dangerouslySetInnerHTML={{ __html: markdownMini(text) }} />
      </div>
    </div>
  );
}

function ThreadComposer({ placeholder }) {
  const [t, setT] = useState('');
  return (
    <div style={{
      padding: 12, borderTop: `1px solid ${A.paperLine}`, background: A.paper,
      position: 'sticky', bottom: 0,
    }}>
      <textarea value={t} onChange={(e) => setT(e.target.value)}
                placeholder={placeholder} rows={2} style={{
        width: '100%', border: `1px solid ${A.paperLine}`, borderRadius: 8,
        padding: '8px 10px', fontSize: 13, fontFamily: 'inherit',
        resize: 'none', outline: 'none',
      }} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Approval Thread
// ─────────────────────────────────────────────────────────────
function ApprovalThread({ channel, onClose, onApprove, onReject }) {
  return (
    <RightPane
      title="Plan awaiting approval" icon={<I.spark />}
      subtitle={`#${channel.name} · feature_large`}
      onClose={onClose} width={420}
    >
      <div style={{ padding: 16 }}>
        <div style={{
          background: A.coralSoft, borderRadius: 8, padding: '12px 14px',
          border: `1px solid ${A.coral}33`, marginBottom: 14,
        }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: A.coral, marginBottom: 4 }}>
            Saturn drafted a plan — your approval blocks execution
          </div>
          <div style={{ fontSize: 12.5, color: A.text, lineHeight: 1.5 }}>
            6 tickets · 2 repos · estimated 4–7 hours of agent time · opens 2 PRs
          </div>
        </div>

        <div style={{
          fontSize: 11, fontWeight: 600, color: A.textMuted,
          letterSpacing: '0.04em', marginBottom: 8,
        }}>PROPOSED TICKETS</div>

        {channel.tickets.map((t) => {
          const a = AGENTS.find((x) => x.id === t.agent);
          return (
            <div key={t.id} style={{
              padding: '10px 0', borderBottom: `1px solid ${A.paperLine}`,
              display: 'flex', gap: 10, alignItems: 'flex-start',
            }}>
              <span style={{
                fontFamily: 'ui-monospace, Menlo, monospace',
                fontSize: 11, color: A.textMuted, fontWeight: 600,
                background: A.paperAlt, padding: '2px 6px', borderRadius: 4,
                flexShrink: 0,
              }}>{t.id}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, color: A.text, fontWeight: 500, marginBottom: 3 }}>{t.title}</div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', fontSize: 11 }}>
                  <span style={{ color: A.textMuted }}>· {t.specialty.replace('_', ' ')}</span>
                  {t.deps.length > 0 && <span style={{ color: A.textMuted }}>· blocks on {t.deps.join(', ')}</span>}
                  {a && <span style={{ color: A.textMuted }}>· → {a.name}</span>}
                </div>
              </div>
            </div>
          );
        })}

        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button onClick={onApprove} style={{
            flex: 1, padding: '10px 14px', borderRadius: 8,
            background: A.mint, color: '#fff', border: 'none',
            fontSize: 14, fontWeight: 600, cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
          }}><I.check /> Approve & dispatch</button>
          <button onClick={onReject} style={{
            padding: '10px 14px', borderRadius: 8,
            background: A.paper, color: A.text,
            border: `1px solid ${A.paperLine}`,
            fontSize: 14, fontWeight: 600, cursor: 'pointer',
          }}>Request changes</button>
        </div>
      </div>
    </RightPane>
  );
}

// ─────────────────────────────────────────────────────────────
// Ticket detail thread
// ─────────────────────────────────────────────────────────────
function TicketDetail({ ticket, channel, onClose }) {
  const agent = AGENTS.find((a) => a.id === ticket.agent);
  const statusColor = A.statusFill[ticket.status] || A.textDim;
  const deps = (ticket.deps || []).map((d) => channel.tickets.find((t) => t.id === d)).filter(Boolean);
  return (
    <RightPane
      title={ticket.id}
      subtitle={ticket.title}
      onClose={onClose} width={400}
    >
      <div style={{ padding: 16 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
          <StatusPill color={statusColor} label={ticket.status} />
          <StatusPill color={A.textMuted} label={ticket.specialty.replace('_', ' ')} />
          {agent && <StatusPill color={agentColorHex(agent.id)} label={`→ ${agent.name}`} />}
        </div>
        <div style={{ fontSize: 13.5, color: A.text, lineHeight: 1.5, marginBottom: 16 }}>
          {ticket.title}
        </div>

        {deps.length > 0 && (
          <>
            <div style={{ fontSize: 11, fontWeight: 600, color: A.textMuted, letterSpacing: '0.04em', marginBottom: 6 }}>
              DEPENDS ON
            </div>
            {deps.map((d) => (
              <div key={d.id} style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0',
                fontSize: 12.5, color: A.text,
              }}>
                <span style={{ width: 3, height: 16, borderRadius: 2, background: A.statusFill[d.status] || A.textDim }} />
                <span style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 11, color: A.textMuted, fontWeight: 600 }}>{d.id}</span>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.title}</span>
                <span style={{ fontSize: 11, color: A.textDim }}>{d.status}</span>
              </div>
            ))}
          </>
        )}

        <div style={{
          marginTop: 16, padding: '10px 12px', background: A.paperAlt,
          borderRadius: 6, fontSize: 12, color: A.textMuted, lineHeight: 1.6,
        }}>
          <strong style={{ color: A.text }}>Verification</strong><br />
          <code style={inlineCode}>pnpm test test/auth</code>
        </div>
      </div>
    </RightPane>
  );
}

function agentColorHex(id) {
  const palette = ['#3e5886', '#9c5a7c', '#2f7a6a', '#b26a3a', '#5b5fb0', '#c8654a', '#5a7a4a', '#7a5290', '#3a7590'];
  let h = 0; for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return palette[Math.abs(h) % palette.length];
}

window.RELAY_A_RIGHT = { DecisionsDrawer, PrThread, ApprovalThread, TicketDetail };
