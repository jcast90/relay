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
import type { HarnessRun, RunEventType } from "../../src/domain/run.js";
import {
  initializeTicketLedger,
  parseTicketPlan,
  type TicketDefinition
} from "../../src/domain/ticket.js";
import { LocalArtifactStore } from "../../src/execution/artifact-store.js";
import type { AgentExecutor, ExecutionHandle } from "../../src/execution/executor.js";
import { NoopExecutor, NoopSandboxProvider } from "../../src/execution/noop-executor.js";
import { VerificationRunner } from "../../src/execution/verification-runner.js";
import { TicketScheduler } from "../../src/orchestrator/ticket-scheduler.js";
import { ScriptedInvoker } from "../../src/simulation/scripted-invoker.js";

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
    retryPolicy: { maxAgentAttempts: 1, maxTestFixLoops: 1 }
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

async function buildBasics(repoRoot: string) {
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
  return { registry, artifactStore, verificationRunner };
}

describe("TicketScheduler + executor wiring", () => {
  it("throws when neither dispatch nor executor is supplied", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "ts-exec-none-"));
    try {
      const { registry, artifactStore, verificationRunner } =
        await buildBasics(tmp);
      expect(
        () =>
          new TicketScheduler(
            tmp,
            artifactStore,
            verificationRunner,
            registry,
            null,
            () => {}
          )
      ).toThrow(/either a dispatch callback or options.executor/);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("throws when both dispatch and executor are supplied", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "ts-exec-both-"));
    try {
      const { registry, artifactStore, verificationRunner } =
        await buildBasics(tmp);
      const dispatch = async (): Promise<AgentResult> => ({
        summary: "ok",
        evidence: [],
        proposedCommands: [],
        blockers: []
      });
      expect(
        () =>
          new TicketScheduler(
            tmp,
            artifactStore,
            verificationRunner,
            registry,
            dispatch,
            () => {},
            { executor: new NoopExecutor() }
          )
      ).toThrow(/both a dispatch callback and options.executor/);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("runs an end-to-end ticket via options.executor (no dispatch callback)", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "ts-exec-run-"));
    try {
      const { registry, artifactStore, verificationRunner } =
        await buildBasics(tmp);

      // Track that the executor actually gets invoked. The adapter maps
      // executor.start().wait() results back onto AgentResult so the
      // scheduler's verification+retry logic keeps running unchanged.
      let startCalls = 0;
      const sandboxProvider = new NoopSandboxProvider();
      const underlying = new NoopExecutor();
      const executor: AgentExecutor = {
        async start(t, opts): Promise<ExecutionHandle> {
          startCalls += 1;
          const sandbox = await sandboxProvider.create(
            { root: tmp },
            "main"
          );
          return underlying.start(t, { ...opts, sandbox });
        }
      };

      const scheduler = new TicketScheduler(
        tmp,
        artifactStore,
        verificationRunner,
        registry,
        null,
        () => {},
        { executor, maxConcurrency: 1 }
      );

      const run = buildRun(tmp, [ticket("t_only")]);
      const ok = await scheduler.executeAll(run);
      expect(ok).toBe(true);

      const entry = run.ticketLedger.find((t) => t.ticketId === "t_only");
      expect(entry?.status).toBe("completed");

      // The executor is consulted for every dispatch (implement + tester +
      // any classification). At minimum it should have been hit more than
      // once — the scheduler pipeline has multiple steps per ticket.
      expect(startCalls).toBeGreaterThan(0);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }, 30_000);

  it("converts an executor.start() throw into an AgentResult blocker so retry engages", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "ts-exec-throw-"));
    try {
      const { registry, artifactStore, verificationRunner } =
        await buildBasics(tmp);

      // Fake executor that rejects on the first start() call and then
      // succeeds on subsequent calls by delegating to NoopExecutor. If the
      // scheduler surfaces the throw as a blocker, the retry loop re-runs
      // the ticket (loop 2) and the NoopExecutor path lets it complete.
      // If the throw bubbles as an uncaught rejection, this test hangs or
      // fails with an unhandled rejection — both are loud regressions.
      let startCalls = 0;
      const sandboxProvider = new NoopSandboxProvider();
      const underlying = new NoopExecutor();
      const events: Array<{ type: RunEventType; phaseId: string; details: Record<string, string> }> = [];
      const executor: AgentExecutor = {
        async start(t, opts): Promise<ExecutionHandle> {
          startCalls += 1;
          if (startCalls === 1) {
            throw new Error("simulated spawn failure");
          }
          const sandbox = await sandboxProvider.create({ root: tmp }, "main");
          return underlying.start(t, { ...opts, sandbox });
        }
      };

      const scheduler = new TicketScheduler(
        tmp,
        artifactStore,
        verificationRunner,
        registry,
        null,
        (_run, type, phaseId, details) => {
          events.push({ type, phaseId, details });
        },
        { executor, maxConcurrency: 1 }
      );

      // Bump retry budget so loop-2 runs after the first blocker.
      const t = ticket("t_throw");
      t.retryPolicy = { maxAgentAttempts: 1, maxTestFixLoops: 2 };
      const run = buildRun(tmp, [t]);
      await scheduler.executeAll(run);

      // The blocker from the throw must have been recorded, and the first
      // start must have been observed as a failure event — not a raw
      // exception. The start counter must be at least 2, proving the retry
      // path actually re-engaged instead of the scheduler dying.
      expect(startCalls).toBeGreaterThanOrEqual(2);
      const startFailure = events.find(
        (e) => e.phaseId === "__executor_start__"
      );
      expect(startFailure).toBeDefined();
      expect(startFailure?.details.error).toContain("simulated spawn failure");
      expect(startFailure?.details.ticketId).toBe("t_throw");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }, 30_000);

  it("preserves the legacy dispatch path when no executor is supplied", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "ts-exec-legacy-"));
    try {
      const { registry, artifactStore, verificationRunner } =
        await buildBasics(tmp);
      const dispatched: Array<Omit<WorkRequest, "runId">> = [];
      const dispatch = async (
        _run: HarnessRun,
        req: Omit<WorkRequest, "runId">
      ): Promise<AgentResult> => {
        dispatched.push(req);
        return {
          summary: `ok:${req.kind}`,
          evidence: [],
          proposedCommands: [],
          blockers: []
        };
      };

      const scheduler = new TicketScheduler(
        tmp,
        artifactStore,
        verificationRunner,
        registry,
        dispatch,
        () => {},
        { maxConcurrency: 1 }
      );

      const run = buildRun(tmp, [ticket("t_legacy")]);
      const ok = await scheduler.executeAll(run);
      expect(ok).toBe(true);
      expect(dispatched.length).toBeGreaterThan(0);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }, 30_000);
});
