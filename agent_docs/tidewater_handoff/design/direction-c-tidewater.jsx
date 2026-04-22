/* Direction C — "Tidewater" (synthesis of A + B)
   Base: Direction A's 3-pane layout, Tide palette, tool-use presence,
         full-fidelity bubbles, DM-promote affordance.
   Adds from B: tabbed right rail (Threads / Decisions / PRs).
   New: channel header tabs (Chat | Board | Decisions) — the pane switches,
        not a pinned canvas. Board is a dense list view w/ columns
        (ID, Status, Title, Agent, PR).
*/

(() => {
  const { useState, useMemo, useEffect, useRef } = React;
  const { AGENTS, REPOS, CHANNELS, DMS, ACTIVITY } = window.RELAY_DATA;
  const { A, I, Avatar, agentColor, WorkspaceRail } = window.RELAY_A;
  const { Sidebar } = window.RELAY_A_SIDEBAR;
  const { MessageList, Composer, markdownMini } = window.RELAY_A_CHAT;
  const { RepoChipRow, ChannelSettingsDrawer, NewChannelModal, MentionPopover, renderWithMentions } = window.RELAY_C_REPOS;
  // We'll reuse A's right-pane bodies (Decisions, PR thread) for individual
  // thread detail — but the rail itself is new (tabbed, medium-density).

  const agentById = (id) => AGENTS.find((a) => a.id === id);

  function tierColor(tier) {
    return {
      architectural: { bg: '#e9dff5', fg: '#6a4ea0' },
      feature_large: { bg: A.coralSoft, fg: A.coral },
      feature_small: { bg: A.mintSoft,  fg: A.mint },
      bugfix:        { bg: '#fae8d8',   fg: '#b26a3a' },
    }[tier] || { bg: A.paperAlt, fg: A.textMuted };
  }

  // ─────────────────────────────────────────────────────────────
  // Channel header — NEW: tabbed pane switcher
  // ─────────────────────────────────────────────────────────────
  function ChannelHeader({ channel, agents, pane, onPane, rightOpen, onToggleRight, counts, onChannelChange, onOpenSettings }) {
    const tabs = [
      { id: 'chat',      label: 'Chat',      count: null },
      { id: 'board',     label: 'Board',     count: counts.tickets },
      { id: 'decisions', label: 'Decisions', count: counts.decisions },
    ];
    const tc = tierColor(channel.tier);
    return (
      <div style={{
        borderBottom: `1px solid ${A.paperLine}`,
        background: A.paper, flexShrink: 0,
      }}>
        {/* Top row: name, tier, topic, agents, right-rail toggle */}
        <div style={{
          padding: '10px 18px 8px 20px',
          display: 'flex', alignItems: 'center', gap: 12,
        }}>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            <I.hash style={{ color: A.textMuted, flexShrink: 0 }} />
            <span style={{
              fontSize: 16, fontWeight: 600, color: A.text, letterSpacing: '-0.005em',
              whiteSpace: 'nowrap', flexShrink: 0,
            }}>{channel.name}</span>
            <span style={{
              fontSize: 10, fontWeight: 600, letterSpacing: '0.04em',
              textTransform: 'uppercase', padding: '2px 7px', borderRadius: 4,
              background: tc.bg, color: tc.fg, flexShrink: 0, whiteSpace: 'nowrap',
            }}>{channel.tier.replace('_', ' ')}</span>
            <button style={{
              border: 'none', background: 'none', padding: 4, cursor: 'pointer',
              color: channel.starred ? A.amber : A.textDim, flexShrink: 0,
            }}>{channel.starred ? <I.starFill /> : <I.star />}</button>
            <span style={{ width: 1, height: 12, background: A.paperLine, flexShrink: 0 }} />
            <span style={{
              fontSize: 12, color: A.textDim,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              minWidth: 0,
            }}>{channel.topic}</span>
          </div>

          {/* Agent stack */}
          <div style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
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

          <button onClick={onToggleRight} title="Toggle right rail" style={{
            width: 30, height: 28, borderRadius: 5,
            background: rightOpen ? A.coralSoft : 'transparent',
            color:      rightOpen ? A.coral    : A.textMuted,
            border: `1px solid ${rightOpen ? A.coral + '55' : A.paperLine}`,
            cursor: 'pointer', flexShrink: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
              <rect x="2" y="3" width="10" height="8" rx="1" stroke="currentColor" strokeWidth="1.2"/>
              <path d="M9 3v8" stroke="currentColor" strokeWidth="1.2"/>
            </svg>
          </button>
        </div>

        {/* Tabs row — with interactive repo chips on the right */}
        <div style={{ padding: '0 18px 0 20px', display: 'flex', gap: 2, alignItems: 'flex-end' }}>
          {tabs.map((t) => (
            <button key={t.id} onClick={() => onPane(t.id)} style={{
              padding: '7px 12px 8px',
              background: 'transparent', border: 'none', cursor: 'pointer',
              color: pane === t.id ? A.text : A.textMuted,
              fontSize: 13, fontWeight: pane === t.id ? 600 : 500,
              borderBottom: `2px solid ${pane === t.id ? A.coral : 'transparent'}`,
              marginBottom: -1, fontFamily: 'inherit',
              display: 'flex', alignItems: 'center', gap: 6,
              letterSpacing: '-0.005em',
            }}>
              {t.label}
              {t.count != null && (
                <span style={{
                  fontSize: 10.5, fontWeight: 600, fontVariantNumeric: 'tabular-nums',
                  color: pane === t.id ? A.coral : A.textDim,
                  background: pane === t.id ? A.coralSoft : A.paperAlt,
                  padding: '1px 6px', borderRadius: 8,
                }}>{t.count}</span>
              )}
            </button>
          ))}
          <div style={{ flex: 1 }} />
          <div style={{ paddingBottom: 6, display: 'flex', alignItems: 'center' }}>
            <RepoChipRow channel={channel} onChange={onChannelChange} onOpenSettings={onOpenSettings} />
          </div>
        </div>
      </div>
    );
  }

  // ─────────────────────────────────────────────────────────────
  // BOARD LIST VIEW (new)
  // Columns: ID · Status · Title · Agent · PR
  // ─────────────────────────────────────────────────────────────
  function BoardView({ channel, onOpenTicket, onOpenPr }) {
    const [sort, setSort] = useState('order'); // order | status | agent
    const [group, setGroup] = useState('status'); // none | status | specialty

    const statusOrder = ['executing', 'verifying', 'ready', 'blocked', 'pending', 'failed', 'completed'];
    const statusLabel = {
      pending:   'Pending',
      ready:     'Ready',
      executing: 'Running',
      verifying: 'Verifying',
      completed: 'Done',
      failed:    'Failed',
      blocked:   'Blocked',
      retry:     'Retrying',
    };

    // Sort tickets
    const sorted = useMemo(() => {
      const copy = [...channel.tickets];
      if (sort === 'status') {
        copy.sort((a, b) => statusOrder.indexOf(a.status) - statusOrder.indexOf(b.status));
      } else if (sort === 'agent') {
        copy.sort((a, b) => (a.agent || 'zzz').localeCompare(b.agent || 'zzz'));
      }
      return copy;
    }, [channel.tickets, sort]);

    // Group
    const groups = useMemo(() => {
      if (group === 'none') return [['', sorted]];
      const key = group === 'status' ? 'status' : 'specialty';
      const map = new Map();
      for (const t of sorted) {
        const k = t[key] || 'other';
        if (!map.has(k)) map.set(k, []);
        map.get(k).push(t);
      }
      if (group === 'status') {
        return statusOrder.filter((s) => map.has(s)).map((s) => [s, map.get(s)]);
      }
      return [...map.entries()];
    }, [sorted, group]);

    const totalPrs = (channel.prs || []).length;

    return (
      <div style={{
        flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0,
        background: A.paper,
      }}>
        {/* Toolbar */}
        <div style={{
          flexShrink: 0, padding: '12px 20px 10px',
          borderBottom: `1px solid ${A.paperLine}`,
          display: 'flex', alignItems: 'center', gap: 10,
          background: A.paper,
        }}>
          <div style={{ fontSize: 13, color: A.textMuted }}>
            <span style={{ color: A.text, fontWeight: 600 }}>{channel.tickets.length}</span> tickets ·{' '}
            <span style={{ color: A.text, fontWeight: 600 }}>{totalPrs}</span> PRs ·{' '}
            across <span style={{ color: A.text, fontWeight: 600 }}>{channel.repos.length}</span> repos
          </div>
          <div style={{ flex: 1 }} />
          <Toggle label="Group" value={group} options={[
            { v: 'status',    l: 'by status' },
            { v: 'specialty', l: 'by specialty' },
            { v: 'none',      l: 'none' },
          ]} onChange={setGroup} />
          <Toggle label="Sort" value={sort} options={[
            { v: 'order',  l: 'original' },
            { v: 'status', l: 'by status' },
            { v: 'agent',  l: 'by agent' },
          ]} onChange={setSort} />
          <button style={{
            padding: '5px 10px', borderRadius: 5, fontSize: 12, fontWeight: 600,
            background: A.coral, color: '#fff', border: 'none', cursor: 'pointer',
            display: 'flex', alignItems: 'center', gap: 5,
          }}><I.plus /> Add ticket</button>
        </div>

        {/* Table */}
        <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{
                background: A.paperAlt,
                position: 'sticky', top: 0, zIndex: 1,
                borderBottom: `1px solid ${A.paperLine}`,
              }}>
                <th style={thStyle()}>ID</th>
                <th style={thStyle()}>Status</th>
                <th style={thStyle({ width: '100%' })}>Title</th>
                <th style={thStyle()}>Agent</th>
                <th style={thStyle()}>PR</th>
              </tr>
            </thead>
            <tbody>
              {groups.map(([gk, gtickets], gi) => (
                <React.Fragment key={gk || 'all'}>
                  {gk && (
                    <tr>
                      <td colSpan={5} style={{
                        padding: '12px 20px 4px', fontSize: 11, fontWeight: 700,
                        color: A.textMuted, letterSpacing: '0.04em',
                        background: A.paper,
                      }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                          {group === 'status' && <StatusDot status={gk} />}
                          <span style={{ textTransform: 'uppercase' }}>{group === 'status' ? statusLabel[gk] : gk.replace('_', ' ')}</span>
                          <span style={{ color: A.textDim, fontWeight: 500 }}>· {gtickets.length}</span>
                        </span>
                      </td>
                    </tr>
                  )}
                  {gtickets.map((t) => (
                    <BoardRow key={t.id} t={t} channel={channel}
                              onOpenTicket={onOpenTicket}
                              onOpenPr={onOpenPr}
                              statusLabel={statusLabel} />
                  ))}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  function thStyle(extra) {
    return {
      padding: '8px 16px',
      textAlign: 'left',
      fontSize: 10.5, fontWeight: 700, letterSpacing: '0.05em',
      textTransform: 'uppercase',
      color: A.textMuted,
      whiteSpace: 'nowrap',
      ...extra,
    };
  }

  function BoardRow({ t, channel, onOpenTicket, onOpenPr, statusLabel }) {
    const agent = t.agent ? agentById(t.agent) : null;
    // Rough heuristic: first PR matches first "executing/completed" ticket w/ feat- branch
    const pr = (channel.prs || []).find((p) =>
      p.author.toLowerCase() === (t.agent || '').toLowerCase()
    );
    return (
      <tr onClick={() => onOpenTicket(t)} style={{
        borderBottom: `1px solid ${A.paperLine}`,
        cursor: 'pointer',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = A.paperAlt; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
      >
        <td style={tdStyle({ fontFamily: 'ui-monospace, Menlo, monospace', color: A.textMuted, fontSize: 12 })}>{t.id}</td>
        <td style={tdStyle()}>
          <StatusPill status={t.status} label={statusLabel[t.status]} />
        </td>
        <td style={tdStyle({ color: A.text, fontWeight: 500 })}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span>{t.title}</span>
            {t.deps?.length > 0 && (
              <span style={{
                fontSize: 10.5, color: A.textDim,
                fontFamily: 'ui-monospace, Menlo, monospace',
              }}>← {t.deps.join(', ')}</span>
            )}
            <span style={{
              fontSize: 10, color: A.textDim,
              padding: '1px 5px', borderRadius: 3,
              background: A.paperAlt,
              fontFamily: 'ui-monospace, Menlo, monospace',
            }}>{t.specialty.replace('_', ' ')}</span>
          </div>
        </td>
        <td style={tdStyle()}>
          {agent ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <Avatar agent={agent} size={20} />
              <span style={{ color: A.text, fontSize: 12.5, fontWeight: 500 }}>{agent.name}</span>
            </div>
          ) : (
            <span style={{ color: A.textDim, fontSize: 12 }}>unassigned</span>
          )}
        </td>
        <td style={tdStyle()}>
          {pr ? (
            <button onClick={(e) => { e.stopPropagation(); onOpenPr(pr); }} style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              background: 'transparent', border: `1px solid ${A.paperLine}`,
              color: A.text, padding: '3px 8px', borderRadius: 4,
              cursor: 'pointer', fontFamily: 'inherit', fontSize: 12,
            }}>
              <I.pr />
              <span style={{ fontFamily: 'ui-monospace, Menlo, monospace' }}>#{pr.number}</span>
              <span style={{ width: 5, height: 5, borderRadius: '50%', background:
                pr.ci === 'passing' ? A.mint : pr.ci === 'failing' ? A.coral : A.textDim }} />
            </button>
          ) : (
            <span style={{ color: A.textDim, fontSize: 12 }}>—</span>
          )}
        </td>
      </tr>
    );
  }

  function tdStyle(extra) {
    return {
      padding: '10px 16px',
      verticalAlign: 'middle',
      fontSize: 13,
      ...extra,
    };
  }

  function StatusDot({ status }) {
    const c = A.statusFill[status] || A.textDim;
    if (status === 'executing') {
      return <span style={{
        width: 7, height: 7, borderRadius: '50%', background: c,
        boxShadow: `0 0 0 3px ${c}22`,
        animation: 'c-pulse 1.6s ease-in-out infinite',
        display: 'inline-block',
      }} />;
    }
    if (status === 'blocked') {
      return <span style={{ width: 7, height: 2, background: c, display: 'inline-block' }} />;
    }
    if (status === 'ready' || status === 'pending') {
      return <span style={{
        width: 7, height: 7, borderRadius: '50%', background: 'transparent',
        border: `1.5px ${status === 'pending' ? 'dashed' : 'solid'} ${c}`,
        display: 'inline-block', boxSizing: 'border-box',
      }} />;
    }
    return <span style={{ width: 7, height: 7, borderRadius: '50%', background: c, display: 'inline-block' }} />;
  }

  function StatusPill({ status, label }) {
    const c = A.statusFill[status] || A.textDim;
    const bg = {
      executing: A.coralSoft,
      verifying: '#e9dff5',
      completed: A.mintSoft,
      failed:    A.coralSoft,
      ready:     '#dce6f5',
      blocked:   A.paperAlt,
      pending:   A.paperAlt,
    }[status] || A.paperAlt;
    const fg = {
      executing: '#b8761f',
      verifying: '#6a4ea0',
      completed: '#2a7a5a',
      failed:    '#a43c32',
      ready:     '#3a5fa0',
      blocked:   A.textMuted,
      pending:   A.textDim,
    }[status] || A.textMuted;
    return (
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        padding: '2px 8px', borderRadius: 10,
        background: bg, color: fg,
        fontSize: 11, fontWeight: 600,
        whiteSpace: 'nowrap',
      }}>
        <StatusDot status={status} />
        {label}
      </span>
    );
  }

  function Toggle({ label, value, options, onChange }) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5 }}>
        <span style={{ color: A.textDim, fontWeight: 500 }}>{label}:</span>
        <div style={{ display: 'flex', background: A.paperAlt, borderRadius: 5, padding: 2, border: `1px solid ${A.paperLine}` }}>
          {options.map((o) => (
            <button key={o.v} onClick={() => onChange(o.v)} style={{
              padding: '2px 8px', borderRadius: 3,
              background: value === o.v ? A.paper : 'transparent',
              color:      value === o.v ? A.text  : A.textMuted,
              border: 'none', cursor: 'pointer',
              fontSize: 11.5, fontWeight: value === o.v ? 600 : 500,
              boxShadow: value === o.v ? `0 1px 2px rgba(0,0,0,0.05)` : 'none',
              fontFamily: 'inherit',
            }}>{o.l}</button>
          ))}
        </div>
      </div>
    );
  }

  // ─────────────────────────────────────────────────────────────
  // DECISIONS VIEW (center pane, when tab=decisions)
  // Similar to A's decisions drawer but more breathing room
  // ─────────────────────────────────────────────────────────────
  function DecisionsView({ channel, onOpenThread }) {
    if (!channel.decisions?.length) {
      return (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: A.paper }}>
          <div style={{ textAlign: 'center', maxWidth: 440, padding: 40 }}>
            <div style={{
              width: 60, height: 60, margin: '0 auto 18px', borderRadius: 14,
              background: A.coralSoft, color: A.coral,
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 26,
            }}>⎉</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: A.text, marginBottom: 6 }}>No decisions yet</div>
            <div style={{ fontSize: 13.5, color: A.textMuted, lineHeight: 1.55 }}>
              When agents make a call worth preserving — architecture, approach, trade-off — it shows up here as an ADR. They're searchable across channels.
            </div>
          </div>
        </div>
      );
    }
    return (
      <div style={{ flex: 1, overflow: 'auto', background: A.paper, minHeight: 0 }}>
        <div style={{ maxWidth: 820, margin: '0 auto', padding: '28px 40px 60px' }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: A.textMuted, letterSpacing: '0.05em', marginBottom: 4 }}>
            DECISION LOG · {channel.decisions.length}
          </div>
          <div style={{ fontSize: 22, fontWeight: 700, color: A.text, marginBottom: 24, letterSpacing: '-0.01em' }}>
            #{channel.name}
          </div>
          {channel.decisions.map((d, i) => (
            <article key={d.id} style={{
              padding: '20px 0 24px',
              borderTop: i === 0 ? 'none' : `1px solid ${A.paperLine}`,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                <span style={{
                  fontSize: 10.5, fontWeight: 700, letterSpacing: '0.05em',
                  color: A.coral, background: A.coralSoft,
                  padding: '2px 7px', borderRadius: 3,
                  fontFamily: 'ui-monospace, Menlo, monospace',
                }}>{d.id}</span>
                <span style={{ fontSize: 12, color: A.textDim }}>by {d.by} · {d.at}</span>
              </div>
              <h3 style={{
                fontSize: 18, fontWeight: 700, color: A.text,
                margin: '0 0 10px', letterSpacing: '-0.01em', lineHeight: 1.3,
              }}>{d.title}</h3>
              <p style={{ fontSize: 14, lineHeight: 1.6, color: A.text, margin: '0 0 12px' }}
                 dangerouslySetInnerHTML={{ __html: markdownMini(d.description) }} />
              <div style={{
                padding: '10px 14px', background: A.paperAlt, borderRadius: 6,
                borderLeft: `3px solid ${A.coral}`, marginBottom: 10,
              }}>
                <div style={{ fontSize: 10.5, fontWeight: 700, color: A.coral, letterSpacing: '0.05em', marginBottom: 4 }}>RATIONALE</div>
                <div style={{ fontSize: 13, lineHeight: 1.55, color: A.text }}
                     dangerouslySetInnerHTML={{ __html: markdownMini(d.rationale) }} />
              </div>
              <details style={{ fontSize: 12.5, color: A.textMuted, marginTop: 6 }}>
                <summary style={{ cursor: 'pointer', color: A.textMuted, fontWeight: 500 }}>
                  Alternatives considered ({d.alternatives.length})
                </summary>
                <ul style={{ margin: '6px 0 0 0', paddingLeft: 18, lineHeight: 1.6 }}>
                  {d.alternatives.map((alt, j) => <li key={j}>{alt}</li>)}
                </ul>
              </details>
            </article>
          ))}
        </div>
      </div>
    );
  }

  // ─────────────────────────────────────────────────────────────
  // RIGHT RAIL — tabbed (Threads / Decisions / PRs)
  // ─────────────────────────────────────────────────────────────
  function RightRail({ channel, right, setRight, tab, setTab, onClose }) {
    const tabs = [
      { id: 'threads',   label: 'Threads',   count: 2 /* synthesized */ },
      { id: 'decisions', label: 'Decisions', count: channel.decisions?.length || 0 },
      { id: 'prs',       label: 'PRs',       count: channel.prs?.length || 0 },
    ];
    return (
      <div style={{
        width: 380, flexShrink: 0,
        borderLeft: `1px solid ${A.paperLine}`,
        background: A.paper, display: 'flex', flexDirection: 'column',
        boxShadow: '-8px 0 24px rgba(0,0,0,0.04)',
        minHeight: 0,
      }}>
        <div style={{
          flexShrink: 0, borderBottom: `1px solid ${A.paperLine}`,
          padding: '0 6px 0 10px', display: 'flex', alignItems: 'center',
          background: A.paper,
        }}>
          {tabs.map((t) => (
            <button key={t.id} onClick={() => { setTab(t.id); setRight(null); }} style={{
              padding: '12px 10px',
              background: 'transparent', border: 'none', cursor: 'pointer',
              color: tab === t.id ? A.text : A.textMuted,
              fontSize: 12.5, fontWeight: tab === t.id ? 600 : 500,
              borderBottom: `2px solid ${tab === t.id ? A.coral : 'transparent'}`,
              marginBottom: -1, fontFamily: 'inherit',
              display: 'flex', alignItems: 'center', gap: 5,
            }}>
              {t.label}
              <span style={{
                fontSize: 10.5, fontWeight: 600, fontVariantNumeric: 'tabular-nums',
                color: tab === t.id ? A.coral : A.textDim,
                background: tab === t.id ? A.coralSoft : A.paperAlt,
                padding: '1px 5px', borderRadius: 8,
              }}>{t.count}</span>
            </button>
          ))}
          <div style={{ flex: 1 }} />
          <button onClick={onClose} style={{
            width: 28, height: 28, borderRadius: 5,
            background: 'none', border: 'none', cursor: 'pointer',
            color: A.textMuted,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}><I.close /></button>
        </div>

        {/* Body — if `right` is set (detail view), render thread detail; else list */}
        <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
          {right ? (
            <ThreadDetail right={right} channel={channel} onBack={() => setRight(null)} />
          ) : (
            <>
              {tab === 'threads'   && <ThreadsList channel={channel} onOpen={setRight} />}
              {tab === 'decisions' && <DecisionsList channel={channel} onOpen={setRight} />}
              {tab === 'prs'       && <PrsList channel={channel} onOpen={setRight} />}
            </>
          )}
        </div>
      </div>
    );
  }

  // Threads are synthesized (PR #482 discussion, plan approval)
  function synthesizeThreads(channel) {
    const out = [];
    if (channel.tickets.some((t) => t.status === 'pending' || t.status === 'ready')) {
      out.push({
        id: 'th-approval', kind: 'approval',
        title: 'Plan awaiting approval',
        by: 'Relay', time: '8m ago',
        preview: `${channel.tickets.length} tickets · ${channel.tier.replace('_',' ')}`,
        replies: 1,
      });
    }
    (channel.prs || []).forEach((pr) => {
      if (pr.ci === 'failing') {
        out.push({
          id: `th-pr-${pr.number}`, kind: 'pr', pr,
          title: `PR #${pr.number} · CI failing`,
          by: pr.author, time: '12m ago',
          preview: pr.title,
          replies: 3,
        });
      }
    });
    return out;
  }

  function ThreadsList({ channel, onOpen }) {
    const threads = synthesizeThreads(channel);
    if (!threads.length) {
      return <EmptyRail icon="🧵" title="No open threads"
                        hint="Replies to messages and auto-opened approval / CI threads appear here." />;
    }
    return (
      <div style={{ padding: '6px 0' }}>
        {threads.map((t) => (
          <div key={t.id} onClick={() => onOpen({ kind: t.kind, payload: t })} style={{
            padding: '12px 16px', borderBottom: `1px solid ${A.paperLine}`,
            cursor: 'pointer', display: 'flex', gap: 10, alignItems: 'flex-start',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = A.paperAlt; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          >
            <div style={{
              width: 6, height: 6, borderRadius: '50%',
              background: t.kind === 'approval' ? A.coral : A.amber,
              marginTop: 6, flexShrink: 0,
            }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: A.text, marginBottom: 2 }}>{t.title}</div>
              <div style={{ fontSize: 12, color: A.textMuted, lineHeight: 1.4,
                            overflow: 'hidden', textOverflow: 'ellipsis',
                            display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                {t.preview}
              </div>
              <div style={{ fontSize: 11, color: A.textDim, marginTop: 4, display: 'flex', gap: 8 }}>
                <span>{t.by}</span>
                <span>·</span>
                <span>{t.time}</span>
                <span>·</span>
                <span>{t.replies} repl{t.replies === 1 ? 'y' : 'ies'}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  }

  function DecisionsList({ channel, onOpen }) {
    if (!channel.decisions?.length) {
      return <EmptyRail icon="⎉" title="No decisions"
                        hint="ADRs recorded by agents show up here. Same list as the Decisions tab in the channel header." />;
    }
    return (
      <div>
        {channel.decisions.map((d) => (
          <div key={d.id} onClick={() => onOpen({ kind: 'decision', payload: d })} style={{
            padding: '12px 16px', borderBottom: `1px solid ${A.paperLine}`, cursor: 'pointer',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = A.paperAlt; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <span style={{
                fontSize: 10.5, fontWeight: 700, color: A.coral,
                fontFamily: 'ui-monospace, Menlo, monospace',
              }}>{d.id}</span>
              <span style={{ fontSize: 11, color: A.textDim }}>· {d.by} · {d.at}</span>
            </div>
            <div style={{ fontSize: 13, fontWeight: 600, color: A.text, lineHeight: 1.35, marginBottom: 4 }}>{d.title}</div>
            <div style={{ fontSize: 12, color: A.textMuted, lineHeight: 1.45,
                          overflow: 'hidden', textOverflow: 'ellipsis',
                          display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
              {d.description}
            </div>
          </div>
        ))}
      </div>
    );
  }

  function PrsList({ channel, onOpen }) {
    if (!channel.prs?.length) {
      return <EmptyRail icon="⧖" title="No open PRs"
                        hint="Agent PRs with live CI + review status land here." />;
    }
    return (
      <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {channel.prs.map((pr) => {
          const ciColor = pr.ci === 'passing' ? A.mint : pr.ci === 'failing' ? A.coral : A.textDim;
          const rvColor = pr.review === 'approved' ? A.mint : pr.review === 'pending' ? A.amber : A.textDim;
          return (
            <div key={pr.number} onClick={() => onOpen({ kind: 'pr', payload: pr })} style={{
              padding: 12, background: A.paper, border: `1px solid ${A.paperLine}`,
              borderRadius: 6, cursor: 'pointer', transition: 'all 0.12s',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = A.coral; }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = A.paperLine; }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11, color: A.textDim, marginBottom: 4 }}>
                <span style={{ display: 'flex', color: A.textMuted }}><I.pr /></span>
                <span style={{ fontFamily: 'ui-monospace, Menlo, monospace' }}>#{pr.number}</span>
                <span>·</span>
                <span style={{ fontFamily: 'ui-monospace, Menlo, monospace' }}>{pr.branch}</span>
                <div style={{ flex: 1 }} />
                <span style={{ color: agentColor(pr.author.toLowerCase()), fontWeight: 600 }}>{pr.author}</span>
              </div>
              <div style={{ fontSize: 13, fontWeight: 500, color: A.text, lineHeight: 1.35, marginBottom: 8 }}>{pr.title}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 11.5 }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 5, color: ciColor, fontWeight: 500 }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: ciColor }} />CI {pr.ci}
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 5, color: rvColor, fontWeight: 500 }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: rvColor }} />review {pr.review}
                </span>
                <div style={{ flex: 1 }} />
                <span style={{ color: A.coral, fontWeight: 500, fontSize: 11.5 }}>Open thread →</span>
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  function EmptyRail({ icon, title, hint }) {
    return (
      <div style={{ padding: '40px 24px', textAlign: 'center' }}>
        <div style={{
          width: 44, height: 44, margin: '0 auto 12px', borderRadius: 10,
          background: A.paperAlt, color: A.textMuted,
          display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20,
        }}>{icon}</div>
        <div style={{ fontSize: 13, fontWeight: 600, color: A.text, marginBottom: 4 }}>{title}</div>
        <div style={{ fontSize: 12, color: A.textMuted, lineHeight: 1.55 }}>{hint}</div>
      </div>
    );
  }

  // ─────────────────────────────────────────────────────────────
  // THREAD DETAIL (right-rail body when a thread is opened)
  // ─────────────────────────────────────────────────────────────
  function ThreadDetail({ right, channel, onBack }) {
    return (
      <div style={{ padding: 0 }}>
        <div style={{
          padding: '10px 14px', borderBottom: `1px solid ${A.paperLine}`,
          display: 'flex', alignItems: 'center', gap: 8,
          background: A.paperAlt, position: 'sticky', top: 0, zIndex: 1,
        }}>
          <button onClick={onBack} style={{
            background: 'transparent', border: `1px solid ${A.paperLine}`,
            color: A.textMuted, padding: '3px 8px', borderRadius: 4,
            cursor: 'pointer', fontSize: 11.5, fontFamily: 'inherit',
            display: 'flex', alignItems: 'center', gap: 4,
          }}>← Back</button>
          <span style={{ fontSize: 11, color: A.textDim, textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 600 }}>
            {right.kind === 'approval' ? 'Approval' : right.kind === 'pr' ? 'PR thread' : right.kind === 'decision' ? 'Decision' : 'Thread'}
          </span>
        </div>
        <div style={{ padding: '14px 16px' }}>
          {right.kind === 'approval' && <ApprovalBody channel={channel} />}
          {right.kind === 'pr'        && <PrBody pr={right.payload?.pr || right.payload} channel={channel} />}
          {right.kind === 'decision'  && <DecisionBody d={right.payload} />}
        </div>
      </div>
    );
  }

  function ApprovalBody({ channel }) {
    return (
      <div>
        <div style={{
          padding: 12, background: A.coralSoft,
          borderRadius: 6, fontSize: 12.5, color: '#8e3b32', marginBottom: 12,
          display: 'flex', gap: 10, alignItems: 'flex-start',
        }}>
          <I.spark style={{ color: A.coral, marginTop: 2, flexShrink: 0 }} />
          <div>
            <div style={{ fontWeight: 600, marginBottom: 2 }}>Plan generated — awaiting your approval</div>
            <div>{channel.tickets.length} tickets across {channel.repos.length} repos · {channel.tier.replace('_', ' ')}</div>
          </div>
        </div>
        <div style={{ fontSize: 13, color: A.text, lineHeight: 1.55, marginBottom: 14 }}>
          Classified this issue as <strong>{channel.tier.replace('_', ' ')}</strong>. Planner decomposed it into {channel.tickets.length} tickets,{' '}
          dispatched the first ready ones after approval. You can edit tickets before approving.
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button style={{
            flex: 1, padding: '9px 12px', borderRadius: 5,
            background: A.coral, color: '#fff', border: 'none',
            fontSize: 13, fontWeight: 600, cursor: 'pointer',
          }}>Approve & dispatch</button>
          <button style={{
            padding: '9px 12px', borderRadius: 5,
            background: 'transparent', color: A.textMuted,
            border: `1px solid ${A.paperLine}`,
            fontSize: 13, fontWeight: 500, cursor: 'pointer',
          }}>Edit plan</button>
          <button style={{
            padding: '9px 12px', borderRadius: 5,
            background: 'transparent', color: A.textMuted,
            border: `1px solid ${A.paperLine}`,
            fontSize: 13, fontWeight: 500, cursor: 'pointer',
          }}>Reject</button>
        </div>
      </div>
    );
  }

  function PrBody({ pr, channel }) {
    if (!pr) return null;
    const ciColor = pr.ci === 'passing' ? A.mint : pr.ci === 'failing' ? A.coral : A.textDim;
    const rvColor = pr.review === 'approved' ? A.mint : pr.review === 'pending' ? A.amber : A.textDim;
    return (
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11.5, color: A.textDim, marginBottom: 6 }}>
          <span style={{ display: 'flex', color: A.textMuted }}><I.pr /></span>
          <span style={{ fontFamily: 'ui-monospace, Menlo, monospace' }}>#{pr.number}</span>
          <span>·</span>
          <span style={{ fontFamily: 'ui-monospace, Menlo, monospace' }}>{pr.branch}</span>
          <span>·</span>
          <span style={{ color: agentColor(pr.author.toLowerCase()), fontWeight: 600 }}>{pr.author}</span>
        </div>
        <h3 style={{ fontSize: 15, fontWeight: 700, color: A.text, margin: '0 0 10px', lineHeight: 1.35 }}>{pr.title}</h3>
        <div style={{ display: 'flex', gap: 10, marginBottom: 14, fontSize: 12 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 5, color: ciColor, fontWeight: 500 }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: ciColor }} />CI {pr.ci}
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 5, color: rvColor, fontWeight: 500 }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: rvColor }} />review {pr.review}
          </span>
          <span style={{ color: A.textMuted }}>· state {pr.state}</span>
        </div>
        {pr.ci === 'failing' && (
          <div style={{
            padding: 12, background: '#fdeeed', border: `1px solid ${A.coral}55`,
            borderRadius: 6, fontSize: 12.5, marginBottom: 12,
          }}>
            <div style={{ fontWeight: 600, color: '#8e3b32', marginBottom: 4 }}>2 tests failing</div>
            <div style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 11.5, color: A.textMuted, lineHeight: 1.6 }}>
              oauth-github.test.ts  · expected 200, got 401<br/>
              oauth-google.test.ts  · timeout after 5000ms
            </div>
          </div>
        )}
        <div style={{ fontSize: 12, color: A.textDim, textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 700, marginBottom: 6 }}>
          Activity · {pr.author.toLowerCase()} is on it
        </div>
        <div style={{ fontSize: 12, color: A.textMuted, fontFamily: 'ui-monospace, Menlo, monospace', lineHeight: 1.7, background: A.paperAlt, padding: 10, borderRadius: 5 }}>
          <div><span style={{ color: A.amber }}>⚙</span> reading src/auth/providers/github.ts</div>
          <div><span style={{ color: A.amber }}>⚙</span> running pnpm test oauth-github</div>
          <div><span style={{ color: A.amber }}>⚙</span> editing src/auth/providers/github.ts</div>
        </div>
        <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
          <button style={{
            flex: 1, padding: '8px 12px', borderRadius: 5,
            background: A.coral, color: '#fff', border: 'none',
            fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
          }}>Review in GitHub ↗</button>
          <button style={{
            padding: '8px 12px', borderRadius: 5,
            background: 'transparent', color: A.textMuted,
            border: `1px solid ${A.paperLine}`,
            fontSize: 12.5, fontWeight: 500, cursor: 'pointer',
          }}>Request changes</button>
        </div>
      </div>
    );
  }

  function DecisionBody({ d }) {
    return (
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <span style={{
            fontSize: 10.5, fontWeight: 700, letterSpacing: '0.05em',
            color: A.coral, background: A.coralSoft,
            padding: '2px 7px', borderRadius: 3,
            fontFamily: 'ui-monospace, Menlo, monospace',
          }}>{d.id}</span>
          <span style={{ fontSize: 11.5, color: A.textDim }}>by {d.by} · {d.at}</span>
        </div>
        <h3 style={{ fontSize: 15, fontWeight: 700, color: A.text, margin: '0 0 10px', lineHeight: 1.35 }}>{d.title}</h3>
        <p style={{ fontSize: 13, lineHeight: 1.6, color: A.text, margin: '0 0 12px' }}
           dangerouslySetInnerHTML={{ __html: markdownMini(d.description) }} />
        <div style={{
          padding: '10px 12px', background: A.paperAlt, borderRadius: 5,
          borderLeft: `3px solid ${A.coral}`, marginBottom: 12,
        }}>
          <div style={{ fontSize: 10.5, fontWeight: 700, color: A.coral, letterSpacing: '0.05em', marginBottom: 4 }}>RATIONALE</div>
          <div style={{ fontSize: 12.5, lineHeight: 1.55, color: A.text }}
               dangerouslySetInnerHTML={{ __html: markdownMini(d.rationale) }} />
        </div>
        <div style={{ fontSize: 10.5, fontWeight: 700, color: A.textMuted, letterSpacing: '0.05em', marginBottom: 5 }}>
          ALTERNATIVES
        </div>
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: A.textMuted, lineHeight: 1.6 }}>
          {d.alternatives.map((alt, i) => <li key={i}>{alt}</li>)}
        </ul>
      </div>
    );
  }

  // ─────────────────────────────────────────────────────────────
  // DM view (A-style, inlined)
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
              {agent.provider} · {agent.status === 'working'
                ? <span style={{ color: A.amber }}>⚙ {agent.activity || 'working'}</span>
                : <span>{agent.status}</span>}
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
            DMs are <strong style={{ color: A.text }}>kickoff surfaces</strong> — your first request here can promote into a channel with attached repos. Crosslinks from {agent.name} arrive here.
          </span>
        </div>
        <MessageList messages={dm.messages} avatarStyle={avatarStyle} />
        <Composer placeholder={`Message ${agent.name}... (paste an issue URL or /new to spin up a channel)`} />
      </div>
    );
  }

  // ─────────────────────────────────────────────────────────────
  // C's MessageList — renders mentions as React chips
  // ─────────────────────────────────────────────────────────────
  function MessageListC({ messages, avatarStyle, channel }) {
    if (!messages?.length) {
      return <div style={{ flex: 1, background: A.paper }} />;
    }
    return (
      <div style={{ flex: 1, overflow: 'auto', padding: '12px 0', background: A.paper, minHeight: 0 }}>
        {messages.map((m, i) => {
          const prev = messages[i - 1];
          const compact = prev && prev.author === m.author && prev.kind === m.kind;
          return <MessageC key={m.id} m={m} compact={compact} avatarStyle={avatarStyle} channel={channel} />;
        })}
      </div>
    );
  }

  function MessageC({ m, compact, avatarStyle, channel }) {
    const agent = m.kind === 'assistant' || m.kind === 'crosslink'
      ? AGENTS.find((a) => a.id === m.author) : null;

    // System lines
    if (m.kind === 'system') {
      return (
        <div style={{
          padding: '4px 20px 4px 60px',
          fontSize: 12, color: A.textMuted,
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <I.spark style={{ color: A.coral }} />
          <span>{renderWithMentions(m.text, channel)}</span>
          <span style={{ color: A.textDim }}>· {m.time}</span>
        </div>
      );
    }

    // Tool-use line
    if (m.kind === 'tool') {
      return (
        <div style={{
          padding: '2px 20px 2px 60px',
          fontSize: 12, color: A.textDim,
          fontFamily: 'ui-monospace, Menlo, monospace',
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          <span style={{ color: A.amber }}>⚙</span>
          <span>{m.text}</span>
          <span>· {m.time}</span>
        </div>
      );
    }

    const authorName = agent?.name || (m.author === 'you' ? 'You' : m.author);
    const authorColor = agent ? agentColor(agent.id) : A.text;

    return (
      <div style={{
        padding: compact ? '2px 20px 2px 20px' : '10px 20px 2px 20px',
        display: 'flex', gap: 10, alignItems: 'flex-start',
        position: 'relative',
      }}>
        <div style={{ width: 32, flexShrink: 0, paddingTop: 2 }}>
          {!compact && (agent
            ? <Avatar agent={agent} size={32} showStatus style={avatarStyle} />
            : (
              <div style={{
                width: 32, height: 32, borderRadius: 6,
                background: A.mintSoft, color: '#2a7a5a',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 14, fontWeight: 700,
              }}>◉</div>
            )
          )}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          {!compact && (
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 2 }}>
              <span style={{ fontWeight: 700, fontSize: 14, color: authorColor }}>{authorName}</span>
              {agent && (
                <span style={{ fontSize: 10.5, color: A.textDim, textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 600 }}>{agent.provider}</span>
              )}
              <span style={{ fontSize: 11.5, color: A.textDim }}>{m.time}</span>
            </div>
          )}
          <div style={{ fontSize: 14.5, color: A.text, lineHeight: 1.5 }}>
            {renderWithMentions(m.text, channel)}
          </div>
        </div>
      </div>
    );
  }

  // ─────────────────────────────────────────────────────────────
  // C's Composer — with @ mention popover
  // ─────────────────────────────────────────────────────────────
  function ComposerC({ channel, placeholder }) {
    const [text, setText] = useState('');
    const [autoApprove, setAutoApprove] = useState(true);
    const [mentionState, setMentionState] = useState(null); // { start, query } | null
    const taRef = useRef(null);

    const aliases = channel?.repos || [];
    const targetRepo = channel?.primaryRepo || aliases[0];

    // Detect @mention trigger as user types
    const onChange = (e) => {
      const v = e.target.value;
      setText(v);
      const caret = e.target.selectionStart;
      const before = v.slice(0, caret);
      const m = before.match(/(?:^|\s)@([a-z0-9_-]*)$/i);
      if (m) {
        setMentionState({ start: caret - m[1].length - 1, query: m[1] });
      } else {
        setMentionState(null);
      }
    };

    const acceptMention = (pick) => {
      if (!mentionState) return;
      const { start } = mentionState;
      const before = text.slice(0, start);
      const after  = text.slice(taRef.current?.selectionStart ?? text.length);
      const next = `${before}@${pick.alias} ${after}`;
      setText(next);
      setMentionState(null);
      requestAnimationFrame(() => {
        taRef.current?.focus();
        const pos = (before + `@${pick.alias} `).length;
        taRef.current?.setSelectionRange(pos, pos);
      });
    };

    return (
      <div style={{ padding: '0 18px 16px 20px', flexShrink: 0, background: A.paper, position: 'relative' }}>
        {mentionState && (
          <MentionPopover channel={channel} query={mentionState.query}
                          onPick={acceptMention}
                          onClose={() => setMentionState(null)} />
        )}
        <div style={{
          border: `1.5px solid ${A.paperLine}`, borderRadius: 10,
          background: '#fff', transition: 'border-color 0.15s',
        }}>
          <textarea ref={taRef} value={text} onChange={onChange}
            onKeyDown={(e) => {
              // Let MentionPopover handle Enter/Tab/Arrows when active
              if (mentionState && ['Enter','Tab','ArrowUp','ArrowDown','Escape'].includes(e.key)) return;
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                setText('');
              }
            }}
            placeholder={placeholder || `Message #${channel?.name || 'channel'}  ·  type @ to ping a repo`}
            rows={2}
            style={{
              width: '100%', border: 'none', outline: 'none',
              background: 'transparent', resize: 'none',
              padding: '12px 14px 6px', fontSize: 14,
              fontFamily: 'inherit', color: A.text, lineHeight: 1.5,
            }}
          />
          <div style={{
            padding: '6px 10px 8px', display: 'flex', alignItems: 'center', gap: 6,
            borderTop: `1px solid ${A.paperLine}`,
          }}>
            {aliases.length > 0 && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 5,
                padding: '3px 9px', borderRadius: 14,
                background: A.coralSoft, color: A.coral,
                fontSize: 12, fontWeight: 600,
                border: `1px solid ${A.coral}33`,
                fontFamily: 'ui-monospace, Menlo, monospace',
                flexShrink: 0, whiteSpace: 'nowrap',
              }}>
                → @{targetRepo}
              </div>
            )}
            <div onClick={() => setAutoApprove(!autoApprove)} style={{
              display: 'flex', alignItems: 'center', gap: 5,
              padding: '3px 9px', borderRadius: 14,
              background: autoApprove ? A.mintSoft : A.paperAlt,
              color:      autoApprove ? '#2a7a5a' : A.textMuted,
              fontSize: 12, fontWeight: 500, cursor: 'pointer',
              border: `1px solid ${autoApprove ? '#2a7a5a33' : A.paperLine}`,
              flexShrink: 0, whiteSpace: 'nowrap',
            }}>
              <I.spark />
              <span>{autoApprove ? 'Auto-approve' : 'Auto-approve off'}</span>
            </div>
            <div style={{
              fontSize: 11.5, color: A.textDim, marginLeft: 6,
              flex: 1, minWidth: 0,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              Type <code style={{ fontFamily: 'ui-monospace, Menlo, monospace' }}>@</code> to ping a repo · paste an issue URL to classify
            </div>
            <span style={{ fontSize: 11, color: A.textDim, flexShrink: 0 }}>⌘⏎</span>
            <button disabled={!text.trim()} style={{
              padding: '6px 12px', borderRadius: 6, border: 'none',
              background: text.trim() ? A.coral : A.paperLine,
              color: text.trim() ? '#fff' : A.textMuted,
              fontSize: 13, fontWeight: 600,
              cursor: text.trim() ? 'pointer' : 'not-allowed',
              display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0,
            }}><I.send /> Send</button>
          </div>
        </div>
      </div>
    );
  }

  // ─────────────────────────────────────────────────────────────
  // MAIN APP
  // ─────────────────────────────────────────────────────────────
  function DirectionC({ tweaks, initialNewChannelOpen, initialSettingsOpen, initialStep }) {
    const [selection, setSelection] = useState({ type: 'channel', id: 'oauth-api-users' });
    const [pane, setPane] = useState('chat'); // chat | board | decisions
    const [rightOpen, setRightOpen] = useState(true);
    const [rightTab, setRightTab] = useState('threads');
    const [right, setRight] = useState(null); // opened thread detail in rail
    const [settingsOpen, setSettingsOpen] = useState(!!initialSettingsOpen);
    const [newChanOpen, setNewChanOpen] = useState(!!initialNewChannelOpen);
    // Local channel overrides — let users edit repos/primary in-place.
    // Keyed by channel.id → { repos, primaryRepo }.
    const [channelOverrides, setChannelOverrides] = useState({});
    const avatarStyle = tweaks?.avatarStyle || 'glyph';
    const density = tweaks?.density || 'medium';

    const baseChannel = selection.type === 'channel' ? CHANNELS.find((c) => c.id === selection.id) : null;
    const channel = baseChannel ? { ...baseChannel, ...(channelOverrides[baseChannel.id] || {}) } : null;
    const dm = selection.type === 'dm' ? DMS.find((d) => d.id === selection.id) : null;
    const dmAgent = dm ? agentById(dm.agentId) : null;

    const onChannelChange = (next) => {
      setChannelOverrides((prev) => ({
        ...prev,
        [next.id]: { repos: next.repos, primaryRepo: next.primaryRepo },
      }));
    };

    useEffect(() => { setRight(null); setPane('chat'); }, [selection.type, selection.id]);

    // Auto-open: if channel has a failing PR, default right tab to PRs
    useEffect(() => {
      if (!channel) return;
      const failing = (channel.prs || []).some((p) => p.ci === 'failing');
      const pending = channel.tickets.some((t) => t.status === 'pending' || t.status === 'ready');
      if (failing) setRightTab('prs');
      else if (pending) setRightTab('threads');
    }, [channel?.id]);

    const agents = channel ? channel.agents.map(agentById).filter(Boolean) : [];

    return (
      <div style={{
        width: '100%', height: '100%', display: 'flex',
        background: A.inkDeepest, color: A.text,
        fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", system-ui, sans-serif',
        fontSize: density === 'dense' ? 13 : 14,
      }}>
        <style>{`
          @keyframes c-pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.45 } }
        `}</style>
        <WorkspaceRail current="relay" />
        <Sidebar
          channels={CHANNELS} dms={DMS} activity={ACTIVITY} repos={[]}
          selection={selection} onSelect={setSelection}
          onNewChannel={() => setNewChanOpen(true)}
          onOpenActivity={() => setSelection({ type: 'activity' })}
          avatarStyle={avatarStyle}
        />

        {/* Center pane */}
        {selection.type === 'channel' && channel && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, background: A.paper, position: 'relative' }}>
            <ChannelHeader
              channel={channel} agents={agents}
              pane={pane} onPane={setPane}
              rightOpen={rightOpen} onToggleRight={() => setRightOpen(!rightOpen)}
              counts={{ tickets: channel.tickets.length, decisions: channel.decisions.length }}
              onChannelChange={onChannelChange}
              onOpenSettings={() => setSettingsOpen(true)}
            />
            {pane === 'chat' && (
              <>
                <MessageListC messages={channel.messages} avatarStyle={avatarStyle} channel={channel} />
                <ComposerC channel={channel} />
              </>
            )}
            {pane === 'board' && (
              <BoardView channel={channel}
                        onOpenTicket={(t) => { setRightOpen(true); setRightTab('threads'); setRight({ kind: 'ticket', payload: t }); }}
                        onOpenPr={(pr) => { setRightOpen(true); setRightTab('prs'); setRight({ kind: 'pr', payload: pr }); }} />
            )}
            {pane === 'decisions' && <DecisionsView channel={channel} />}
            {settingsOpen && (
              <ChannelSettingsDrawer channel={channel}
                onClose={() => setSettingsOpen(false)}
                onChange={onChannelChange} />
            )}
          </div>
        )}
        {selection.type === 'dm' && dm && dmAgent && (
          <DmView dm={dm} agent={dmAgent} avatarStyle={avatarStyle}
                  onPromote={() => setNewChanOpen(true)} />
        )}

        {/* Right rail */}
        {rightOpen && channel && (
          <RightRail channel={channel}
                     right={right} setRight={setRight}
                     tab={rightTab} setTab={setRightTab}
                     onClose={() => setRightOpen(false)} />
        )}

        {/* New channel modal */}
        {newChanOpen && (
          <NewChannelModal step={initialStep}
            onClose={() => setNewChanOpen(false)}
            onCreate={() => setNewChanOpen(false)} />
        )}
      </div>
    );
  }

  window.DirectionC = DirectionC;
})();
