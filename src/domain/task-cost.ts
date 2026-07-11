import { z } from "zod";

import { ComplexityTierSchema } from "./classification.js";

/**
 * Schema version for a task-cost ledger line. Bump only with a
 * forward-migration story for existing `~/.relay/task-costs.jsonl` lines
 * (the reader in `task-cost-ledger.ts` skips lines it can't parse, so a naive
 * bump silently drops history — migrate instead).
 */
export const TASK_COST_SCHEMA_VERSION = 1 as const;

/**
 * One appended line in `~/.relay/task-costs.jsonl` — the USD cost of a SINGLE
 * agent call (one `agent.run()` / executor run), tagged with the task it
 * belongs to. Per-call granularity on disk; the report
 * (`orchestrator/cost-report.ts`) rolls these up **by `ticketId`** into
 * per-task totals, then groups tasks **by `taskType`**. That's the
 * "attributed to the task, not the individual call" contract: a task's cost
 * is the sum of every call's cost, retries included.
 *
 * `taskType` is the run's {@link ComplexityTier} (one classification per
 * feature request; every ticket decomposed from it shares that tier). This is
 * the key the cost-aware router (PR 4) branches on.
 */
export const TaskCostCallSchema = z.object({
  schemaVersion: z.literal(TASK_COST_SCHEMA_VERSION),
  ts: z.string().min(1),
  runId: z.string().min(1),
  /** Ticket this call served. For scheduler dispatches this is `ticket.id`. */
  ticketId: z.string().min(1),
  /** The run's complexity tier — the aggregation key for cost-per-task. */
  taskType: ComplexityTierSchema,
  /**
   * The `WorkKind` of the call (`implement_phase`, `run_checks`,
   * `classify_failure`, …). Stored as a plain string rather than importing a
   * zod mirror of the `WorkKind` TS union — the ledger doesn't need to
   * validate it, only carry it for forensics.
   */
  workKind: z.string().min(1),
  /** 1-based attempt number; retries are `max(attempt) - 1` per task. */
  attempt: z.number().int().positive().default(1),
  /** Model that produced this call. Absent → costUsd was billed at $0. */
  model: z.string().optional(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative().optional(),
  cacheWriteTokens: z.number().int().nonnegative().optional(),
  /** USD cost of this call, computed via `costUsd()` at record time. */
  costUsd: z.number().nonnegative(),
});

export type TaskCostCall = z.infer<typeof TaskCostCallSchema>;
