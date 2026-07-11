import { TaskCostLedger } from "../budget/task-cost-ledger.js";
import { buildCostReport, renderCostReport } from "../orchestrator/cost-report.js";

/** Minimal writable sink — satisfied by `process.stdout` and test doubles. */
export interface CostWriter {
  write(chunk: string): unknown;
}

export interface CostCommandInput {
  argv: string[];
  stdout: CostWriter;
  stderr: CostWriter;
  env?: NodeJS.ProcessEnv;
}

export interface CostCommandResult {
  exitCode: number;
}

/**
 * `rly cost` — aggregate the per-task cost ledger
 * (`~/.relay/task-costs.jsonl`) into cost-per-task by complexity tier.
 *
 * Flags:
 *   --json   Emit the raw {@link CostReport} as JSON instead of the table.
 *
 * Read-only: never mutates the ledger. Exits 0 even when the ledger is empty
 * (prints a hint) so scripting `rly cost` doesn't fail a fresh install.
 */
export async function handleCostCommand(input: CostCommandInput): Promise<CostCommandResult> {
  const asJson = input.argv.includes("--json");
  const ledger = new TaskCostLedger();

  let report;
  try {
    const lines = await ledger.readAll();
    report = buildCostReport(lines);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    input.stderr.write(`rly cost: failed to read ${ledger.path}: ${message}\n`);
    return { exitCode: 1 };
  }

  if (asJson) {
    input.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    input.stdout.write(renderCostReport(report) + "\n");
  }
  return { exitCode: 0 };
}
