import type { ComplexityTier } from "../domain/classification.js";
import type { TaskCostCall } from "../domain/task-cost.js";

/**
 * A single task (ticket) rolled up from all its ledger lines — cost summed
 * across every call and retry. This is the unit "cost-per-task" is measured
 * in; `model` is the model of the task's costliest call (the dominant spend),
 * and `retries` is `max(attempt) - 1` across the task's calls.
 */
export interface TaskRollup {
  ticketId: string;
  taskType: ComplexityTier;
  runId: string;
  model: string | undefined;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  retries: number;
  callCount: number;
}

/** Cost stats for one task type, computed over its per-task rollups. */
export interface TaskTypeAggregate {
  taskType: ComplexityTier;
  taskCount: number;
  totalUsd: number;
  meanUsd: number;
  medianUsd: number;
  p90Usd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  avgRetries: number;
}

export interface CostReport {
  byTaskType: TaskTypeAggregate[];
  totalUsd: number;
  taskCount: number;
  /** Number of ledger lines (calls) the report was computed from. */
  callCount: number;
}

/**
 * Roll ledger lines up into per-task records. Lines are grouped by
 * `ticketId`; a task's cost is the sum of its calls' costs (retries
 * included). Ticket ids are assumed unique across runs (they carry a run-
 * scoped prefix in practice); if the same id ever recurs across runs the
 * rollup merges them, which is the conservative choice for a cost total.
 */
export function rollupTasks(lines: TaskCostCall[]): TaskRollup[] {
  const byTicket = new Map<string, TaskCostCall[]>();
  for (const line of lines) {
    const bucket = byTicket.get(line.ticketId);
    if (bucket) bucket.push(line);
    else byTicket.set(line.ticketId, [line]);
  }

  const rollups: TaskRollup[] = [];
  for (const [ticketId, calls] of byTicket) {
    let inputTokens = 0;
    let outputTokens = 0;
    let costUsd = 0;
    let maxAttempt = 1;
    let costliest: TaskCostCall | undefined;
    for (const c of calls) {
      inputTokens += c.inputTokens;
      outputTokens += c.outputTokens;
      costUsd += c.costUsd;
      if (c.attempt > maxAttempt) maxAttempt = c.attempt;
      if (!costliest || c.costUsd > costliest.costUsd) costliest = c;
    }
    rollups.push({
      ticketId,
      taskType: calls[0]!.taskType,
      runId: calls[0]!.runId,
      model: costliest?.model,
      inputTokens,
      outputTokens,
      costUsd,
      retries: Math.max(0, maxAttempt - 1),
      callCount: calls.length,
    });
  }
  return rollups;
}

/**
 * Aggregate ledger lines into a cost-per-task-type report. This is what
 * `rly cost` prints and what the cost-aware router (PR 4) reads to decide
 * which model is cheapest for a given tier.
 */
export function buildCostReport(lines: TaskCostCall[]): CostReport {
  const rollups = rollupTasks(lines);

  const byType = new Map<ComplexityTier, TaskRollup[]>();
  for (const r of rollups) {
    const bucket = byType.get(r.taskType);
    if (bucket) bucket.push(r);
    else byType.set(r.taskType, [r]);
  }

  const byTaskType: TaskTypeAggregate[] = [];
  for (const [taskType, tasks] of byType) {
    const costs = tasks.map((t) => t.costUsd).sort((a, b) => a - b);
    const totalUsd = costs.reduce((a, b) => a + b, 0);
    byTaskType.push({
      taskType,
      taskCount: tasks.length,
      totalUsd,
      meanUsd: totalUsd / tasks.length,
      medianUsd: percentile(costs, 50),
      p90Usd: percentile(costs, 90),
      totalInputTokens: tasks.reduce((a, t) => a + t.inputTokens, 0),
      totalOutputTokens: tasks.reduce((a, t) => a + t.outputTokens, 0),
      avgRetries: tasks.reduce((a, t) => a + t.retries, 0) / tasks.length,
    });
  }
  // Most expensive task types first — that's where routing wins matter.
  byTaskType.sort((a, b) => b.totalUsd - a.totalUsd);

  return {
    byTaskType,
    totalUsd: rollups.reduce((a, r) => a + r.costUsd, 0),
    taskCount: rollups.length,
    callCount: lines.length,
  };
}

/**
 * Nearest-rank percentile over a pre-sorted ascending array. Returns 0 for an
 * empty array. `p` is 0–100.
 */
export function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0]!;
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, rank - 1));
  return sortedAsc[idx]!;
}

const usd = (n: number): string => `$${n.toFixed(4)}`;

/**
 * Render a {@link CostReport} as a fixed-width text table for `rly cost`.
 * Pure (returns a string) so it's testable without capturing stdout.
 */
export function renderCostReport(report: CostReport): string {
  if (report.taskCount === 0) {
    return "No task costs recorded yet. Run some tickets, then `rly cost`.";
  }

  const header = ["TASK TYPE", "TASKS", "MEAN", "MEDIAN", "P90", "TOTAL", "AVG RETRIES"];
  const rows = report.byTaskType.map((a) => [
    a.taskType,
    String(a.taskCount),
    usd(a.meanUsd),
    usd(a.medianUsd),
    usd(a.p90Usd),
    usd(a.totalUsd),
    a.avgRetries.toFixed(2),
  ]);

  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const fmt = (cells: string[]): string => cells.map((c, i) => c.padEnd(widths[i]!)).join("  ");

  const lines = [
    `Cost per task by type — ${report.taskCount} tasks, ${report.callCount} calls, ${usd(report.totalUsd)} total`,
    "",
    fmt(header),
    widths.map((w) => "-".repeat(w)).join("  "),
    ...rows.map(fmt),
  ];
  return lines.join("\n");
}
