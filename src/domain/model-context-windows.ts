/**
 * Hard-coded per-model context-window ceilings as of 2026-05-09. Sources:
 *   - Claude: support.claude.com/en/articles/8606395
 *   - Codex / OpenAI: docs.onlinetool.cc/codex (varies by deployed model)
 *
 * Add new entries when models ship; missing keys fall back to a conservative
 * 200_000 with a stderr warning so the operator knows their bar may be off.
 * Mirrored at `gui/src/lib/modelContextWindows.ts` (same keys / values).
 * `gui/src/lib/modelContextWindows.test.ts` asserts the two copies stay in
 * sync (drift guard, M9). Adding a new entry here REQUIRES adding it
 * there in the same PR.
 */
export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "claude-sonnet-4-5": 200_000,
  "claude-opus-4-7": 1_000_000,
  "claude-haiku-3-5": 200_000,
  "gpt-5": 200_000,
  "o3-mini": 200_000,
};

export const DEFAULT_CONTEXT_WINDOW = 200_000;

const warnedModels = new Set<string>();

/**
 * Resolve the context-window ceiling for a given model. Returns
 * `DEFAULT_CONTEXT_WINDOW` (200_000) for unknown / missing models, and
 * writes a one-line `[budget]` stderr warning so operators notice the
 * bar may be miscalibrated. The warning is deduped per process via
 * `warnedModels`.
 */
export function resolveContextWindow(modelName?: string | null): number {
  if (!modelName) return DEFAULT_CONTEXT_WINDOW;
  const known = MODEL_CONTEXT_WINDOWS[modelName];
  if (typeof known === "number") return known;
  if (!warnedModels.has(modelName)) {
    warnedModels.add(modelName);
    console.warn(
      `[budget] Unknown model "${modelName}"; assuming ${DEFAULT_CONTEXT_WINDOW.toLocaleString()}-token context window.`
    );
  }
  return DEFAULT_CONTEXT_WINDOW;
}

/** Test helper — reset the per-process dedup cache so warnings re-fire. */
export function __resetWarnedModelsForTests(): void {
  warnedModels.clear();
}
