/**
 * Map context-window pct (0-100+) to a CSS severity tier.
 * Mirrors the original implementation from
 * `gui/src/components/AutonomousSessionHeader.tsx` —
 * extracted here so `ContextWindowBar` and the worst-session chip
 * share the named export rather than copy-pasting the ladder.
 *
 * Phase 1 PR-3 (Task 7) will refactor `AutonomousSessionHeader` to
 * import from here instead of holding its own copy.
 */
export type TokenSeverity = "ok" | "warn" | "hot" | "overrun";

export function tokenPctSeverity(pct: number): TokenSeverity {
  if (pct >= 100) return "overrun";
  if (pct >= 90) return "hot";
  if (pct >= 75) return "warn";
  return "ok";
}
