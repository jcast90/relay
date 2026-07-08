import { describe, expect, it } from "vitest";

import type { TaskCostCall } from "../../src/domain/task-cost.js";
import {
  buildCostReport,
  percentile,
  renderCostReport,
  rollupTasks,
} from "../../src/orchestrator/cost-report.js";

function call(partial: Partial<TaskCostCall>): TaskCostCall {
  return {
    schemaVersion: 1,
    ts: "2026-07-08T00:00:00.000Z",
    runId: "run-1",
    ticketId: "t-1",
    taskType: "feature_small",
    workKind: "implement_phase",
    attempt: 1,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    ...partial,
  };
}

describe("cost-report", () => {
  it("rolls up a task's cost across retries and picks the costliest model", () => {
    const rollups = rollupTasks([
      call({
        ticketId: "t-1",
        attempt: 1,
        costUsd: 0.5,
        model: "claude-haiku-3-5",
        inputTokens: 100,
      }),
      call({
        ticketId: "t-1",
        attempt: 2,
        costUsd: 2.0,
        model: "claude-opus-4-7",
        inputTokens: 200,
      }),
    ]);
    expect(rollups).toHaveLength(1);
    expect(rollups[0]).toMatchObject({
      ticketId: "t-1",
      costUsd: 2.5,
      retries: 1, // max attempt (2) - 1
      inputTokens: 300,
      callCount: 2,
      model: "claude-opus-4-7", // costliest call
    });
  });

  it("aggregates per-task rollups by task type, most expensive first", () => {
    const report = buildCostReport([
      // Two feature_small tasks: $1 and $3.
      call({ ticketId: "a", taskType: "feature_small", costUsd: 1 }),
      call({ ticketId: "b", taskType: "feature_small", costUsd: 3 }),
      // One trivial task: $0.10.
      call({ ticketId: "c", taskType: "trivial", costUsd: 0.1 }),
    ]);

    expect(report.taskCount).toBe(3);
    expect(report.callCount).toBe(3);
    expect(report.totalUsd).toBeCloseTo(4.1, 6);

    // feature_small is the pricier bucket → sorts first.
    expect(report.byTaskType[0]!.taskType).toBe("feature_small");
    expect(report.byTaskType[0]!.taskCount).toBe(2);
    expect(report.byTaskType[0]!.meanUsd).toBeCloseTo(2, 6);
    expect(report.byTaskType[0]!.medianUsd).toBeCloseTo(1, 6); // nearest-rank p50 of [1,3]
    expect(report.byTaskType[1]!.taskType).toBe("trivial");
  });

  it("percentile handles empty, single, and multi-element arrays", () => {
    expect(percentile([], 90)).toBe(0);
    expect(percentile([5], 90)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5], 90)).toBe(5);
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
  });

  it("renders a table and an empty-state hint", () => {
    expect(renderCostReport(buildCostReport([]))).toContain("No task costs recorded yet");

    const rendered = renderCostReport(
      buildCostReport([call({ ticketId: "t-1", taskType: "bugfix", costUsd: 1.2345 })])
    );
    expect(rendered).toContain("bugfix");
    expect(rendered).toContain("$1.2345");
    expect(rendered).toContain("TASK TYPE");
  });
});
