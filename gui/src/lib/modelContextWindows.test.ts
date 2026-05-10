import { describe, expect, it } from "vitest";

import { MODEL_CONTEXT_WINDOWS } from "./modelContextWindows";

/**
 * M9 — model-table drift guard. The canonical TS-side table at
 * `src/domain/model-context-windows.ts` and this GUI-side mirror MUST
 * stay byte-identical. Vite cannot reach across the workspace boundary
 * without exposing the orchestrator's path to the GUI bundle, so this
 * test maintains a hard-coded canonical mapping and asserts the
 * GUI-side copy matches. PR review owns enforcing the sibling-file
 * update; this test owns catching it in CI.
 */
const CANONICAL_MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "claude-sonnet-4-5": 200_000,
  "claude-opus-4-7": 1_000_000,
  "claude-haiku-3-5": 200_000,
  "gpt-5": 200_000,
  "o3-mini": 200_000,
};

describe("modelContextWindows GUI mirror (M9 drift guard)", () => {
  it("matches the canonical orchestrator-side table key-for-key", () => {
    expect(MODEL_CONTEXT_WINDOWS).toEqual(CANONICAL_MODEL_CONTEXT_WINDOWS);
  });

  it("each canonical key resolves to the same value in the GUI mirror", () => {
    for (const [key, value] of Object.entries(CANONICAL_MODEL_CONTEXT_WINDOWS)) {
      expect(MODEL_CONTEXT_WINDOWS[key]).toBe(value);
    }
  });

  // PR-3 (Task 7) extracts a shared `tokenSeverity` util and adds a
  // re-export from this module so consumers have one import. The
  // `resolveContextWindow` helper is mirrored too — this assertion
  // pins the mirror is exposing it. RED until PR-3 lands the
  // re-export.
  // PR-3 (Task 7) will add a `getModelContextWindowSummary` helper that
  // returns `{ key, value, isDefault }` for the GUI worst-session chip's
  // tooltip. Marked todo until PR-3 lands the re-export.
  it.todo(
    "re-exports a `getModelContextWindowSummary` helper for the GUI worst-session chip (PR-3 wiring)"
  );
});
