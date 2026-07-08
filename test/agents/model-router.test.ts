import { describe, expect, it } from "vitest";

import {
  ModelRouter,
  buildRoutingStats,
  defaultCandidatesForProvider,
  headlinePricePerMTok,
} from "../../src/agents/model-router.js";
import type { TaskCostCall } from "../../src/domain/task-cost.js";

const CLAUDE = ["claude-haiku-3-5", "claude-sonnet-4-5", "claude-opus-4-7"];

function line(partial: Partial<TaskCostCall>): TaskCostCall {
  return {
    schemaVersion: 1,
    ts: "2026-07-08T00:00:00.000Z",
    runId: "r",
    ticketId: "t",
    taskType: "feature_small",
    workKind: "implement_phase",
    attempt: 1,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    ...partial,
  };
}

/** N tasks of one (tier, model) at a fixed per-task cost. */
function tasks(
  tier: TaskCostCall["taskType"],
  model: string,
  n: number,
  costEach: number
): TaskCostCall[] {
  return Array.from({ length: n }, (_, i) =>
    line({ ticketId: `${tier}-${model}-${i}`, taskType: tier, model, costUsd: costEach })
  );
}

describe("ModelRouter", () => {
  it("returns undefined with no candidates and the sole candidate with one", () => {
    const empty = new ModelRouter(new Map(), { candidates: [] });
    expect(empty.chooseModel("feature_small")).toMatchObject({
      model: undefined,
      basis: "no-candidates",
    });

    const one = new ModelRouter(new Map(), { candidates: ["claude-opus-4-7"] });
    expect(one.chooseModel("feature_small")).toMatchObject({
      model: "claude-opus-4-7",
      basis: "single-candidate",
    });
  });

  it("cold-starts on cheapest headline price when samples are thin", () => {
    const router = new ModelRouter(new Map(), { candidates: CLAUDE, minSamples: 5 });
    const decision = router.chooseModel("feature_small");
    // Haiku is the cheapest headline price of the three.
    expect(decision).toMatchObject({ model: "claude-haiku-3-5", basis: "cold-start-price" });
  });

  it("prefers the cheapest MEASURED cost-per-task once minSamples is met", () => {
    // Opus is measured cheap-per-task here (5 tasks @ $0.10) while sonnet is
    // pricier per task ($2.00) — measured cost inverts the headline order.
    const stats = buildRoutingStats([
      ...tasks("feature_small", "claude-opus-4-7", 5, 0.1),
      ...tasks("feature_small", "claude-sonnet-4-5", 5, 2.0),
    ]);
    const router = new ModelRouter(stats, { candidates: CLAUDE, minSamples: 5 });
    expect(router.chooseModel("feature_small")).toMatchObject({
      model: "claude-opus-4-7",
      basis: "measured",
    });
  });

  it("ignores measured data below minSamples and falls back to price", () => {
    // Only 4 opus tasks — under the threshold — so measured is not trusted.
    const stats = buildRoutingStats(tasks("feature_small", "claude-opus-4-7", 4, 0.01));
    const router = new ModelRouter(stats, { candidates: CLAUDE, minSamples: 5 });
    expect(router.chooseModel("feature_small").basis).toBe("cold-start-price");
  });

  it("scopes measured data to the matching tier", () => {
    // Opus is measured-cheap for bugfix, but we're routing feature_small →
    // no qualifying measured data → cold-start.
    const stats = buildRoutingStats(tasks("bugfix", "claude-opus-4-7", 10, 0.01));
    const router = new ModelRouter(stats, { candidates: CLAUDE, minSamples: 5 });
    expect(router.chooseModel("feature_small").basis).toBe("cold-start-price");
    expect(router.chooseModel("bugfix")).toMatchObject({
      model: "claude-opus-4-7",
      basis: "measured",
    });
  });

  it("headlinePricePerMTok ranks known models and sinks unknown ones", () => {
    expect(headlinePricePerMTok("claude-haiku-3-5")).toBeLessThan(
      headlinePricePerMTok("claude-opus-4-7")
    );
    expect(headlinePricePerMTok("totally-unknown")).toBe(Number.POSITIVE_INFINITY);
  });

  it("buildRoutingStats rolls tasks up per tier+model and skips unpriced tasks", () => {
    const stats = buildRoutingStats([
      ...tasks("feature_small", "claude-sonnet-4-5", 3, 1),
      line({ ticketId: "no-model", taskType: "feature_small", model: undefined, costUsd: 9 }),
    ]);
    const bucket = stats.get("feature_small")!;
    expect(bucket.get("claude-sonnet-4-5")).toEqual({ taskCount: 3, meanUsd: 1 });
    expect(bucket.has("undefined")).toBe(false);
  });

  it("exposes provider default candidate families", () => {
    expect(defaultCandidatesForProvider("claude")).toEqual(CLAUDE);
    expect(defaultCandidatesForProvider("codex")).toContain("gpt-5");
    expect(defaultCandidatesForProvider("harness")).toEqual([]);
  });
});
