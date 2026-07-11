import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { TaskCostLedger } from "../../src/budget/task-cost-ledger.js";
import { handleCostCommand } from "../../src/cli/cost.js";

class Sink {
  data = "";
  write(chunk: string): boolean {
    this.data += chunk;
    return true;
  }
}

const ORIGINAL_HOME = process.env.HOME;

afterEach(() => {
  process.env.HOME = ORIGINAL_HOME;
});

describe("rly cost", () => {
  it("renders the aggregated table from ~/.relay/task-costs.jsonl", async () => {
    const home = await mkdtemp(join(tmpdir(), "rly-cost-home-"));
    try {
      // The CLI's ledger reads from ~/.relay; point HOME at a tmp dir and
      // seed it via a ledger rooted at the same place.
      process.env.HOME = home;
      const ledger = new TaskCostLedger({ rootDir: join(home, ".relay") });
      await ledger.record({
        runId: "r",
        ticketId: "t-1",
        taskType: "feature_small",
        workKind: "implement_phase",
        attempt: 1,
        model: "claude-sonnet-4-5",
        tokenUsage: { inputTokens: 1_000_000, outputTokens: 0 },
      });
      await ledger.flush();

      const stdout = new Sink();
      const stderr = new Sink();
      const res = await handleCostCommand({ argv: [], stdout, stderr });

      expect(res.exitCode).toBe(0);
      expect(stdout.data).toContain("feature_small");
      expect(stdout.data).toContain("$3.0000"); // 1M input @ $3/MTok
      expect(stderr.data).toBe("");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("emits JSON with --json", async () => {
    const home = await mkdtemp(join(tmpdir(), "rly-cost-home-"));
    try {
      process.env.HOME = home;
      const ledger = new TaskCostLedger({ rootDir: join(home, ".relay") });
      await ledger.record({
        runId: "r",
        ticketId: "t-1",
        taskType: "trivial",
        workKind: "implement_phase",
        attempt: 1,
        model: "gpt-5",
        tokenUsage: { inputTokens: 10, outputTokens: 10 },
      });
      await ledger.flush();

      const stdout = new Sink();
      const stderr = new Sink();
      const res = await handleCostCommand({ argv: ["--json"], stdout, stderr });

      expect(res.exitCode).toBe(0);
      const parsed = JSON.parse(stdout.data);
      expect(parsed.taskCount).toBe(1);
      expect(parsed.byTaskType[0].taskType).toBe("trivial");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("exits 0 with a hint when the ledger is empty", async () => {
    const home = await mkdtemp(join(tmpdir(), "rly-cost-home-"));
    try {
      process.env.HOME = home;
      const stdout = new Sink();
      const stderr = new Sink();
      const res = await handleCostCommand({ argv: [], stdout, stderr });
      expect(res.exitCode).toBe(0);
      expect(stdout.data).toContain("No task costs recorded yet");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
