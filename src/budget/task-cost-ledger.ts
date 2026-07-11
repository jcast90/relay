import { appendFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { TokenUsage } from "../domain/agent.js";
import type { ComplexityTier } from "../domain/classification.js";
import { costUsd } from "../domain/model-pricing.js";
import {
  TASK_COST_SCHEMA_VERSION,
  TaskCostCallSchema,
  type TaskCostCall,
} from "../domain/task-cost.js";

/** Input to {@link TaskCostLedger.record} — the parts a caller knows. */
export interface TaskCostRecordInput {
  runId: string;
  ticketId: string;
  taskType: ComplexityTier;
  workKind: string;
  attempt: number;
  model: string | undefined;
  tokenUsage: TokenUsage;
  /** ISO timestamp; defaults to now. Injectable so tests get stable lines. */
  ts?: string;
}

/**
 * Global, append-only per-task cost ledger at `~/.relay/task-costs.jsonl`.
 *
 * One line per agent call (see {@link TaskCostCall}). The ledger is
 * deliberately **global** (not per-run / per-session): `rly cost` and the
 * cost-aware router (PR 4) both need cost history across every run to compute
 * a stable cost-per-task-type. Writes serialize through a promise chain so
 * concurrent `record()` calls from parallel ticket drains never interleave a
 * partial line (mirrors `token-tracker.ts`).
 *
 * `record()` is fire-and-forget from the caller's view but returns the write
 * promise so a run-completion drain can `await` outstanding writes. Cost is
 * computed here (via {@link costUsd}) so callers only supply raw token usage.
 */
export class TaskCostLedger {
  private readonly filePath: string;
  private writeChain: Promise<void> = Promise.resolve();

  /**
   * @param options.rootDir Override `~/.relay` (tests point at a tmp dir).
   */
  constructor(options: { rootDir?: string } = {}) {
    const root = options.rootDir ?? join(homedir(), ".relay");
    this.filePath = join(root, "task-costs.jsonl");
  }

  /** Absolute path to the backing JSONL file (for `rly cost` / tests). */
  get path(): string {
    return this.filePath;
  }

  /**
   * Append one call's cost. Computes `costUsd` from the token usage + model
   * (unknown/missing model → $0 with the `[cost]` warning from
   * model-pricing). Returns the write promise; callers that need durability
   * before proceeding should await it (or {@link flush}).
   */
  record(input: TaskCostRecordInput): Promise<void> {
    const usage = input.tokenUsage;
    const line: TaskCostCall = {
      schemaVersion: TASK_COST_SCHEMA_VERSION,
      ts: input.ts ?? new Date().toISOString(),
      runId: input.runId,
      ticketId: input.ticketId,
      taskType: input.taskType,
      workKind: input.workKind,
      attempt: input.attempt,
      ...(input.model ? { model: input.model } : {}),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      ...(usage.cacheReadTokens ? { cacheReadTokens: usage.cacheReadTokens } : {}),
      ...(usage.cacheWriteTokens ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
      costUsd: costUsd(input.model, usage),
    };

    const serialized = JSON.stringify(line) + "\n";
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, serialized, "utf8");
    });
    return this.writeChain;
  }

  /** Await all in-flight writes. */
  async flush(): Promise<void> {
    await this.writeChain;
  }

  /**
   * Read + parse every ledger line. Malformed or schema-mismatched lines are
   * skipped (forward-compat with hand-edits / future versions) rather than
   * throwing — a torn line must never break `rly cost`. Returns `[]` when the
   * file doesn't exist yet.
   */
  async readAll(): Promise<TaskCostCall[]> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }

    const out: TaskCostCall[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = TaskCostCallSchema.parse(JSON.parse(trimmed));
        out.push(parsed);
      } catch {
        // Skip torn / future-version / hand-edited lines.
      }
    }
    return out;
  }
}
