// Deterministic glyph + hue derivation for agent avatars. The Tidewater
// design shows rich glyph avatars (◆ ▲ ● etc.) but the backend doesn't
// ship an AGENTS registry — so we hash `agentId` down to a glyph and a
// fixed HSL hue. Same agent → same look across every surface.

const GLYPHS = ["◆", "▲", "●", "■", "◈", "▼", "◉", "◇", "★", "☗", "✦", "✧", "♆", "♄", "♃", "♇"];

// Hue buckets chosen to stay distinguishable on both paper + ink surfaces.
// Avoids the coral primary-accent hue so repo chips + agent avatars don't
// visually collide.
const HUES = [210, 260, 160, 30, 340, 190, 120, 290, 50, 230];

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  return h;
}

export type AgentAvatar = {
  glyph: string;
  hue: number;
  background: string;
  color: string;
};

export function agentAvatar(agentId: string, displayName?: string): AgentAvatar {
  const seed = agentId || displayName || "agent";
  const h = hash(seed);
  const glyph = GLYPHS[h % GLYPHS.length];
  const hue = HUES[(h >>> 4) % HUES.length];
  return {
    glyph,
    hue,
    background: `hsl(${hue} 60% 88%)`,
    color: `hsl(${hue} 50% 32%)`,
  };
}
