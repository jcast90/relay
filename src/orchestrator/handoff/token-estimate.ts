/**
 * Token-count heuristic for handoff briefs. Chosen for zero-dependency
 * portability over precision: the synthesizer must run with no LLM and no
 * tokenizer dependency (RESEARCH §Standard Stack — "Hand-roll token
 * estimation"). 4-chars-per-token is the rough mean across BPE-style
 * tokenizers for English markdown; sufficient for budget enforcement
 * (D-04) where the goal is "fits in 8K", not exact accounting.
 *
 * Future tightening: per-section measurement on real channels (Phase 2
 * `02-SUMMARY.md` follow-up) may calibrate per-content-kind multipliers.
 */
export function estimateTokens(s: string): number {
  if (s.length === 0) return 0;
  return Math.ceil(s.length / 4);
}
