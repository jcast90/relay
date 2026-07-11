import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { NodeCommandInvoker } from "../../src/agents/command-invoker.js";
import { createLiveAgents } from "../../src/agents/factory.js";
import { AgentRegistry } from "../../src/agents/registry.js";
import type { AgentResult } from "../../src/domain/agent.js";
import type { HarnessRun } from "../../src/domain/run.js";
import {
  initializeTicketLedger,
  parseTicketPlan,
  type TicketDefinition,
} from "../../src/domain/ticket.js";
import { LocalArtifactStore } from "../../src/execution/artifact-store.js";
import { FileHarnessStore } from "../../src/storage/file-store.js";
import { VerificationRunner } from "../../src/execution/verification-runner.js";
import { TicketScheduler } from "../../src/orchestrator/ticket-scheduler.js";
import { ScriptedInvoker } from "../../src/simulation/scripted-invoker.js";
import { TaskCostLedger } from "../../src/budget/task-cost-ledger.js";

function ticket(id: string): TicketDefinition {
  return {
    id,
    title: `Ticket ${id}`,
    objective: `Do ${id}`,
    specialty: "general",
    acceptanceCriteria: ["Complete the work"],
    allowedCommands: [],
    verificationCommands: [],
    docsToUpdate: [],
    dependsOn: [],
    retryPolicy: { maxAgentAttempts: 1, maxTestFixLoops: 1 },
  };
}

function buildRun(repoRoot: string, tickets: TicketDefinition[]): HarnessRun {
  const now = new Date().toISOString();
  const ticketPlan = parseTicketPlan({
    version: 1,
    task: { title: "Test run", featureRequest: "Test feature", repoRoot },
    classification: {
      tier: "feature_small",
      rationale: "test",
      suggestedSpecialties: ["general"],
      estimatedTicketCount: tickets.length,
      needsDesignDoc: false,
      needsUserApproval: false,
    },
    tickets,
    finalVerification: { commands: [] },
    docsToUpdate: [],
  });
  return {
    id: "run-cost",
    featureRequest: "Test feature",
    state: "TICKETS_EXECUTING",
    startedAt: now,
    updatedAt: now,
    completedAt: null,
    channelId: null,
    classification: ticketPlan.classification,
    plan: null,
    ticketPlan,
    events: [],
    evidence: [],
    artifacts: [],
    phaseLedger: [],
    phaseLedgerPath: null,
    ticketLedger: initializeTicketLedger(tickets),
    ticketLedgerPath: null,
    runIndexPath: null,
  };
}

async function buildBasics(repoRoot: string) {
  const registry = new AgentRegistry();
  for (const agent of createLiveAgents({ cwd: repoRoot, invoker: new ScriptedInvoker(repoRoot) })) {
    registry.register(agent);
  }
  const artifactStore = new LocalArtifactStore(
    join(repoRoot, "artifacts"),
    new FileHarnessStore(join(repoRoot, "__hs__"))
  );
  const verificationRunner = new VerificationRunner(new NodeCommandInvoker(), artifactStore);
  return { registry, artifactStore, verificationRunner };
}

describe("TicketScheduler per-task cost recording", () => {
  it("records a costed ledger line per dispatch, attributed to the ticket + tier", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "ts-cost-"));
    try {
      const { registry, artifactStore, verificationRunner } = await buildBasics(tmp);
      const ledger = new TaskCostLedger({ rootDir: tmp });

      // Dispatch callback returns usage + model so the wrapper prices + records.
      const dispatch = async (): Promise<AgentResult> => ({
        summary: "ok",
        evidence: [],
        proposedCommands: [],
        blockers: [],
        model: "claude-sonnet-4-5",
        tokenUsage: { inputTokens: 1_000_000, outputTokens: 0 },
      });

      const scheduler = new TicketScheduler(
        tmp,
        artifactStore,
        verificationRunner,
        registry,
        dispatch,
        () => {},
        { costLedger: ledger, maxConcurrency: 1 }
      );

      const run = buildRun(tmp, [ticket("t_only")]);
      await scheduler.executeAll(run);
      await ledger.flush();

      const lines = await ledger.readAll();
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line.ticketId).toBe("t_only");
        expect(line.taskType).toBe("feature_small");
        expect(line.model).toBe("claude-sonnet-4-5");
        expect(line.costUsd).toBeCloseTo(3, 6); // 1M input @ $3/MTok
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }, 30_000);

  it("skips an unclassified run rather than attributing it to a guessed tier", async () => {
    // `taskType` used to default to "feature_small" when a run had no
    // classification. `rly cost` GROUPS BY taskType, so that doesn't add a data
    // point — it silently corrupts the feature_small bucket with costs from a
    // run of unknown complexity. A gap in the report is honest; a wrong bucket
    // is not.
    const tmp = await mkdtemp(join(tmpdir(), "ts-cost-unclassified-"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { registry, artifactStore, verificationRunner } = await buildBasics(tmp);
      const ledger = new TaskCostLedger({ rootDir: tmp });

      const dispatch = async (): Promise<AgentResult> => ({
        summary: "ok",
        evidence: [],
        proposedCommands: [],
        blockers: [],
        model: "claude-sonnet-4-5",
        tokenUsage: { inputTokens: 1_000_000, outputTokens: 0 },
      });

      const scheduler = new TicketScheduler(
        tmp,
        artifactStore,
        verificationRunner,
        registry,
        dispatch,
        () => {},
        { costLedger: ledger, maxConcurrency: 1 }
      );

      const run = buildRun(tmp, [ticket("t_only")]);
      run.classification = null;

      await scheduler.executeAll(run);
      await ledger.flush();

      expect(await ledger.readAll(), "unclassified costs must not land in a tier").toEqual([]);
      expect(warn.mock.calls.some((c) => String(c[0]).includes("no classification tier"))).toBe(
        true
      );
    } finally {
      warn.mockRestore();
      await rm(tmp, { recursive: true, force: true });
    }
  }, 30_000);

  it("writes nothing when no ledger is configured", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "ts-cost-none-"));
    try {
      const { registry, artifactStore, verificationRunner } = await buildBasics(tmp);
      const dispatch = async (): Promise<AgentResult> => ({
        summary: "ok",
        evidence: [],
        proposedCommands: [],
        blockers: [],
        model: "claude-sonnet-4-5",
        tokenUsage: { inputTokens: 100, outputTokens: 0 },
      });
      const scheduler = new TicketScheduler(
        tmp,
        artifactStore,
        verificationRunner,
        registry,
        dispatch,
        () => {},
        { maxConcurrency: 1 }
      );
      const run = buildRun(tmp, [ticket("t_only")]);
      // Should not throw despite no ledger.
      await expect(scheduler.executeAll(run)).resolves.toBeDefined();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }, 30_000);
});
