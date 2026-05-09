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
