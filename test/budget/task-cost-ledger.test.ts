import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { TaskCostLedger } from "../../src/budget/task-cost-ledger.js";
import { __resetPricingWarnedForTests } from "../../src/domain/model-pricing.js";

afterEach(() => {
  __resetPricingWarnedForTests();
  vi.restoreAllMocks();
});

describe("TaskCostLedger", () => {
  it("records a call, computes costUsd, and round-trips via readAll", async () => {
    const dir = await mkdtemp(join(tmpdir(), "task-cost-"));
    try {
      const ledger = new TaskCostLedger({ rootDir: dir });
      await ledger.record({
        runId: "run-1",
        ticketId: "t-1",
        taskType: "feature_small",
        workKind: "implement_phase",
        attempt: 1,
        model: "claude-sonnet-4-5",
        tokenUsage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      });

      const lines = await ledger.readAll();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        runId: "run-1",
        ticketId: "t-1",
        taskType: "feature_small",
        workKind: "implement_phase",
        model: "claude-sonnet-4-5",
      });
      // Sonnet: $3/MTok in + $15/MTok out.
      expect(lines[0]!.costUsd).toBeCloseTo(3 + 15, 6);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("bills $0 (with a warning) when the model is missing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dir = await mkdtemp(join(tmpdir(), "task-cost-"));
    try {
      const ledger = new TaskCostLedger({ rootDir: dir });
      await ledger.record({
        runId: "run-1",
        ticketId: "t-1",
        taskType: "bugfix",
        workKind: "implement_phase",
        attempt: 1,
        model: undefined,
        tokenUsage: { inputTokens: 500, outputTokens: 500 },
      });
      const lines = await ledger.readAll();
      expect(lines[0]!.costUsd).toBe(0);
      expect(lines[0]!.model).toBeUndefined();
      expect(warn).toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("serializes concurrent records without interleaving lines", async () => {
    const dir = await mkdtemp(join(tmpdir(), "task-cost-"));
    try {
      const ledger = new TaskCostLedger({ rootDir: dir });
      await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          ledger.record({
            runId: "run-1",
            ticketId: `t-${i}`,
            taskType: "feature_small",
            workKind: "implement_phase",
            attempt: 1,
            model: "claude-haiku-3-5",
            tokenUsage: { inputTokens: 100, outputTokens: 100 },
          })
        )
      );
      const lines = await ledger.readAll();
      expect(lines).toHaveLength(10);
      expect(new Set(lines.map((l) => l.ticketId)).size).toBe(10);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("skips malformed lines and returns [] for a missing file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "task-cost-"));
    try {
      const ledger = new TaskCostLedger({ rootDir: dir });
      expect(await ledger.readAll()).toEqual([]);

      await ledger.record({
        runId: "run-1",
        ticketId: "t-good",
        taskType: "trivial",
        workKind: "implement_phase",
        attempt: 1,
        model: "gpt-5",
        tokenUsage: { inputTokens: 10, outputTokens: 10 },
      });
      // Append junk + a valid-but-old-shape line.
      await writeFile(ledger.path, "not json\n{}\n", { flag: "a" });

      const lines = await ledger.readAll();
      expect(lines).toHaveLength(1);
      expect(lines[0]!.ticketId).toBe("t-good");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
