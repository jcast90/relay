import { describe, expect, it } from "vitest";

import {
  DEFAULT_CONTEXT_WINDOW,
  MODEL_CONTEXT_WINDOWS,
  getModelContextWindowSummary,
} from "./modelContextWindows";

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

  it("getModelContextWindowSummary returns the canonical row for known models", () => {
    expect(getModelContextWindowSummary("claude-opus-4-7")).toEqual({
      key: "claude-opus-4-7",
      value: 1_000_000,
      isDefault: false,
    });
    expect(getModelContextWindowSummary("claude-sonnet-4-5")).toEqual({
      key: "claude-sonnet-4-5",
      value: 200_000,
      isDefault: false,
    });
  });

  it("getModelContextWindowSummary falls back to the default ceiling for unknown / missing models", () => {
    expect(getModelContextWindowSummary(undefined)).toEqual({
      key: "default",
      value: DEFAULT_CONTEXT_WINDOW,
      isDefault: true,
    });
    expect(getModelContextWindowSummary(null)).toEqual({
      key: "default",
      value: DEFAULT_CONTEXT_WINDOW,
      isDefault: true,
    });
    expect(getModelContextWindowSummary("not-a-real-model")).toEqual({
      key: "default",
      value: DEFAULT_CONTEXT_WINDOW,
      isDefault: true,
    });
  });
});
