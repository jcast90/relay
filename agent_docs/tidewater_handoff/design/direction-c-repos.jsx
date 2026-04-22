/* Direction C — Repos, mentions, channel settings, new-channel modal.
   Shared helpers used by direction-c-tidewater.jsx and the "New channel"
   artboard. Exposes window.RELAY_C_REPOS = { ... }.
*/

(() => {
  const { useState, useEffect, useRef, useMemo } = React;
  const { A, I } = window.RELAY_A;
  const { AVAILABLE_WORKSPACES, AGENTS } = window.RELAY_DATA;

  // ─────────────────────────────────────────────────────────────
  // Mentions + inline markdown (bold, code) → React elements
  // Handles @alias (channel repos), @human, **bold**, `code`.
  // Tokenizes in a single pass so order-of-operations is correct.
  // ─────────────────────────────────────────────────────────────
  const TOKEN_RE = /(@[a-z0-9][a-z0-9_-]*)|(\*\*[^*]+\*\*)|(`[^`]+`)/gi;

  function renderWithMentions(text, channel) {
    if (!text) return null;
    const aliasSet = new Set((channel?.repos || []));
    const out = [];
    let lastIdx = 0;
    let m;
    let key = 0;
    TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(text)) !== null) {
      if (m.index > lastIdx) {
        out.push(<span key={key++}>{text.slice(lastIdx, m.index)}</span>);
      }
      const tok = m[0];
      if (tok.startsWith('**')) {
        out.push(<strong key={key++} style={{ fontWeight: 700 }}>{tok.slice(2, -2)}</strong>);
      } else if (tok.startsWith('`')) {
        out.push(
          <code key={key++} style={{
            background: A.paperAlt, padding: '1px 5px', borderRadius: 3,
            fontSize: '0.9em', fontFamily: 'ui-monospace, Menlo, monospace', color: A.text,
          }}>{tok.slice(1, -1)}</code>
        );
      } else if (tok.startsWith('@')) {
        const handle = tok.slice(1).toLowerCase();
        const isRepo = aliasSet.has(handle);
        const isPrimary = isRepo && channel.primaryRepo === handle;
        if (isRepo) {
          out.push(
            <span key={key++} style={{
              display: 'inline-flex', alignItems: 'center', gap: 3,
              padding: '1px 6px 1px 4px', borderRadius: 3,
              background: isPrimary ? A.coralSoft : '#dce6f5',
              color:      isPrimary ? A.coral    : '#3a5fa0',
              border: `1px solid ${isPrimary ? A.coral + '55' : '#b3c5e0'}`,
              fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
              fontSize: '0.88em', fontWeight: 600,
              lineHeight: 1.3, verticalAlign: 'baseline',
            }}>
              <svg width="9" height="9" viewBox="0 0 12 12" fill="none" aria-hidden>
                <rect x="1.5" y="2" width="9" height="8" rx="1" stroke="currentColor" strokeWidth="1.2"/>
                <path d="M4 5h4M4 7h2.5" stroke="currentColor" strokeWidth="1.2"/>
              </svg>
              {tok}
            </span>
          );
        } else {
          out.push(
            <span key={key++} style={{
              display: 'inline-flex', alignItems: 'center',
              padding: '0 4px', borderRadius: 3,
              background: A.mintSoft, color: '#2a7a5a',
              fontWeight: 600, fontSize: '0.94em',
            }}>{tok}</span>
          );
        }
      }
      lastIdx = m.index + tok.length;
    }
    if (lastIdx < text.length) {
      out.push(<span key={key++}>{text.slice(lastIdx)}</span>);
    }
    return out;
  }

  // ─────────────────────────────────────────────────────────────
  // Floating mention popover (Slack-style, above composer)
  // Renders above its anchor when triggered. Pure-presentational.
  // ─────────────────────────────────────────────────────────────
  function MentionPopover({ channel, query, onPick, onClose, position = 'top' }) {
    const q = query.toLowerCase();
    const repos = (channel?.repos || []).map((alias) => {
      const ws = AVAILABLE_WORKSPACES.find((w) => w.defaultAlias === alias) || { path: `~/code/${alias}` };
      return {
        kind: 'repo', alias, path: ws.path,
        isPrimary: channel.primaryRepo === alias,
      };
    });
    const humans = [
      { kind: 'human', alias: 'jcast',   name: 'You',         avatar: '◉' },
      { kind: 'human', alias: 'channel', name: 'Everyone here', avatar: '#' },
    ];
    const all = [...repos, ...humans].filter((m) => m.alias.toLowerCase().includes(q));
    const [sel, setSel] = useState(0);

    useEffect(() => { setSel(0); }, [query]);
    useEffect(() => {
      const h = (e) => {
        if (e.key === 'Escape') { onClose(); return; }
        if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => (s + 1) % all.length); }
        if (e.key === 'ArrowUp')   { e.preventDefault(); setSel((s) => (s - 1 + all.length) % all.length); }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault(); if (all[sel]) onPick(all[sel]);
        }
      };
      window.addEventListener('keydown', h);
      return () => window.removeEventListener('keydown', h);
    }, [all, sel, onPick, onClose]);

    if (!all.length) return null;

    return (
      <div style={{
        position: 'absolute',
        [position === 'top' ? 'bottom' : 'top']: 'calc(100% + 6px)',
        left: 14, width: 340, maxHeight: 260, overflow: 'auto',
        background: A.paper,
        border: `1px solid ${A.paperLine}`,
        borderRadius: 8,
        boxShadow: '0 -8px 24px rgba(0,0,0,0.08), 0 2px 8px rgba(0,0,0,0.04)',
        zIndex: 100,
      }}>
        <div style={{
          padding: '8px 12px 4px', fontSize: 10.5, fontWeight: 700,
          color: A.textMuted, letterSpacing: '0.04em', textTransform: 'uppercase',
          display: 'flex', justifyContent: 'space-between',
        }}>
          <span>{repos.filter((r) => r.alias.includes(q)).length > 0 ? 'Repos in channel' : 'Members'}</span>
          <span style={{ fontWeight: 500, color: A.textDim, textTransform: 'none', letterSpacing: 0 }}>↑↓ Enter</span>
        </div>
        {all.map((m, i) => (
          <div key={m.alias} onClick={() => onPick(m)} onMouseEnter={() => setSel(i)} style={{
            padding: '7px 12px', cursor: 'pointer',
            display: 'flex', alignItems: 'center', gap: 10,
            background: i === sel ? A.coralSoft : 'transparent',
            color: A.text,
          }}>
            {m.kind === 'repo' ? (
              <>
                <div style={{
                  width: 22, height: 22, borderRadius: 4,
                  background: m.isPrimary ? A.coralSoft : A.paperAlt,
                  color:      m.isPrimary ? A.coral    : A.textMuted,
                  border: `1px solid ${m.isPrimary ? A.coral + '55' : A.paperLine}`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                }}>
                  <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                    <rect x="1.5" y="2" width="9" height="8" rx="1" stroke="currentColor" strokeWidth="1.2"/>
                    <path d="M4 5h4M4 7h2.5" stroke="currentColor" strokeWidth="1.2"/>
                  </svg>
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, fontFamily: 'ui-monospace, Menlo, monospace', display: 'flex', alignItems: 'center', gap: 6 }}>
                    @{m.alias}
                    {m.isPrimary && (
                      <span style={{
                        fontSize: 9, fontWeight: 700, padding: '1px 4px',
                        background: A.coral, color: '#fff', borderRadius: 2,
                        letterSpacing: '0.04em',
                      }}>PRIMARY</span>
                    )}
                  </div>
                  <div style={{ fontSize: 11, color: A.textMuted, fontFamily: 'ui-monospace, Menlo, monospace' }}>{m.path}</div>
                </div>
                <div style={{ fontSize: 10.5, color: A.textDim, fontWeight: 500 }}>
                  agent in repo
                </div>
              </>
            ) : (
              <>
                <div style={{
                  width: 22, height: 22, borderRadius: 4,
                  background: A.mintSoft, color: '#2a7a5a',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 12, fontWeight: 700, flexShrink: 0,
                }}>{m.avatar}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>@{m.alias}</div>
                  <div style={{ fontSize: 11, color: A.textMuted }}>{m.name}</div>
                </div>
              </>
            )}
          </div>
        ))}
      </div>
    );
  }

  // ─────────────────────────────────────────────────────────────
  // Header repo-chip row with inline add / remove / primary swap
  // ─────────────────────────────────────────────────────────────
  function RepoChipRow({ channel, onOpenSettings, onChange, compact }) {
    const [popAnchor, setPopAnchor] = useState(null); // 'add' | alias
    const [hoverAlias, setHoverAlias] = useState(null);
    const rowRef = useRef(null);

    const attached = channel.repos || [];
    const available = AVAILABLE_WORKSPACES.filter((w) => !attached.includes(w.defaultAlias));

    const removeRepo = (alias) => {
      if (alias === channel.primaryRepo) return; // can't remove primary directly
      onChange?.({
        ...channel,
        repos: attached.filter((a) => a !== alias),
      });
      setPopAnchor(null);
    };
    const makePrimary = (alias) => {
      onChange?.({ ...channel, primaryRepo: alias });
      setPopAnchor(null);
    };
    const addRepo = (alias) => {
      if (attached.includes(alias)) return;
      onChange?.({ ...channel, repos: [...attached, alias] });
      setPopAnchor(null);
    };

    return (
      <div ref={rowRef} style={{ position: 'relative', display: 'flex', gap: 4, alignItems: 'center' }}>
        {attached.map((alias) => {
          const isPrimary = alias === channel.primaryRepo;
          const ws = AVAILABLE_WORKSPACES.find((w) => w.defaultAlias === alias);
          const hovered = hoverAlias === alias;
          const popOpen = popAnchor === alias;
          return (
            <div key={alias} style={{ position: 'relative' }}
                 onMouseEnter={() => setHoverAlias(alias)}
                 onMouseLeave={() => setHoverAlias(null)}>
              <button onClick={() => setPopAnchor(popOpen ? null : alias)} style={{
                fontSize: 10.5, fontWeight: 500,
                padding: '2px 6px', borderRadius: 3,
                background: isPrimary ? A.coralSoft : (popOpen || hovered ? A.paperAlt : A.paperAlt),
                color:      isPrimary ? A.coral     : A.textMuted,
                border: `1px solid ${isPrimary ? A.coral + '55' : (hovered || popOpen ? A.textDim : A.paperLine)}`,
                fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
                display: 'flex', alignItems: 'center', gap: 4,
                cursor: 'pointer',
              }}>
                {isPrimary && <span style={{ width: 4, height: 4, borderRadius: '50%', background: A.coral }} />}
                {alias}
                {hovered && !isPrimary && (
                  <span onClick={(e) => { e.stopPropagation(); removeRepo(alias); }} title="Detach repo" style={{
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    width: 12, height: 12, borderRadius: 2, marginLeft: 1,
                    color: A.coral, background: 'transparent',
                    fontSize: 12, lineHeight: 1,
                  }}>×</span>
                )}
              </button>
              {popOpen && (
                <div style={{
                  position: 'absolute', top: 'calc(100% + 4px)', left: 0,
                  width: 260, background: A.paper,
                  border: `1px solid ${A.paperLine}`, borderRadius: 6,
                  boxShadow: '0 6px 18px rgba(0,0,0,0.08)',
                  zIndex: 50,
                }}>
                  <div style={{ padding: '10px 12px 8px', borderBottom: `1px solid ${A.paperLine}` }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: A.text, fontFamily: 'ui-monospace, Menlo, monospace', display: 'flex', alignItems: 'center', gap: 6 }}>
                      @{alias}
                      {isPrimary && <span style={{
                        fontSize: 9, fontWeight: 700, padding: '1px 4px',
                        background: A.coral, color: '#fff', borderRadius: 2, letterSpacing: '0.04em',
                      }}>PRIMARY</span>}
                    </div>
                    <div style={{ fontSize: 11.5, color: A.textMuted, fontFamily: 'ui-monospace, Menlo, monospace', marginTop: 2 }}>
                      {ws?.path || `~/code/${alias}`}
                    </div>
                  </div>
                  <div style={{ padding: 6 }}>
                    {!isPrimary && (
                      <PopItem onClick={() => makePrimary(alias)} icon="✓">Set as primary</PopItem>
                    )}
                    <PopItem onClick={() => {}} icon="⇱">Open agent terminal</PopItem>
                    <PopItem onClick={() => {}} icon="⎈">View in repo settings</PopItem>
                    <div style={{ height: 1, background: A.paperLine, margin: '4px 0' }} />
                    {isPrimary ? (
                      <PopItem disabled hint="Promote another repo first" icon="—">Detach</PopItem>
                    ) : (
                      <PopItem onClick={() => removeRepo(alias)} icon="×" danger>Detach from channel</PopItem>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {/* Add chip */}
        <div style={{ position: 'relative' }}>
          <button onClick={() => setPopAnchor(popAnchor === 'add' ? null : 'add')} title="Attach repo" style={{
            fontSize: 11, fontWeight: 600,
            width: 20, height: 20, borderRadius: 3,
            background: popAnchor === 'add' ? A.coralSoft : 'transparent',
            color:      popAnchor === 'add' ? A.coral    : A.textMuted,
            border: `1px dashed ${popAnchor === 'add' ? A.coral : A.paperLine}`,
            cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 0,
          }}>+</button>
          {popAnchor === 'add' && (
            <AddRepoPopover available={available} attachedCount={attached.length}
                            onPick={addRepo} onClose={() => setPopAnchor(null)} />
          )}
        </div>

        {/* Gear → settings drawer */}
        <button onClick={onOpenSettings} title="Channel settings" style={{
          marginLeft: 2,
          width: 22, height: 22, borderRadius: 3,
          background: 'transparent', color: A.textDim,
          border: 'none', cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
            <path d="M7 4.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5z" stroke="currentColor" strokeWidth="1.1"/>
            <path d="M11.5 7c0-.3-.04-.6-.1-.88l1.1-.86-1-1.72-1.3.5a4.2 4.2 0 00-1.52-.88l-.2-1.38H6.52l-.2 1.38a4.2 4.2 0 00-1.52.88l-1.3-.5-1 1.72 1.1.86A4.3 4.3 0 002.5 7c0 .3.04.6.1.88l-1.1.86 1 1.72 1.3-.5c.45.36.97.67 1.52.88l.2 1.38h1.96l.2-1.38a4.2 4.2 0 001.52-.88l1.3.5 1-1.72-1.1-.86c.06-.28.1-.58.1-.88z" stroke="currentColor" strokeWidth="1.1"/>
          </svg>
        </button>
      </div>
    );
  }

  function PopItem({ children, icon, onClick, danger, disabled, hint }) {
    return (
      <button onClick={disabled ? undefined : onClick} disabled={disabled} style={{
        width: '100%', textAlign: 'left',
        padding: '6px 10px', borderRadius: 4,
        background: 'transparent', border: 'none',
        color: disabled ? A.textDim : (danger ? '#a43c32' : A.text),
        fontSize: 12.5, fontFamily: 'inherit',
        display: 'flex', alignItems: 'center', gap: 8,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.65 : 1,
      }}
      onMouseEnter={(e) => { if (!disabled) e.currentTarget.style.background = A.paperAlt; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
      >
        <span style={{ width: 14, textAlign: 'center', color: danger ? '#a43c32' : A.textMuted, fontWeight: 600 }}>{icon}</span>
        <span style={{ flex: 1 }}>{children}</span>
        {hint && <span style={{ fontSize: 10.5, color: A.textDim }}>{hint}</span>}
      </button>
    );
  }

  function AddRepoPopover({ available, attachedCount, onPick, onClose }) {
    const [query, setQuery] = useState('');
    const filtered = available.filter((w) =>
      w.defaultAlias.includes(query.toLowerCase()) ||
      w.path.includes(query.toLowerCase())
    );
    return (
      <div style={{
        position: 'absolute', top: 'calc(100% + 4px)', right: 0,
        width: 300, background: A.paper,
        border: `1px solid ${A.paperLine}`, borderRadius: 6,
        boxShadow: '0 6px 18px rgba(0,0,0,0.08)',
        zIndex: 50,
      }}>
        <div style={{ padding: '10px 12px 8px', borderBottom: `1px solid ${A.paperLine}` }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: A.textMuted, letterSpacing: '0.04em', textTransform: 'uppercase', marginBottom: 4 }}>
            Attach a workspace · {attachedCount} already attached
          </div>
          <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder="Search registered workspaces..."
            style={{
              width: '100%', padding: '5px 8px', borderRadius: 4,
              border: `1px solid ${A.paperLine}`, background: A.paperAlt,
              fontSize: 12.5, color: A.text, outline: 'none', fontFamily: 'inherit',
            }} />
        </div>
        <div style={{ maxHeight: 220, overflow: 'auto', padding: 4 }}>
          {filtered.length === 0 ? (
            <div style={{ padding: '16px 12px', fontSize: 12, color: A.textMuted, textAlign: 'center' }}>
              {available.length === 0 ? 'All registered workspaces are attached.' : 'No matches.'}
            </div>
          ) : (
            filtered.map((w) => (
              <button key={w.workspaceId} onClick={() => onPick(w.defaultAlias)} style={{
                width: '100%', textAlign: 'left',
                padding: '7px 10px', borderRadius: 4,
                background: 'transparent', border: 'none', cursor: 'pointer',
                display: 'flex', alignItems: 'center', gap: 10,
                fontFamily: 'inherit',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = A.paperAlt; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              >
                <div style={{
                  width: 22, height: 22, borderRadius: 4,
                  background: A.paperAlt, color: A.textMuted,
                  border: `1px solid ${A.paperLine}`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                }}>
                  <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                    <rect x="1.5" y="2" width="9" height="8" rx="1" stroke="currentColor" strokeWidth="1.2"/>
                    <path d="M4 5h4M4 7h2.5" stroke="currentColor" strokeWidth="1.2"/>
                  </svg>
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600, color: A.text, fontFamily: 'ui-monospace, Menlo, monospace' }}>@{w.defaultAlias}</div>
                  <div style={{ fontSize: 11, color: A.textMuted, fontFamily: 'ui-monospace, Menlo, monospace',
                                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{w.path}</div>
                </div>
                <div style={{ fontSize: 10.5, color: A.textDim, textAlign: 'right' }}>
                  <div>{w.lastActive}</div>
                  {w.openPrs > 0 && <div>{w.openPrs} PR</div>}
                </div>
              </button>
            ))
          )}
        </div>
      </div>
    );
  }

  // ─────────────────────────────────────────────────────────────
  // Channel settings drawer (right-side slide-over)
  // ─────────────────────────────────────────────────────────────
  function ChannelSettingsDrawer({ channel, onClose, onChange }) {
    const [tab, setTab] = useState('repos');
    const attached = channel.repos || [];
    const available = AVAILABLE_WORKSPACES.filter((w) => !attached.includes(w.defaultAlias));

    return (
      <>
        <div onClick={onClose} style={{
          position: 'absolute', inset: 0,
          background: 'rgba(20,22,26,0.32)', zIndex: 200,
        }} />
        <aside style={{
          position: 'absolute', top: 0, right: 0, bottom: 0, width: 460,
          background: A.paper, boxShadow: '-16px 0 48px rgba(0,0,0,0.15)',
          zIndex: 201, display: 'flex', flexDirection: 'column',
          minHeight: 0,
        }}>
          <div style={{
            padding: '14px 18px', borderBottom: `1px solid ${A.paperLine}`,
            display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0,
          }}>
            <I.hash style={{ color: A.textMuted }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: A.text }}>{channel.name}</div>
              <div style={{ fontSize: 12, color: A.textMuted }}>Channel settings</div>
            </div>
            <button onClick={onClose} style={{
              width: 28, height: 28, borderRadius: 5,
              background: 'none', border: 'none', cursor: 'pointer',
              color: A.textMuted,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}><I.close /></button>
          </div>
          <div style={{ display: 'flex', gap: 2, padding: '0 18px', borderBottom: `1px solid ${A.paperLine}`, flexShrink: 0 }}>
            {['repos', 'members', 'about'].map((t) => (
              <button key={t} onClick={() => setTab(t)} style={{
                padding: '9px 10px', background: 'transparent', border: 'none',
                color: tab === t ? A.text : A.textMuted,
                fontSize: 12.5, fontWeight: tab === t ? 600 : 500,
                borderBottom: `2px solid ${tab === t ? A.coral : 'transparent'}`,
                cursor: 'pointer', marginBottom: -1,
                fontFamily: 'inherit', textTransform: 'capitalize',
              }}>{t}</button>
            ))}
          </div>
          <div style={{ flex: 1, overflow: 'auto', padding: '18px 20px' }}>
            {tab === 'repos' && (
              <>
                <SectionHeader title="Attached repos" count={attached.length}
                               hint="Each attached repo becomes a pingable @alias. The primary repo hosts the main channel agent." />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 20 }}>
                  {attached.map((alias) => {
                    const ws = AVAILABLE_WORKSPACES.find((w) => w.defaultAlias === alias);
                    const isPrimary = alias === channel.primaryRepo;
                    return (
                      <div key={alias} style={{
                        border: `1px solid ${isPrimary ? A.coral + '66' : A.paperLine}`,
                        borderRadius: 6, padding: 10, background: isPrimary ? A.coralSoft + '55' : A.paper,
                        display: 'flex', alignItems: 'center', gap: 10,
                      }}>
                        <div style={{
                          width: 30, height: 30, borderRadius: 5,
                          background: isPrimary ? A.coral : A.paperAlt,
                          color: isPrimary ? '#fff' : A.textMuted,
                          border: isPrimary ? 'none' : `1px solid ${A.paperLine}`,
                          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                        }}>
                          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                            <rect x="2" y="2.5" width="10" height="9" rx="1" stroke="currentColor" strokeWidth="1.3"/>
                            <path d="M4.5 5.5h5M4.5 8h3" stroke="currentColor" strokeWidth="1.3"/>
                          </svg>
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13.5, fontWeight: 600, fontFamily: 'ui-monospace, Menlo, monospace', display: 'flex', alignItems: 'center', gap: 6 }}>
                            @{alias}
                            {isPrimary && <span style={{
                              fontSize: 9, fontWeight: 700, padding: '1px 5px',
                              background: A.coral, color: '#fff', borderRadius: 2, letterSpacing: '0.04em',
                            }}>PRIMARY</span>}
                          </div>
                          <div style={{ fontSize: 11.5, color: A.textMuted, fontFamily: 'ui-monospace, Menlo, monospace' }}>
                            {ws?.path || `~/code/${alias}`}
                          </div>
                        </div>
                        <div style={{ display: 'flex', gap: 4 }}>
                          {!isPrimary && (
                            <button onClick={() => onChange?.({ ...channel, primaryRepo: alias })} style={chipBtn(false)}>
                              Make primary
                            </button>
                          )}
                          {!isPrimary && (
                            <button onClick={() => onChange?.({ ...channel, repos: attached.filter((a) => a !== alias) })}
                              style={chipBtn(true)}>Detach</button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <SectionHeader title="Available workspaces" count={available.length}
                               hint="Registered via `rly up`. Attach to make pingable in this channel." />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {available.map((w) => (
                    <div key={w.workspaceId} style={{
                      border: `1px solid ${A.paperLine}`, borderRadius: 6, padding: 9,
                      display: 'flex', alignItems: 'center', gap: 10,
                    }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12.5, fontWeight: 600, fontFamily: 'ui-monospace, Menlo, monospace', color: A.text }}>@{w.defaultAlias}</div>
                        <div style={{ fontSize: 11, color: A.textMuted, fontFamily: 'ui-monospace, Menlo, monospace' }}>{w.path}</div>
                      </div>
                      <button onClick={() => onChange?.({ ...channel, repos: [...attached, w.defaultAlias] })}
                        style={{
                          padding: '4px 10px', borderRadius: 4,
                          background: A.coral, color: '#fff', border: 'none',
                          fontSize: 11.5, fontWeight: 600, cursor: 'pointer',
                          fontFamily: 'inherit',
                        }}>Attach</button>
                    </div>
                  ))}
                  {available.length === 0 && (
                    <div style={{ fontSize: 12, color: A.textMuted, textAlign: 'center', padding: 20 }}>
                      All registered workspaces are already attached. Run <code style={{ fontFamily: 'ui-monospace, Menlo, monospace', background: A.paperAlt, padding: '1px 5px', borderRadius: 3 }}>rly up</code> in a new repo to register more.
                    </div>
                  )}
                </div>
              </>
            )}
            {tab === 'members' && (
              <div style={{ fontSize: 13, color: A.textMuted, lineHeight: 1.6 }}>
                Human members are inferred from who's pinged or posted. The channel's agent roster is derived from attached repos — see the <strong style={{ color: A.text }}>Repos</strong> tab.
              </div>
            )}
            {tab === 'about' && (
              <div>
                <SectionHeader title="Topic" />
                <div style={{ fontSize: 13, color: A.text, padding: '8px 0 16px', lineHeight: 1.55 }}>{channel.topic}</div>
                <SectionHeader title="Classification" />
                <div style={{ fontSize: 13, color: A.text, padding: '8px 0 16px' }}>{channel.tier.replace('_',' ')}</div>
                <SectionHeader title="Created" />
                <div style={{ fontSize: 13, color: A.text, padding: '8px 0' }}>Inferred from first message · {channel.activeAt} ago</div>
              </div>
            )}
          </div>
        </aside>
      </>
    );
  }

  function chipBtn(danger) {
    return {
      padding: '3px 8px', borderRadius: 4,
      background: 'transparent', color: danger ? '#a43c32' : A.text,
      border: `1px solid ${danger ? '#a43c3255' : A.paperLine}`,
      fontSize: 11, fontWeight: 500, cursor: 'pointer',
      fontFamily: 'inherit',
    };
  }

  function SectionHeader({ title, count, hint }) {
    return (
      <div style={{ marginBottom: 8 }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6,
          fontSize: 10.5, fontWeight: 700, color: A.textMuted,
          letterSpacing: '0.05em', textTransform: 'uppercase',
        }}>
          <span>{title}</span>
          {count != null && <span style={{ color: A.textDim, fontWeight: 500 }}>· {count}</span>}
        </div>
        {hint && <div style={{ fontSize: 11.5, color: A.textMuted, marginTop: 3, lineHeight: 1.5 }}>{hint}</div>}
      </div>
    );
  }

  // ─────────────────────────────────────────────────────────────
  // NEW CHANNEL MODAL (multi-step)
  // Steps: 1. Name + topic  2. Repos + primary  3. First message
  // ─────────────────────────────────────────────────────────────
  function NewChannelModal({ initial = {}, onClose, onCreate, step: stepProp }) {
    const [step, setStep] = useState(stepProp || 1);
    const [name, setName] = useState(initial.name || '');
    const [topic, setTopic] = useState(initial.topic || '');
    const [selected, setSelected] = useState(new Map(
      (initial.repos || []).map((a) => [a, { alias: a, spawn: false }])
    )); // workspaceId -> { alias, spawn }
    const [primary, setPrimary] = useState(initial.primary || null);
    const [firstMsg, setFirstMsg] = useState(initial.firstMsg || '');
    const [filter, setFilter] = useState('');

    // Infer default channel name from topic if blank
    const slug = name.trim() || (topic ? topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g,'').slice(0, 28) : '');

    const toggle = (w) => {
      setSelected((prev) => {
        const next = new Map(prev);
        if (next.has(w.workspaceId)) {
          next.delete(w.workspaceId);
          if (primary === w.workspaceId) {
            const first = [...next.keys()][0] || null;
            setPrimary(first);
          }
        } else {
          next.set(w.workspaceId, { alias: w.defaultAlias, spawn: false });
          if (!primary) setPrimary(w.workspaceId);
        }
        return next;
      });
    };

    const filteredWorkspaces = AVAILABLE_WORKSPACES.filter((w) =>
      !filter || w.defaultAlias.includes(filter.toLowerCase()) || w.path.includes(filter.toLowerCase())
    );

    const canNext = step === 1 ? slug.length > 0 : step === 2 ? selected.size > 0 && primary : true;
    const canCreate = slug && selected.size > 0 && primary;

    return (
      <div style={{
        position: 'absolute', inset: 0,
        background: 'rgba(20,22,26,0.5)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 300, padding: 40,
      }} onClick={onClose}>
        <div onClick={(e) => e.stopPropagation()} style={{
          width: 640, maxHeight: '85%',
          background: A.paper, borderRadius: 12,
          boxShadow: '0 24px 80px rgba(0,0,0,0.2)',
          display: 'flex', flexDirection: 'column',
          overflow: 'hidden',
        }}>
          {/* Header */}
          <div style={{
            padding: '16px 22px 12px', borderBottom: `1px solid ${A.paperLine}`,
            display: 'flex', alignItems: 'center', gap: 12,
          }}>
            <div style={{
              width: 34, height: 34, borderRadius: 8,
              background: A.coral, color: '#fff',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 18, fontWeight: 700,
            }}>#</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: A.text }}>New channel</div>
              <div style={{ fontSize: 12, color: A.textMuted }}>Attach repos, set a primary, kick off with a first message.</div>
            </div>
            <button onClick={onClose} style={{
              width: 28, height: 28, borderRadius: 5,
              background: 'none', border: 'none', cursor: 'pointer', color: A.textMuted,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}><I.close /></button>
          </div>

          {/* Stepper */}
          <div style={{
            padding: '10px 22px', display: 'flex', gap: 6, alignItems: 'center',
            borderBottom: `1px solid ${A.paperLine}`,
            fontSize: 12,
          }}>
            {[
              { n: 1, label: 'Basics' },
              { n: 2, label: 'Repos' },
              { n: 3, label: 'Kick off' },
            ].map((s, i, arr) => (
              <React.Fragment key={s.n}>
                <div onClick={() => setStep(s.n)} style={{
                  display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer',
                  color: step === s.n ? A.text : A.textMuted,
                  fontWeight: step === s.n ? 600 : 500,
                }}>
                  <span style={{
                    width: 18, height: 18, borderRadius: '50%',
                    background: step >= s.n ? A.coral : A.paperAlt,
                    color:      step >= s.n ? '#fff'  : A.textMuted,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 10.5, fontWeight: 700,
                    border: step === s.n ? `2px solid ${A.coral}55` : 'none',
                    boxSizing: step === s.n ? 'content-box' : 'border-box',
                  }}>{step > s.n ? '✓' : s.n}</span>
                  {s.label}
                </div>
                {i < arr.length - 1 && (
                  <div style={{ flex: 1, height: 1, background: step > s.n ? A.coral : A.paperLine }} />
                )}
              </React.Fragment>
            ))}
          </div>

          {/* Body */}
          <div style={{ flex: 1, overflow: 'auto', padding: '20px 22px' }}>
            {step === 1 && (
              <div>
                <Field label="Channel name">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{
                      width: 24, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center',
                      color: A.textMuted, fontSize: 16,
                    }}>#</span>
                    <input autoFocus value={name} onChange={(e) => setName(e.target.value.replace(/\s+/g, '-').toLowerCase())}
                      placeholder="e.g. oauth-api-users" style={inputStyle()} />
                  </div>
                  <FieldHint>Lowercase, dashes for spaces. Shown in the sidebar as <code style={{ fontFamily: 'ui-monospace, Menlo, monospace' }}>#{slug || 'your-channel'}</code>.</FieldHint>
                </Field>
                <Field label="Topic (optional)">
                  <input value={topic} onChange={(e) => setTopic(e.target.value)}
                    placeholder="What's this channel for?" style={inputStyle()} />
                </Field>
                <Field label="Tier">
                  <div style={{ fontSize: 12.5, color: A.textMuted, lineHeight: 1.55 }}>
                    Classified automatically from your first message. You can override later.
                  </div>
                </Field>
              </div>
            )}
            {step === 2 && (
              <div>
                <div style={{ fontSize: 12, color: A.textMuted, marginBottom: 8, lineHeight: 1.55 }}>
                  Pick the repos this channel spans. Each attached repo becomes a pingable <code style={{ fontFamily: 'ui-monospace, Menlo, monospace' }}>@alias</code>. The <strong style={{ color: A.coral }}>primary</strong> repo hosts the main channel agent.
                </div>
                <input value={filter} onChange={(e) => setFilter(e.target.value)}
                  placeholder="Filter by path or alias..."
                  style={{ ...inputStyle(), marginBottom: 10 }} />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 340, overflow: 'auto' }}>
                  {filteredWorkspaces.map((w) => {
                    const isSel = selected.has(w.workspaceId);
                    const isPrimary = primary === w.workspaceId;
                    return (
                      <div key={w.workspaceId} onClick={() => toggle(w)} style={{
                        padding: 10, borderRadius: 6,
                        background: isSel ? A.coralSoft + '88' : A.paperAlt,
                        border: `1px solid ${isPrimary ? A.coral : (isSel ? A.coral + '55' : A.paperLine)}`,
                        display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer',
                      }}>
                        <input type="checkbox" checked={isSel} readOnly style={{ accentColor: A.coral }} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 600, fontFamily: 'ui-monospace, Menlo, monospace', color: A.text, display: 'flex', alignItems: 'center', gap: 6 }}>
                            @{w.defaultAlias}
                            {isPrimary && <span style={{
                              fontSize: 9, fontWeight: 700, padding: '1px 5px',
                              background: A.coral, color: '#fff', borderRadius: 2, letterSpacing: '0.04em',
                            }}>PRIMARY</span>}
                          </div>
                          <div style={{ fontSize: 11, color: A.textMuted, fontFamily: 'ui-monospace, Menlo, monospace' }}>{w.path}</div>
                        </div>
                        {isSel && (
                          <label onClick={(e) => e.stopPropagation()} style={{
                            display: 'flex', alignItems: 'center', gap: 4,
                            fontSize: 11.5, color: isPrimary ? A.coral : A.textMuted,
                            cursor: 'pointer', fontWeight: 500,
                          }}>
                            <input type="radio" name="primary" checked={isPrimary}
                              onChange={() => setPrimary(w.workspaceId)}
                              style={{ accentColor: A.coral }} />
                            primary
                          </label>
                        )}
                      </div>
                    );
                  })}
                </div>
                <div style={{ fontSize: 11.5, color: A.textDim, marginTop: 10, padding: '8px 10px', background: A.paperAlt, borderRadius: 5, lineHeight: 1.55 }}>
                  <strong style={{ color: A.textMuted }}>Don't see your repo?</strong> Run <code style={{ fontFamily: 'ui-monospace, Menlo, monospace' }}>rly up</code> in its directory to register it, then come back.
                </div>
              </div>
            )}
            {step === 3 && (
              <div>
                <div style={{ fontSize: 12, color: A.textMuted, marginBottom: 12, lineHeight: 1.55 }}>
                  First message goes straight to the primary agent <strong style={{ color: A.coral, fontFamily: 'ui-monospace, Menlo, monospace' }}>@{selected.get(primary)?.alias}</strong>. Paste an issue URL, describe a feature, or ask a question — Relay classifies and either plans tickets or answers directly.
                </div>
                <Field label="First message">
                  <textarea autoFocus value={firstMsg} onChange={(e) => setFirstMsg(e.target.value)}
                    placeholder={`e.g. "Add OAuth2 to /api/users — github and google to start." or paste an issue URL...`}
                    rows={6} style={{
                      ...inputStyle(), resize: 'vertical', padding: 10,
                      fontFamily: 'inherit', lineHeight: 1.5,
                    }} />
                  <FieldHint>
                    You can also type <code style={{ fontFamily: 'ui-monospace, Menlo, monospace' }}>@</code> to ping another attached repo in the same turn.
                  </FieldHint>
                </Field>
                <div style={{
                  padding: 10, background: A.paperAlt, borderRadius: 6,
                  fontSize: 12, color: A.textMuted, lineHeight: 1.55, marginTop: 10,
                }}>
                  <div style={{ fontSize: 10.5, fontWeight: 700, color: A.textMuted, letterSpacing: '0.04em', textTransform: 'uppercase', marginBottom: 6 }}>Summary</div>
                  <div>Channel: <code style={{ fontFamily: 'ui-monospace, Menlo, monospace', color: A.text }}>#{slug}</code></div>
                  <div>Repos: {[...selected.values()].map((r, i) =>
                    <React.Fragment key={r.alias}>{i > 0 && ', '}<code style={{ fontFamily: 'ui-monospace, Menlo, monospace', color: primary && selected.get(primary)?.alias === r.alias ? A.coral : A.text }}>@{r.alias}</code></React.Fragment>
                  )}</div>
                </div>
              </div>
            )}
          </div>

          {/* Footer */}
          <div style={{
            padding: '12px 22px', borderTop: `1px solid ${A.paperLine}`,
            display: 'flex', gap: 8, alignItems: 'center',
            background: A.paperAlt,
          }}>
            {step > 1 ? (
              <button onClick={() => setStep(step - 1)} style={{
                padding: '8px 14px', borderRadius: 5,
                background: 'transparent', color: A.textMuted,
                border: `1px solid ${A.paperLine}`,
                fontSize: 12.5, fontWeight: 500, cursor: 'pointer',
                fontFamily: 'inherit',
              }}>← Back</button>
            ) : <div />}
            <div style={{ flex: 1 }} />
            <div style={{ fontSize: 11.5, color: A.textDim }}>
              You can also: <code style={{ fontFamily: 'ui-monospace, Menlo, monospace' }}>/new #{slug || 'name'} {[...selected.values()].map((r) => r.alias).join(',') || 'repo1,repo2'}</code>
            </div>
            {step < 3 ? (
              <button onClick={() => canNext && setStep(step + 1)} disabled={!canNext} style={{
                padding: '8px 16px', borderRadius: 5,
                background: canNext ? A.coral : A.paperAlt,
                color: canNext ? '#fff' : A.textDim,
                border: 'none', fontSize: 12.5, fontWeight: 600,
                cursor: canNext ? 'pointer' : 'not-allowed',
                fontFamily: 'inherit',
              }}>Next →</button>
            ) : (
              <button onClick={() => canCreate && onCreate({ name: slug, topic, primary, selected, firstMsg })}
                disabled={!canCreate} style={{
                padding: '8px 16px', borderRadius: 5,
                background: canCreate ? A.coral : A.paperAlt,
                color: canCreate ? '#fff' : A.textDim,
                border: 'none', fontSize: 12.5, fontWeight: 600,
                cursor: canCreate ? 'pointer' : 'not-allowed',
                fontFamily: 'inherit',
              }}>Create & post</button>
            )}
          </div>
        </div>
      </div>
    );
  }

  function Field({ label, children }) {
    return (
      <div style={{ marginBottom: 16 }}>
        <div style={{
          fontSize: 10.5, fontWeight: 700, color: A.textMuted,
          letterSpacing: '0.05em', textTransform: 'uppercase',
          marginBottom: 5,
        }}>{label}</div>
        {children}
      </div>
    );
  }
  function FieldHint({ children }) {
    return <div style={{ fontSize: 11.5, color: A.textDim, marginTop: 5, lineHeight: 1.5 }}>{children}</div>;
  }
  function inputStyle() {
    return {
      width: '100%', padding: '7px 10px', borderRadius: 5,
      border: `1px solid ${A.paperLine}`, background: A.paper,
      fontSize: 13, color: A.text, outline: 'none',
      fontFamily: 'inherit',
    };
  }

  window.RELAY_C_REPOS = {
    RepoChipRow,
    ChannelSettingsDrawer,
    NewChannelModal,
    MentionPopover,
    renderWithMentions,
  };
})();
