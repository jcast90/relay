/* Direction A — Chat feed, composer, right-pane threads */

const { A, I, Avatar, agentColor } = window.RELAY_A;
// ─────────────────────────────────────────────────────────────
// Message list — Slack style, but denser when author repeats
// ─────────────────────────────────────────────────────────────
function MessageList({ messages, avatarStyle, onOpenThread }) {
  if (!messages || messages.length === 0) {
    return (
      <div style={{
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: A.textDim, fontSize: 13,
      }}>No messages yet — say something to kick off.</div>
    );
  }
  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '16px 0 8px' }}>
      {messages.map((m, i) => {
        const prev = messages[i - 1];
        const samePrev = prev && prev.author === m.author && prev.kind === m.kind;
        return <Message key={m.id} m={m} compact={samePrev} avatarStyle={avatarStyle} onOpenThread={onOpenThread} />;
      })}
    </div>
  );
}

function Message({ m, compact, avatarStyle, onOpenThread }) {
  const agent = m.kind === 'assistant' || m.kind === 'crosslink'
    ? AGENTS.find((a) => a.id === m.author) : null;
  const isSystem = m.kind === 'system';
  const isUser = m.kind === 'user';

  if (isSystem) {
    return (
      <div style={{
        padding: '6px 24px', fontSize: 12.5, color: A.textMuted,
        display: 'flex', alignItems: 'center', gap: 10,
      }}>
        <div style={{ flex: 1, height: 1, background: A.paperLine }} />
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <I.spark style={{ color: A.coral }} />
          <span dangerouslySetInnerHTML={{ __html: markdownMini(m.text) }} />
          <span style={{ color: A.textDim }}>· {m.time}</span>
        </span>
        <div style={{ flex: 1, height: 1, background: A.paperLine }} />
      </div>
    );
  }

  // Activity-only message (no text) — show inline tool-use preview card
  if (m.activity && !m.text) {
    const steps = m.activity.split(' · ');
    return (
      <div style={{ padding: compact ? '2px 24px 2px 70px' : '6px 24px 6px 24px', display: 'flex', gap: 12 }}>
        {!compact && agent && <Avatar agent={agent} size={34} style={avatarStyle} />}
        {compact && <div style={{ width: 34 }} />}
        <div style={{ flex: 1, minWidth: 0 }}>
          {!compact && agent && (
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 3 }}>
              <span style={{ fontWeight: 700, fontSize: 14, color: A.text }}>{agent.name}</span>
              <span style={{ fontSize: 11, color: A.textDim }}>{m.time}</span>
            </div>
          )}
          <div style={{
            background: A.paperAlt, border: `1px solid ${A.paperLine}`,
            borderRadius: 8, padding: '8px 12px',
            display: 'flex', flexDirection: 'column', gap: 4,
            borderLeft: `3px solid ${A.amber}`,
          }}>
            <div style={{
              fontSize: 11, fontWeight: 600, color: A.amber,
              letterSpacing: '0.04em', textTransform: 'uppercase',
              display: 'flex', alignItems: 'center', gap: 6,
            }}>
              <span style={{
                width: 6, height: 6, borderRadius: '50%', background: A.amber,
                animation: 'relay-pulse 1.4s ease-in-out infinite',
              }} />
              working · {steps.length} action{steps.length === 1 ? '' : 's'}
            </div>
            {steps.slice(-3).map((s, i) => (
              <div key={i} style={{
                fontSize: 12.5, color: i === steps.slice(-3).length - 1 ? A.text : A.textMuted,
                fontFamily: 'ui-monospace, Menlo, monospace',
                display: 'flex', gap: 8,
              }}>
                <span style={{ color: A.textDim }}>⚙</span>
                <span>{s}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{
      padding: compact ? '2px 24px 2px 24px' : '6px 24px 6px 24px',
      display: 'flex', gap: 12,
      transition: 'background 0.1s',
    }}
    onMouseEnter={(e) => e.currentTarget.style.background = A.paperAlt}
    onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
    >
      {!compact ? (
        isUser ? <UserAvatar /> : <Avatar agent={agent} size={34} style={avatarStyle} />
      ) : (
        <div style={{ width: 34, fontSize: 10, color: A.textDim, textAlign: 'right', paddingTop: 4 }}>
          {m.time}
        </div>
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        {!compact && (
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 2 }}>
            <span style={{ fontWeight: 700, fontSize: 14.5, color: A.text }}>
              {isUser ? 'jcast' : (agent?.name || m.author)}
            </span>
            {m.kind === 'crosslink' && (
              <span style={{
                fontSize: 10, fontWeight: 600, padding: '1px 5px', borderRadius: 3,
                background: A.coralSoft, color: A.coral, letterSpacing: '0.03em',
              }}>CROSSLINK</span>
            )}
            {agent && !isUser && (
              <span style={{
                fontSize: 10, padding: '1px 5px', borderRadius: 3,
                background: agent.provider === 'claude' ? '#e9deff' : '#d8e9d4',
                color: agent.provider === 'claude' ? '#624caa' : '#3a6a2e',
                fontWeight: 600, letterSpacing: '0.02em',
              }}>{agent.provider}</span>
            )}
            <span style={{ fontSize: 11, color: A.textDim }}>{m.time}</span>
          </div>
        )}
        <div style={{ fontSize: 14.5, color: A.text, lineHeight: 1.5 }}
             dangerouslySetInnerHTML={{ __html: markdownMini(m.text) }} />
      </div>
    </div>
  );
}

function UserAvatar() {
  return (
    <div style={{
      width: 34, height: 34, borderRadius: 7,
      background: `linear-gradient(135deg, ${A.inkRaised}, ${A.inkDeep})`,
      color: '#fff', fontWeight: 600, fontSize: 13,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexShrink: 0,
    }}>jc</div>
  );
}

// very light markdown: **bold**, `code`, @mentions, URLs
function markdownMini(s) {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/`([^`]+)`/g, `<code style="background:${A.paperAlt};padding:1px 5px;border-radius:3px;font-size:0.9em;font-family:ui-monospace,Menlo,monospace;color:${A.text}">$1</code>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong style="font-weight:700">$1</strong>')
    .replace(/@([a-zA-Z0-9_-]+)/g, `<span style="color:${A.coral};background:${A.coralSoft};padding:1px 4px;border-radius:3px;font-weight:600">@$1</span>`)
    .replace(/(https?:\/\/[^\s]+)/g, `<a href="$1" style="color:${A.sky};text-decoration:underline">$1</a>`);
}

// ─────────────────────────────────────────────────────────────
// Composer
// ─────────────────────────────────────────────────────────────
function Composer({ channel, onSend, placeholder }) {
  const [text, setText] = useState('');
  const [autoApprove, setAutoApprove] = useState(true);
  const [targetRepo, setTargetRepo] = useState(channel?.primaryRepo || channel?.repos?.[0]);
  const aliases = channel?.repos || [];

  const submit = () => {
    if (!text.trim()) return;
    onSend?.({ text, targetRepo, autoApprove });
    setText('');
  };

  return (
    <div style={{
      padding: '0 18px 16px 20px', flexShrink: 0,
      background: A.paper,
    }}>
      <div style={{
        border: `1.5px solid ${A.paperLine}`, borderRadius: 10,
        background: '#fff', transition: 'border-color 0.15s',
      }}
      onFocus={(e) => e.currentTarget.style.borderColor = A.coral}
      onBlur={(e) => e.currentTarget.style.borderColor = A.paperLine}
      >
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
          }}
          placeholder={placeholder || `Message #${channel?.name || 'channel'}`}
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
            <ComposerChip label={`@${targetRepo}`} icon={<I.at />}>
              <select value={targetRepo} onChange={(e) => setTargetRepo(e.target.value)} style={selectStyle}>
                {aliases.map((a) => <option key={a} value={a}>{`@${a}`}</option>)}
              </select>
            </ComposerChip>
          )}
          <ComposerChip icon={<I.spark />}
            label={autoApprove ? 'Auto-approve on' : 'Auto-approve off'}
            tone={autoApprove ? 'coral' : 'muted'}
            onClick={() => setAutoApprove(!autoApprove)}
          />
          <div style={{ fontSize: 11.5, color: A.textDim, marginLeft: 6 }}>
            Tip: paste a GitHub issue or Linear URL — Relay classifies it automatically
          </div>
          <div style={{ flex: 1 }} />
          <span style={{ fontSize: 11, color: A.textDim }}>⌘⏎ to send</span>
          <button onClick={submit} disabled={!text.trim()} style={{
            padding: '6px 12px', borderRadius: 6, border: 'none',
            background: text.trim() ? A.coral : A.paperLine,
            color: text.trim() ? '#fff' : A.textMuted,
            fontSize: 13, fontWeight: 600,
            cursor: text.trim() ? 'pointer' : 'not-allowed',
            display: 'flex', alignItems: 'center', gap: 6,
          }}><I.send /> Send</button>
        </div>
      </div>
    </div>
  );
}

const selectStyle = {
  border: 'none', background: 'transparent', fontSize: 12,
  fontWeight: 600, color: A.text, cursor: 'pointer', outline: 'none',
  fontFamily: 'inherit',
};

function ComposerChip({ children, label, icon, tone, onClick }) {
  const bg = tone === 'coral' ? A.coralSoft : A.paperAlt;
  const fg = tone === 'coral' ? A.coral : A.textMuted;
  return (
    <div onClick={onClick} style={{
      display: 'flex', alignItems: 'center', gap: 5,
      padding: '3px 9px', borderRadius: 14,
      background: bg, color: fg, fontSize: 12, fontWeight: 500,
      cursor: onClick ? 'pointer' : 'default',
      border: `1px solid ${tone === 'coral' ? A.coralSoft : A.paperLine}`,
    }}>
      {icon}
      <span>{label}</span>
      {children}
    </div>
  );
}

window.RELAY_A_CHAT = { MessageList, Composer, markdownMini };
