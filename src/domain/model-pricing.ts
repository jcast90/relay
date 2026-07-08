import type { TokenUsage } from "./agent.js";

/**
 * Hard-coded per-model USD pricing as of 2026-07-08. Prices are USD per
 * *million* tokens, split by token class so cache reads/writes bill at their
 * own rate (they occupy the window but cost far less than fresh input).
 *
 * Sources:
 *   - Claude: anthropic.com/pricing (Opus 4.7 / Sonnet 4.5 / Haiku 3.5 tiers)
 *   - OpenAI: openai.com/api/pricing (gpt-5 / o3-mini)
 *
 * Keys MUST match {@link ./model-context-windows.ts MODEL_CONTEXT_WINDOWS} so
 * a model that has a context window also has a price. When a model ships, add
 * it in BOTH tables in the same PR. Missing keys fall back to zero-cost with a
 * one-line stderr warning (deduped per process) — we never crash a run over a
 * pricing gap, but we make the gap loud so the cost report isn't silently
 * under-counting.
 *
 * Unlike the context-window table, this is NOT mirrored into the GUI / Rust
 * crate: no dashboard consumes USD yet. The cost surface is TS-only (`rly
 * cost`). If a dashboard later renders USD, mirror this the same way
 * `MODEL_CONTEXT_WINDOWS` is mirrored (with a drift-guard test).
 */
export interface ModelPrice {
  /** USD per 1M fresh input tokens. */
  inputPerMTok: number;
  /** USD per 1M output tokens. */
  outputPerMTok: number;
  /** USD per 1M cache-read tokens (cheaper than fresh input). */
  cacheReadPerMTok: number;
  /** USD per 1M cache-write tokens (a premium over fresh input). */
  cacheWritePerMTok: number;
}

export const MODEL_PRICING: Record<string, ModelPrice> = {
  "claude-opus-4-7": {
    inputPerMTok: 15,
    outputPerMTok: 75,
    cacheReadPerMTok: 1.5,
    cacheWritePerMTok: 18.75,
  },
  "claude-sonnet-4-5": {
    inputPerMTok: 3,
    outputPerMTok: 15,
    cacheReadPerMTok: 0.3,
    cacheWritePerMTok: 3.75,
  },
  "claude-haiku-3-5": {
    inputPerMTok: 0.8,
    outputPerMTok: 4,
    cacheReadPerMTok: 0.08,
    cacheWritePerMTok: 1,
  },
  "gpt-5": {
    inputPerMTok: 1.25,
    outputPerMTok: 10,
    cacheReadPerMTok: 0.125,
    cacheWritePerMTok: 1.25,
  },
  "o3-mini": {
    inputPerMTok: 1.1,
    outputPerMTok: 4.4,
    cacheReadPerMTok: 0.55,
    cacheWritePerMTok: 1.1,
  },
};

const PER_MTOK = 1_000_000;

const warnedModels = new Set<string>();

/**
 * USD cost of a single call's {@link TokenUsage} for `modelName`.
 *
 * Cache accounting mirrors the adapter normalizers (research Q3): the
 * adapters fold cache-read + cache-write into `inputTokens`, but ALSO surface
 * the breakdown on `cacheReadTokens` / `cacheWriteTokens`. To avoid
 * double-charging, the cache tokens are subtracted out of `inputTokens` and
 * billed at their own (cheaper) rate; whatever remains is fresh input. When
 * the adapter didn't surface a breakdown, the whole `inputTokens` bills as
 * fresh input — a conservative over-estimate, never an under-count.
 *
 * Unknown / missing models return 0 and emit a one-line `[cost]` stderr
 * warning (deduped per process), matching `resolveContextWindow`'s
 * fail-loud-but-don't-crash discipline.
 */
export function costUsd(modelName: string | undefined | null, usage: TokenUsage): number {
  if (!modelName) {
    warnUnknown("<missing>");
    return 0;
  }
  const price = MODEL_PRICING[modelName];
  if (!price) {
    warnUnknown(modelName);
    return 0;
  }

  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  // `inputTokens` already includes cache tokens; peel them off so each class
  // bills once. Clamp at 0 in case an adapter reports cache tokens that
  // exceed the folded input total.
  const freshInput = Math.max(0, usage.inputTokens - cacheRead - cacheWrite);

  const cost =
    (freshInput * price.inputPerMTok +
      usage.outputTokens * price.outputPerMTok +
      cacheRead * price.cacheReadPerMTok +
      cacheWrite * price.cacheWritePerMTok) /
    PER_MTOK;

  return cost;
}

function warnUnknown(modelName: string): void {
  if (warnedModels.has(modelName)) return;
  warnedModels.add(modelName);
  console.warn(
    `[cost] No pricing for model "${modelName}"; billing this model's calls as $0. ` +
      `Add it to MODEL_PRICING (src/domain/model-pricing.ts) to fix cost totals.`
  );
}

/** Test helper — reset the per-process dedup cache so warnings re-fire. */
export function __resetPricingWarnedForTests(): void {
  warnedModels.clear();
}
