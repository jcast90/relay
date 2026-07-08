import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MODEL_PRICING,
  __resetPricingWarnedForTests,
  costUsd,
} from "../../src/domain/model-pricing.js";
import { MODEL_CONTEXT_WINDOWS } from "../../src/domain/model-context-windows.js";

describe("model-pricing", () => {
  afterEach(() => {
    __resetPricingWarnedForTests();
    vi.restoreAllMocks();
  });

  it("has a price for every model with a context window (tables stay in lockstep)", () => {
    for (const model of Object.keys(MODEL_CONTEXT_WINDOWS)) {
      expect(MODEL_PRICING[model], `missing pricing for ${model}`).toBeDefined();
    }
  });

  it("bills fresh input + output at the model's per-MTok rate", () => {
    // Opus 4.7: $15/MTok input, $75/MTok output.
    const cost = costUsd("claude-opus-4-7", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(15 + 75, 6);
  });

  it("peels cache tokens out of inputTokens and bills them at the cache rate", () => {
    // inputTokens folds in cache tokens (research Q3). 1M input of which
    // 800k is cache-read → 200k fresh input @ $3 + 800k cache-read @ $0.3.
    const cost = costUsd("claude-sonnet-4-5", {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 800_000,
    });
    const expected = (200_000 * 3 + 800_000 * 0.3) / 1_000_000;
    expect(cost).toBeCloseTo(expected, 6);
  });

  it("bills cache-write at its premium rate", () => {
    const cost = costUsd("claude-sonnet-4-5", {
      inputTokens: 100_000,
      outputTokens: 0,
      cacheWriteTokens: 100_000,
    });
    // All 100k is cache-write → 0 fresh input, 100k @ $3.75/MTok.
    expect(cost).toBeCloseTo((100_000 * 3.75) / 1_000_000, 6);
  });

  it("clamps fresh input at 0 when cache tokens exceed the folded total", () => {
    const cost = costUsd("claude-haiku-3-5", {
      inputTokens: 500,
      outputTokens: 0,
      cacheReadTokens: 1_000,
    });
    // freshInput clamps to 0; only the 1000 cache-read tokens bill.
    expect(cost).toBeCloseTo((1_000 * 0.08) / 1_000_000, 6);
  });

  it("returns 0 and warns once for an unknown model", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };

    expect(costUsd("some-future-model", usage)).toBe(0);
    expect(costUsd("some-future-model", usage)).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("some-future-model");
  });

  it("returns 0 and warns for a missing model name", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(costUsd(undefined, { inputTokens: 100, outputTokens: 100 })).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
