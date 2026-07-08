import type { AgentProvider } from "../domain/agent.js";
import type { ComplexityTier } from "../domain/classification.js";
import { MODEL_PRICING } from "../domain/model-pricing.js";
import type { TaskCostCall } from "../domain/task-cost.js";
import { rollupTasks } from "../orchestrator/cost-report.js";

/**
 * Default candidate model families the router chooses among, per provider.
 * Cheapest → most capable. Callers can override; these are the safe defaults
 * for a provider whose auth covers its whole tier family. Keys must exist in
 * {@link MODEL_PRICING} so cold-start price ranking works.
 */
export const DEFAULT_CANDIDATES: Record<AgentProvider, string[]> = {
  claude: ["claude-haiku-3-5", "claude-sonnet-4-5", "claude-opus-4-7"],
  codex: ["o3-mini", "gpt-5"],
  harness: [],
};

export function defaultCandidatesForProvider(provider: AgentProvider): string[] {
  return DEFAULT_CANDIDATES[provider] ?? [];
}

/**
 * Measured cost-per-task, per (task type, model). Built from the per-task
 * cost ledger: tasks are rolled up (cost summed across retries), then grouped
 * by tier and by the model that produced the task's costliest call. This is
 * the evidence the router prefers over headline per-token price.
 */
export interface ModelTypeStat {
  taskCount: number;
  meanUsd: number;
}
export type RoutingStats = Map<ComplexityTier, Map<string, ModelTypeStat>>;

/** Why the router picked what it picked — surfaced for logging / tests. */
export type RoutingBasis =
  | "measured" // enough samples → cheapest measured cost-per-task
  | "cold-start-price" // too few samples → cheapest headline per-token price
  | "single-candidate" // only one candidate, nothing to decide
  | "no-candidates"; // nothing to route among → caller keeps its default

export interface RoutingDecision {
  /** Chosen model, or undefined when there are no candidates. */
  model: string | undefined;
  basis: RoutingBasis;
  taskType: ComplexityTier;
  candidateCount: number;
}

/**
 * Blended headline price used for cold-start ranking, in USD per MTok.
 * Coding traffic is input-heavy, so input is weighted 3:1 over output. This
 * is only a tie-breaker until measured cost-per-task exists — once a tier has
 * ≥ `minSamples` real tasks, measured cost supersedes it entirely.
 */
const HEADLINE_INPUT_WEIGHT = 0.75;
const HEADLINE_OUTPUT_WEIGHT = 0.25;

export function headlinePricePerMTok(model: string): number {
  const price = MODEL_PRICING[model];
  if (!price) return Number.POSITIVE_INFINITY; // unknown price → rank last
  return price.inputPerMTok * HEADLINE_INPUT_WEIGHT + price.outputPerMTok * HEADLINE_OUTPUT_WEIGHT;
}

/** Roll the ledger up into per-(tier, model) mean cost-per-task. */
export function buildRoutingStats(lines: TaskCostCall[]): RoutingStats {
  const stats: RoutingStats = new Map();
  // group rollups by tier → model → costs
  const acc = new Map<ComplexityTier, Map<string, number[]>>();
  for (const task of rollupTasks(lines)) {
    if (!task.model) continue; // unpriced/unknown-model task can't inform routing
    let byModel = acc.get(task.taskType);
    if (!byModel) {
      byModel = new Map();
      acc.set(task.taskType, byModel);
    }
    const costs = byModel.get(task.model);
    if (costs) costs.push(task.costUsd);
    else byModel.set(task.model, [task.costUsd]);
  }
  for (const [tier, byModel] of acc) {
    const out = new Map<string, ModelTypeStat>();
    for (const [model, costs] of byModel) {
      const total = costs.reduce((a, b) => a + b, 0);
      out.set(model, { taskCount: costs.length, meanUsd: total / costs.length });
    }
    stats.set(tier, out);
  }
  return stats;
}

export interface ModelRouterOptions {
  /** Models the router may choose among (e.g. a provider's tier family). */
  candidates: string[];
  /**
   * Minimum measured tasks for a (tier, model) before its measured cost is
   * trusted over headline price. Default 5.
   */
  minSamples?: number;
}

/**
 * Cost-aware model router. Given a task type, picks the model with the lowest
 * **measured cost-per-task** for that tier once enough samples exist; before
 * that (cold-start) it falls back to the cheapest **headline per-token
 * price**. This is the behavior change the feature asks for: routing on what a
 * task actually costs, not on sticker per-token rates.
 *
 * Pure and synchronous — the caller loads the ledger once and hands the
 * {@link RoutingStats} in, so a hot dispatch loop never touches disk.
 */
export class ModelRouter {
  private readonly candidates: string[];
  private readonly minSamples: number;

  constructor(
    private readonly stats: RoutingStats,
    options: ModelRouterOptions
  ) {
    // De-dupe while preserving order so a stable tie-break is possible.
    this.candidates = [...new Set(options.candidates)];
    this.minSamples = options.minSamples ?? 5;
  }

  chooseModel(taskType: ComplexityTier): RoutingDecision {
    const candidateCount = this.candidates.length;
    if (candidateCount === 0) {
      return { model: undefined, basis: "no-candidates", taskType, candidateCount };
    }
    if (candidateCount === 1) {
      return { model: this.candidates[0], basis: "single-candidate", taskType, candidateCount };
    }

    const byModel = this.stats.get(taskType);
    const measured = this.candidates
      .map((model) => ({ model, stat: byModel?.get(model) }))
      .filter(
        (c): c is { model: string; stat: ModelTypeStat } =>
          c.stat !== undefined && c.stat.taskCount >= this.minSamples
      );

    if (measured.length > 0) {
      // Cheapest measured mean cost-per-task. Tie-break: cheaper headline
      // price, then candidate order (stable).
      const best = measured.reduce((a, b) => {
        if (b.stat.meanUsd !== a.stat.meanUsd) return b.stat.meanUsd < a.stat.meanUsd ? b : a;
        const ha = headlinePricePerMTok(a.model);
        const hb = headlinePricePerMTok(b.model);
        return hb < ha ? b : a;
      });
      return { model: best.model, basis: "measured", taskType, candidateCount };
    }

    // Cold-start: cheapest blended headline price. Stable on ties.
    const best = this.candidates.reduce((a, b) =>
      headlinePricePerMTok(b) < headlinePricePerMTok(a) ? b : a
    );
    return { model: best, basis: "cold-start-price", taskType, candidateCount };
  }
}
