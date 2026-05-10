/**
 * GUI-side mirror of `src/domain/model-context-windows.ts`. Adding a
 * new model REQUIRES adding it to BOTH files in the same PR; the
 * sibling test `gui/src/lib/modelContextWindows.test.ts` asserts the
 * tables stay in sync (drift guard, M9).
 */
export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "claude-sonnet-4-5": 200_000,
  "claude-opus-4-7": 1_000_000,
  "claude-haiku-3-5": 200_000,
  "gpt-5": 200_000,
  "o3-mini": 200_000,
};

export const DEFAULT_CONTEXT_WINDOW = 200_000;

export function resolveContextWindow(modelName?: string | null): number {
  if (!modelName) return DEFAULT_CONTEXT_WINDOW;
  return MODEL_CONTEXT_WINDOWS[modelName] ?? DEFAULT_CONTEXT_WINDOW;
}

/**
 * Return a structured summary of the context-window resolution for
 * the given model name. Used by the GUI worst-session chip's tooltip
 * (Phase 1 PR-3 / Task 7) so the user can tell when the chip is
 * working off the default ceiling vs a model-specific value.
 *
 * - `key` echoes the looked-up model name (or "default" when none was
 *   provided / no entry matched).
 * - `value` is the resolved context-window size, in tokens.
 * - `isDefault` is true when the result fell back to
 *   `DEFAULT_CONTEXT_WINDOW`.
 */
export function getModelContextWindowSummary(modelName?: string | null): {
  key: string;
  value: number;
  isDefault: boolean;
} {
  if (!modelName) {
    return { key: "default", value: DEFAULT_CONTEXT_WINDOW, isDefault: true };
  }
  const direct = MODEL_CONTEXT_WINDOWS[modelName];
  if (direct !== undefined) {
    return { key: modelName, value: direct, isDefault: false };
  }
  return { key: "default", value: DEFAULT_CONTEXT_WINDOW, isDefault: true };
}
