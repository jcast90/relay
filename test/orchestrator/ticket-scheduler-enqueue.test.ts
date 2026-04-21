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
import { ChannelStore } from "../../src/channels/channel-store.js";
import { LocalArtifactStore } from "../../src/execution/artifact-store.js";
import { FileHarnessStore } from "../../src/storage/file-store.js";
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

interface RecordedEvent {
  type: RunEventType;
  phaseId: string;
  details: Record<string, string>;
}

interface BuildSchedulerOptions {
  dispatchOverride?: (
    run: HarnessRun,
    req: Omit<WorkRequest, "runId">
  ) => Promise<AgentResult>;
  onRecordEvent?: (event: RecordedEvent) => void;
  channelStore?: ChannelStore;
}

/**
 * Build a scheduler whose dispatch always returns success — no verification
 * commands are proposed, so the built-in verification pass sees an empty
 * command list and trivially succeeds.
 */
async function buildScheduler(
  repoRoot: string,
  options: BuildSchedulerOptions = {}
) {
  const registry = new AgentRegistry();
  for (const agent of createLiveAgents({
    cwd: repoRoot,
    invoker: new ScriptedInvoker(repoRoot)
  })) {
    registry.register(agent);
  }

  const artifactStore = new LocalArtifactStore(
    join(repoRoot, "artifacts"),
    new FileHarnessStore(join(repoRoot, "__hs__"))
  );
  const verificationRunner = new VerificationRunner(
    new NodeCommandInvoker(),
    artifactStore
  );

  const dispatched: WorkRequest[] = [];
  const events: RecordedEvent[] = [];

  const defaultDispatch = async (
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

  const dispatch = options.dispatchOverride
    ? async (
        run: HarnessRun,
        req: Omit<WorkRequest, "runId">
      ): Promise<AgentResult> => {
        dispatched.push({ runId: "run-test", ...req });
        return options.dispatchOverride!(run, req);
      }
    : defaultDispatch;

  const scheduler = new TicketScheduler(
    repoRoot,
    artifactStore,
    verificationRunner,
    registry,
    dispatch,
    (_run, type, phaseId, details) => {
      const event: RecordedEvent = { type, phaseId, details };
      events.push(event);
      options.onRecordEvent?.(event);
    },
    { maxConcurrency: 2, channelStore: options.channelStore }
  );

  return { scheduler, dispatched, events, artifactStore };
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

  it("surfaces tail-drain failures through recordEvent and keeps the chain alive", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "ts-enqueue-tail-"));
    const warnCalls: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnCalls.push(args.map((a) => String(a)).join(" "));
    };

    try {
      const run = buildRun(tmp, [ticket("t_seed")]);

      // Throw synchronously from dispatch for the poison ticket only. Because
      // executeTicket's `.then(..., onRejected)` catches the rejection, a
      // simple throw there just yields success=false. To force drain itself
      // to throw, throw from recordEvent on TicketStarted for that ticket —
      // that call site is outside the executeTicket catch and bubbles up.
      const { scheduler, events } = await buildScheduler(tmp, {
        onRecordEvent: (ev) => {
          if (ev.type === "TicketStarted" && ev.phaseId === "t_poison") {
            throw new Error("boom: synthetic drain failure");
          }
        }
      });

      // Pre-seed the run via executeAll so the scheduler is idle when the
      // first enqueue lands and takes the fresh-drain branch.
      await scheduler.executeAll(run);

      // First enqueue: the poison ticket. Drain will throw when recordEvent
      // fires for TicketStarted. The outer `await next` must rethrow.
      let firstError: unknown = null;
      try {
        await scheduler.enqueue(run, ticket("t_poison"));
      } catch (err) {
        firstError = err;
      }
      expect(firstError).toBeInstanceOf(Error);
      expect(String(firstError)).toContain("boom: synthetic drain failure");

      // Second enqueue: a clean ticket. The chain should still be alive and
      // this one must schedule and complete normally.
      await scheduler.enqueue(run, ticket("t_clean"));
      const clean = run.ticketLedger.find((t) => t.ticketId === "t_clean");
      expect(clean?.status).toBe("completed");

      // The tail-drain failure must be visible: either a recordEvent with the
      // sentinel phaseId, or a console.warn with the scheduler prefix. The
      // production code emits both, but we accept either so the test doesn't
      // pin a specific implementation detail beyond visibility.
      const tailEvent = events.find(
        (e) => e.phaseId === "__scheduler_tail__"
      );
      const tailWarn = warnCalls.find((w) =>
        w.includes("[scheduler] tail drain failed")
      );
      expect(tailEvent || tailWarn).toBeTruthy();
      if (tailEvent) {
        expect(tailEvent.details.error).toContain(
          "boom: synthetic drain failure"
        );
      }
      if (tailWarn) {
        expect(tailWarn).toContain("boom: synthetic drain failure");
      }
    } finally {
      console.warn = originalWarn;
      await rm(tmp, { recursive: true, force: true });
    }
  }, 30_000);

  // The scheduler's activeRun gating assumes at most one executeAll(run) is
  // in flight at a time. The code does NOT raise or short-circuit on overlap;
  // both calls share the same mutable ledger and each drain has its own local
  // `executing` map. This test pins the observed contract: both promises
  // resolve, the ledger settles to terminal states, and activeRun is cleared
  // afterwards. It intentionally does NOT assert that the same ticket is
  // dispatched exactly once — the current code permits double-dispatch in a
  // race window between getReadyTickets() and updateTicketStatus("executing"),
  // which is a latent bug flagged separately.
  it("does not corrupt activeRun when two executeAll calls overlap", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "ts-executeall-overlap-"));
    try {
      const run = buildRun(tmp, [ticket("t_one"), ticket("t_two")]);
      const { scheduler } = await buildScheduler(tmp);

      const a = scheduler.executeAll(run);
      const b = scheduler.executeAll(run);

      // Neither call should throw — the scheduler has no guard against
      // overlap today. Both drains walk the shared ledger.
      const [resA, resB] = await Promise.all([a, b]);

      // Both calls return booleans (exact values are a function of the race,
      // so we just assert the promise shape resolved cleanly).
      expect(typeof resA).toBe("boolean");
      expect(typeof resB).toBe("boolean");

      // Every ticket must have reached a terminal state — nothing stuck in
      // "executing" / "verifying" / "retry" / "ready".
      for (const entry of run.ticketLedger) {
        expect(["completed", "failed"]).toContain(entry.status);
      }

      // activeRun should be cleared once both drains are done, so a fresh
      // enqueue takes the fresh-drain branch cleanly.
      // (Inspected via behavior: enqueue a new ticket and confirm it runs.)
      await scheduler.enqueue(run, ticket("t_after"));
      const after = run.ticketLedger.find((t) => t.ticketId === "t_after");
      expect(after?.status).toBe("completed");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("TicketScheduler channel board mirror", () => {
  it("mirrors every persistTicketLedger to the channel board", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "ts-mirror-"));
    try {
      const channelStore = new ChannelStore(join(tmp, "channels"));
      const channel = await channelStore.createChannel({
        name: "#mirror",
        description: "mirror test"
      });

      const run = buildRun(tmp, [ticket("t_a"), ticket("t_b")]);
      run.channelId = channel.channelId;

      const { scheduler } = await buildScheduler(tmp, { channelStore });
      const ok = await scheduler.executeAll(run);
      expect(ok).toBe(true);

      const boardTickets = await channelStore.readChannelTickets(channel.channelId);
      expect(boardTickets).toHaveLength(2);
      const byId = new Map(boardTickets.map((t) => [t.ticketId, t]));
      expect(byId.get("t_a")?.status).toBe("completed");
      expect(byId.get("t_b")?.status).toBe("completed");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }, 30_000);

  it("keeps the scheduler loop alive when the mirror throws", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "ts-mirror-fail-"));
    const warnCalls: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnCalls.push(args.map((a) => String(a)).join(" "));
    };

    try {
      const channelStore = new ChannelStore(join(tmp, "channels"));
      const channel = await channelStore.createChannel({
        name: "#mirror-fail",
        description: "mirror failure test"
      });
      channelStore.upsertChannelTickets = async () => {
        throw new Error("simulated mirror failure");
      };

      const run = buildRun(tmp, [ticket("t_a")]);
      run.channelId = channel.channelId;

      const { scheduler, events } = await buildScheduler(tmp, { channelStore });
      const ok = await scheduler.executeAll(run);

      expect(ok).toBe(true);
      const entry = run.ticketLedger.find((t) => t.ticketId === "t_a");
      expect(entry?.status).toBe("completed");

      const mirrorWarn = warnCalls.find((w) =>
        w.includes("[scheduler] channel board mirror failed")
      );
      const mirrorEvent = events.find(
        (e) => e.phaseId === "__channel_mirror__"
      );
      expect(mirrorWarn || mirrorEvent).toBeTruthy();
    } finally {
      console.warn = originalWarn;
      await rm(tmp, { recursive: true, force: true });
    }
  }, 30_000);

  it("serializes concurrent upserts on the same channel (no lost updates)", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "ts-mirror-concurrent-"));
    try {
      const channelStore = new ChannelStore(join(tmp, "channels"));
      const channel = await channelStore.createChannel({
        name: "#concurrent",
        description: "concurrency test"
      });

      // Two disjoint upserts fired at once. If upsert read-modified-wrote
      // without a mutex, one would clobber the other (both read empty, both
      // write their single ticket). With the mutex, both survive.
      const [a] = initializeTicketLedger([ticket("t_a")], "run-a");
      const [b] = initializeTicketLedger([ticket("t_b")], "run-b");

      await Promise.all([
        channelStore.upsertChannelTickets(channel.channelId, [a]),
        channelStore.upsertChannelTickets(channel.channelId, [b])
      ]);

      const board = await channelStore.readChannelTickets(channel.channelId);
      const ids = board.map((t) => t.ticketId).sort();
      expect(ids).toEqual(["t_a", "t_b"]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }, 30_000);
});
