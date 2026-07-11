import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MODEL_PRICING,
  __resetPricingWarnedForTests,
  costUsd,
  normalizeModelId,
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

  it("prices a DATED model ID the same as its undated name", () => {
    // The Claude CLI reports the dated ID it actually ran. MODEL_PRICING is
    // keyed on undated names. Before normalization this lookup missed and
    // every executor-path call billed $0 — the exact under-count the cost
    // surface exists to prevent.
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
    expect(costUsd("claude-sonnet-4-5-20250929", usage)).toBeCloseTo(3 + 15, 6);
    expect(costUsd("claude-sonnet-4-5-20250929", usage)).toBeCloseTo(
      costUsd("claude-sonnet-4-5", usage),
      6
    );
  });

  it("does not warn for a dated ID of a known model", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    costUsd("claude-opus-4-7-20250514", { inputTokens: 100, outputTokens: 100 });
    expect(warn).not.toHaveBeenCalled();
  });

  it("normalizeModelId only strips a trailing 8-digit date", () => {
    expect(normalizeModelId("claude-sonnet-4-5-20250929")).toBe("claude-sonnet-4-5");
    expect(normalizeModelId("claude-sonnet-4-5")).toBe("claude-sonnet-4-5");
    // Version segments are not dates — must survive untouched, or `gpt-5`-style
    // names with numeric tails would be mangled into a miss.
    expect(normalizeModelId("gpt-5")).toBe("gpt-5");
    expect(normalizeModelId("o3-mini")).toBe("o3-mini");
    // Too short / too long to be YYYYMMDD.
    expect(normalizeModelId("model-1234567")).toBe("model-1234567");
    expect(normalizeModelId("model-123456789")).toBe("model-123456789");
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
