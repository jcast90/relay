import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { NodeCommandInvoker } from "../../src/agents/command-invoker.js";
import { createLiveAgents } from "../../src/agents/factory.js";
import { AgentRegistry } from "../../src/agents/registry.js";
import type {
  AgentResult,
  WorkRequest
} from "../../src/domain/agent.js";
import type { HarnessRun } from "../../src/domain/run.js";
import {
  initializeTicketLedger,
  parseTicketPlan,
  type TicketDefinition
} from "../../src/domain/ticket.js";
import { LocalArtifactStore } from "../../src/execution/artifact-store.js";
import { VerificationRunner } from "../../src/execution/verification-runner.js";
import { TicketScheduler } from "../../src/orchestrator/ticket-scheduler.js";
import { ScriptedInvoker } from "../../src/simulation/scripted-invoker.js";

const RETRY_POLICY = { maxAgentAttempts: 1, maxTestFixLoops: 1 } as const;

function ticket(id: string, title = `Ticket ${id}`): TicketDefinition {
  return {
    id,
    title,
    objective: `Do ${id}`,
    specialty: "general",
    acceptanceCriteria: ["Complete the work"],
    allowedCommands: [],
    verificationCommands: [],
    docsToUpdate: [],
    dependsOn: [],
    retryPolicy: { ...RETRY_POLICY }
  };
}

function buildRun(repoRoot: string, tickets: TicketDefinition[]): HarnessRun {
  const now = new Date().toISOString();
  const ticketPlan = parseTicketPlan({
    version: 1,
    task: {
      title: "Test run",
      featureRequest: "Test feature",
      repoRoot
    },
    classification: {
      tier: "feature_small",
      rationale: "test",
      suggestedSpecialties: ["general"],
      estimatedTicketCount: tickets.length,
      needsDesignDoc: false,
      needsUserApproval: false
    },
    tickets,
    finalVerification: { commands: [] },
    docsToUpdate: []
  });

  return {
    id: "run-test",
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
    runIndexPath: null
  };
}

/**
 * Build a scheduler whose dispatch always returns success — no verification
 * commands are proposed, so the built-in verification pass sees an empty
 * command list and trivially succeeds.
 */
async function buildScheduler(repoRoot: string) {
  const registry = new AgentRegistry();
  for (const agent of createLiveAgents({
    cwd: repoRoot,
    invoker: new ScriptedInvoker(repoRoot)
  })) {
    registry.register(agent);
  }

  const artifactStore = new LocalArtifactStore(join(repoRoot, "artifacts"));
  const verificationRunner = new VerificationRunner(
    new NodeCommandInvoker(),
    artifactStore
  );

  const dispatched: WorkRequest[] = [];
  const dispatch = async (
    _run: HarnessRun,
    req: Omit<WorkRequest, "runId">
  ): Promise<AgentResult> => {
    dispatched.push({ runId: "run-test", ...req });
    return {
      summary: `ok:${req.kind}`,
      evidence: [],
      proposedCommands: [],
      blockers: []
    };
  };

  const scheduler = new TicketScheduler(
    repoRoot,
    artifactStore,
    verificationRunner,
    registry,
    dispatch,
    () => {
      /* no-op event recorder */
    },
    { maxConcurrency: 2 }
  );

  return { scheduler, dispatched, artifactStore };
}

describe("TicketScheduler.enqueue", () => {
  it("executes a ticket enqueued after executeAll has resolved", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "ts-enqueue-"));
    try {
      const run = buildRun(tmp, [ticket("t_initial")]);
      const { scheduler } = await buildScheduler(tmp);

      const ok = await scheduler.executeAll(run);
      expect(ok).toBe(true);

      const initial = run.ticketLedger.find((t) => t.ticketId === "t_initial");
      expect(initial?.status).toBe("completed");

      // Now enqueue a follow-up after executeAll resolved.
      await scheduler.enqueue(run, ticket("t_followup", "Follow-up ticket"));

      const follow = run.ticketLedger.find((t) => t.ticketId === "t_followup");
      expect(follow).toBeDefined();
      expect(follow!.status).toBe("completed");

      // Both tickets ended up in the ledger.
      const ids = run.ticketLedger.map((t) => t.ticketId);
      expect(ids).toEqual(["t_initial", "t_followup"]);

      // And in the ticket plan so snapshots see it.
      expect(run.ticketPlan!.tickets.map((t) => t.id)).toEqual([
        "t_initial",
        "t_followup"
      ]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }, 30_000);

  it("picks up a ticket enqueued while executeAll is mid-flight", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "ts-enqueue-live-"));
    try {
      const run = buildRun(tmp, [ticket("t_a")]);
      const { scheduler } = await buildScheduler(tmp);

      // Kick off executeAll, then enqueue an extra ticket on the next tick so
      // the scheduler sees it while the loop is still alive.
      const execute = scheduler.executeAll(run);
      queueMicrotask(() => {
        void scheduler.enqueue(run, ticket("t_b", "Live enqueue"));
      });

      const ok = await execute;
      expect(ok).toBe(true);

      const ids = run.ticketLedger.map((t) => t.ticketId).sort();
      expect(ids).toEqual(["t_a", "t_b"]);
      for (const entry of run.ticketLedger) {
        expect(entry.status).toBe("completed");
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }, 30_000);

  it("is idempotent on repeated enqueues of the same ticket id", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "ts-enqueue-idem-"));
    try {
      const run = buildRun(tmp, [ticket("t_seed")]);
      const { scheduler } = await buildScheduler(tmp);

      await scheduler.executeAll(run);

      await scheduler.enqueue(run, ticket("t_once"));
      await scheduler.enqueue(run, ticket("t_once"));

      const matches = run.ticketLedger.filter((t) => t.ticketId === "t_once");
      expect(matches).toHaveLength(1);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }, 30_000);
});
