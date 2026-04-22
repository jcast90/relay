/* Direction A — "Tide"
   Fresh modern palette, Slack's 3-pane layout.
   - Deep ink sidebar, soft paper center, cream right rail
   - Coral/salmon accent, fresh mint success
   - Board lives as a pinned Canvas at the top of channel (collapsible)
   - Decisions live in a sidebar drawer (right-pane)
   - PRs/approvals open as right-pane threads
   - Agent presence shown as inline tool-use text (not dots)
   - DM-first: any DM can be "promoted" to a channel
*/

window.__RELAY_R = window.__RELAY_R || {};
window.__RELAY_R.useState = window.__RELAY_R.useState || React.useState;
window.__RELAY_R.useEffect = window.__RELAY_R.useEffect || React.useEffect;
window.__RELAY_R.useRef = window.__RELAY_R.useRef || React.useRef;
window.__RELAY_R.useMemo = window.__RELAY_R.useMemo || React.useMemo;
const useState = window.__RELAY_R.useState;
const useEffect = window.__RELAY_R.useEffect;
const useRef = window.__RELAY_R.useRef;
const useMemo = window.__RELAY_R.useMemo;
const { AGENTS, REPOS, CHANNELS, DMS, ACTIVITY } = window.RELAY_DATA;

const A = {
  // Tide palette
  inkDeepest: '#0e1420',
  inkDeep:    '#141b2a',
  inkPanel:   '#1a2232',
  inkRaised:  '#232c40',
  inkLine:    '#2b3550',

  paper:      '#fbf9f4',
  paperAlt:   '#f3f0e7',
  paperLine:  '#e5e1d5',

  text:       '#1b1f2a',
  textMuted:  '#5b6579',
  textDim:    '#8a93a5',
  textOnDark: '#e8ecf4',
  textOnDarkMuted: '#8a93a5',

  coral:      '#e65a4f',   // primary accent
  coralSoft:  '#fbe1dd',
  amber:      '#e89a2b',
  mint:       '#3fb984',
  mintSoft:   '#d9f1e6',
  sky:        '#4a7fd0',
  magenta:    '#c44d8a',

  // status for tickets
  statusFill: {
    pending:   '#d0d4de',
    ready:     '#86a6d9',
    executing: '#e89a2b',
    verifying: '#7a6fd0',
    completed: '#3fb984',
    failed:    '#e65a4f',
    blocked:   '#9ba3b6',
    retry:     '#d88a3b',
  },
};

// ─────────────────────────────────────────────────────────────
// Icons (minimal inline SVG)
// ─────────────────────────────────────────────────────────────
const I = {
  hash:     (p) => <svg {...p} width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 5h9M2.5 9h9M6 2L5 12M9 2L8 12" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>,
  star:     (p) => <svg {...p} width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 1l1.5 3.3 3.5.4-2.6 2.4.7 3.5L6 9l-3.1 1.6.7-3.5L1 5.1l3.5-.4L6 1z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round"/></svg>,
  starFill: (p) => <svg {...p} width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><path d="M6 1l1.5 3.3 3.5.4-2.6 2.4.7 3.5L6 9l-3.1 1.6.7-3.5L1 5.1l3.5-.4L6 1z"/></svg>,
  lock:     (p) => <svg {...p} width="12" height="12" viewBox="0 0 12 12" fill="none"><rect x="2.5" y="5.5" width="7" height="5" rx="1" stroke="currentColor" strokeWidth="1.1"/><path d="M4 5.5V4a2 2 0 1 1 4 0v1.5" stroke="currentColor" strokeWidth="1.1"/></svg>,
  at:       (p) => <svg {...p} width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="2.2" stroke="currentColor" strokeWidth="1.2"/><path d="M9.2 7v1a1.5 1.5 0 0 0 3 0V7a5.2 5.2 0 1 0-2.1 4.2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>,
  bell:     (p) => <svg {...p} width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 10h8l-1.2-1.8V6a2.8 2.8 0 0 0-5.6 0v2.2L3 10zM6 11.5a1 1 0 0 0 2 0" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/></svg>,
  plus:     (p) => <svg {...p} width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 2v8M2 6h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>,
  chevR:    (p) => <svg {...p} width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M4 2l3 3-3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  chevD:    (p) => <svg {...p} width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 4l3 3 3-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  send:     (p) => <svg {...p} width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 7l10-5-4 10-1.5-4L2 7z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/></svg>,
  folder:   (p) => <svg {...p} width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 4a1 1 0 0 1 1-1h3l1 1h4a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4z" stroke="currentColor" strokeWidth="1.2"/></svg>,
  close:    (p) => <svg {...p} width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>,
  check:    (p) => <svg {...p} width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2.5 6.5l2.5 2.5 4.5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  spark:    (p) => <svg {...p} width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 1l1.2 3.3 3.3 1.2-3.3 1.2L6 10l-1.2-3.3L1.5 5.5l3.3-1.2L6 1z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round"/></svg>,
  flask:    (p) => <svg {...p} width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M5 1v3L2.5 9a1.5 1.5 0 0 0 1.3 2.2h4.4A1.5 1.5 0 0 0 9.5 9L7 4V1M4 1h4" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round"/></svg>,
  gear:     (p) => <svg {...p} width="12" height="12" viewBox="0 0 12 12" fill="none"><circle cx="6" cy="6" r="1.8" stroke="currentColor" strokeWidth="1.1"/><path d="M6 1.5v1.3M6 9.2v1.3M1.5 6h1.3M9.2 6h1.3M2.8 2.8l.9.9M8.3 8.3l.9.9M2.8 9.2l.9-.9M8.3 3.7l.9-.9" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/></svg>,
  repo:     (p) => <svg {...p} width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M3 2v8M3 2h6a1 1 0 0 1 1 1v6M3 10h7M5 4v2l1-.7L7 6V4" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round"/></svg>,
  pr:       (p) => <svg {...p} width="12" height="12" viewBox="0 0 12 12" fill="none"><circle cx="3" cy="3" r="1.2" stroke="currentColor" strokeWidth="1.1"/><circle cx="3" cy="9" r="1.2" stroke="currentColor" strokeWidth="1.1"/><circle cx="9" cy="9" r="1.2" stroke="currentColor" strokeWidth="1.1"/><path d="M3 4.2v3.6M9 7.8V5.5a1.5 1.5 0 0 0-1.5-1.5H6" stroke="currentColor" strokeWidth="1.1"/><path d="M7.3 2.8L6 4l1.3 1.2" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  book:     (p) => <svg {...p} width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2.5 2.5h3a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 0-1.5-1.5h-3v-6zM9.5 2.5h-3A1.5 1.5 0 0 0 5 4v6a1.5 1.5 0 0 1 1.5-1.5h3v-6z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round"/></svg>,
  canvas:   (p) => <svg {...p} width="12" height="12" viewBox="0 0 12 12" fill="none"><rect x="1.5" y="2.5" width="9" height="7" rx="1" stroke="currentColor" strokeWidth="1.1"/><path d="M3.5 5h2M3.5 7h5M6.5 5h2" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/></svg>,
  search:   (p) => <svg {...p} width="13" height="13" viewBox="0 0 13 13" fill="none"><circle cx="5.5" cy="5.5" r="3.5" stroke="currentColor" strokeWidth="1.3"/><path d="M8.5 8.5l3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>,
};

// ─────────────────────────────────────────────────────────────
// Avatar — shows agent glyph or initials, with tool-use halo when working
// ─────────────────────────────────────────────────────────────
function Avatar({ agent, size = 28, style = 'glyph', showStatus = false }) {
  if (!agent) return null;
  const content = style === 'glyph'
    ? agent.glyph
    : agent.name.slice(0, 2).toUpperCase();
  const bg = agentColor(agent.id);
  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <div style={{
        width: size, height: size, borderRadius: size * 0.22,
        background: bg, color: '#fff',
        fontSize: size * 0.42, fontWeight: 600,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: style === 'glyph' ? 'ui-monospace, "SF Mono", Menlo, monospace' : 'inherit',
        letterSpacing: style === 'glyph' ? 0 : '-0.02em',
      }}>
        {content}
      </div>
      {showStatus && agent.status === 'working' && (
        <div style={{
          position: 'absolute', bottom: -1, right: -1,
          width: size * 0.32, height: size * 0.32, borderRadius: '50%',
          background: A.amber, border: `2px solid ${A.paper}`,
          animation: 'relay-pulse 1.6s ease-in-out infinite',
        }} />
      )}
      {showStatus && agent.status === 'idle' && (
        <div style={{
          position: 'absolute', bottom: -1, right: -1,
          width: size * 0.28, height: size * 0.28, borderRadius: '50%',
          background: A.mint, border: `2px solid ${A.paper}`,
        }} />
      )}
    </div>
  );
}

function agentColor(id) {
  const palette = ['#3e5886', '#9c5a7c', '#2f7a6a', '#b26a3a', '#5b5fb0', '#c8654a', '#5a7a4a', '#7a5290', '#3a7590'];
  let h = 0; for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return palette[Math.abs(h) % palette.length];
}

// ─────────────────────────────────────────────────────────────
// LEFT SIDEBAR (Workspace rail + nav)
// ─────────────────────────────────────────────────────────────
function WorkspaceRail({ current, onPick }) {
  const workspaces = [
    { id: 'relay', name: 'Relay', glyph: 'R', tint: A.coral },
    { id: 'venture-os', name: 'venture-os', glyph: 'V', tint: A.sky },
    { id: 'lci', name: 'LCI', glyph: 'L', tint: A.mint },
  ];
  return (
    <div style={{
      width: 58, background: A.inkDeepest,
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      padding: '10px 0 14px', gap: 6, borderRight: `1px solid ${A.inkLine}`,
    }}>
      {workspaces.map((w) => (
        <button key={w.id} onClick={() => onPick?.(w.id)} title={w.name} style={{
          width: 38, height: 38, borderRadius: 9,
          background: w.id === current ? w.tint : A.inkPanel,
          color: w.id === current ? '#fff' : A.textOnDarkMuted,
          border: 'none', cursor: 'pointer',
          fontSize: 14, fontWeight: 700, letterSpacing: '-0.02em',
          boxShadow: w.id === current ? `0 0 0 2px ${A.inkDeepest}, 0 0 0 3.5px ${w.tint}` : 'none',
          transition: 'all 0.15s',
        }}>{w.glyph}</button>
      ))}
      <div style={{ height: 1, background: A.inkLine, width: 28, margin: '4px 0' }} />
      <button title="Add workspace" style={{
        width: 38, height: 38, borderRadius: 9,
        background: 'transparent', border: `1.5px dashed ${A.inkLine}`,
        color: A.textOnDarkMuted, cursor: 'pointer',
      }}><I.plus /></button>
      <div style={{ flex: 1 }} />
      <button title="Settings" style={{
        width: 38, height: 38, borderRadius: 9, background: 'transparent',
        border: 'none', color: A.textOnDarkMuted, cursor: 'pointer',
      }}><I.gear /></button>
    </div>
  );
}

// Expose to window for modular loading
window.RELAY_A = { A, I, Avatar, agentColor, WorkspaceRail };
