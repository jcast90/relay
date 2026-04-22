import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
import { ChannelStore } from "../../src/channels/channel-store.js";
import { LocalArtifactStore } from "../../src/execution/artifact-store.js";
import { FileHarnessStore } from "../../src/storage/file-store.js";
import { VerificationRunner } from "../../src/execution/verification-runner.js";
import { TicketScheduler } from "../../src/orchestrator/ticket-scheduler.js";
import { ScriptedInvoker } from "../../src/simulation/scripted-invoker.js";

const RETRY_POLICY = { maxAgentAttempts: 1, maxTestFixLoops: 1 } as const;

function buildTicket(
  id: string,
  verificationCommands: string[]
): TicketDefinition {
  return {
    id,
    title: `Ticket ${id}`,
    objective: `Do ${id}`,
    specialty: "general",
    acceptanceCriteria: ["Complete the work"],
    allowedCommands: [],
    verificationCommands,
    docsToUpdate: [],
    dependsOn: [],
    retryPolicy: { ...RETRY_POLICY }
  };
}

function buildRun(
  repoRoot: string,
  tickets: TicketDefinition[],
  channelId: string
): HarnessRun {
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
    id: "run-ver-override",
    featureRequest: "Test feature",
    state: "TICKETS_EXECUTING",
    startedAt: now,
    updatedAt: now,
    completedAt: null,
    channelId,
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

describe("TicketScheduler verification override surfaces to channel feed", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "ver-override-feed-"));
  });

  afterEach(async () => {
    // Same cleanup hardening as orchestrator-v2.test.ts — the scheduler
    // drains its own tracked writes in executeAll, but a retrying rm is
    // cheap insurance against kernel-level tmpdir timing on CI (ENOTEMPTY).
    await rm(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it("posts a 'verification override' status entry when the agent proposes a non-allowlisted command", async () => {
    const channelStore = new ChannelStore(join(tmp, "channels"));
    const channel = await channelStore.createChannel({
      name: "#ver-override",
      description: "override test"
    });

    const registry = new AgentRegistry();
    for (const agent of createLiveAgents({
      cwd: tmp,
      invoker: new ScriptedInvoker(tmp)
    })) {
      registry.register(agent);
    }

    const artifactStore = new LocalArtifactStore(
      join(tmp, "artifacts"),
      new FileHarnessStore(join(tmp, "__hs__"))
    );
    const verificationRunner = new VerificationRunner(
      new NodeCommandInvoker(),
      artifactStore
    );

    // The tester dispatch proposes a command that is not on the ticket's
    // allowlist. The scheduler must (a) fall back to the allowlist for
    // execution and (b) post an override entry to the channel feed.
    const dispatch = async (
      _run: HarnessRun,
      req: Omit<WorkRequest, "runId">
    ): Promise<AgentResult> => {
      if (req.kind === "run_checks") {
        return {
          summary: "proposed bogus commands",
          evidence: [],
          proposedCommands: ["rm -rf /tmp/nope"],
          blockers: []
        };
      }
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
      () => {
        /* no-op recordEvent */
      },
      { maxConcurrency: 1, channelStore }
    );

    const run = buildRun(
      tmp,
      [buildTicket("t_override", ["echo allowlisted"])],
      channel.channelId
    );

    await scheduler.executeAll(run);

    // `executeAll` drains the scheduler's tracked best-effort writes before
    // returning (see TicketScheduler.waitForPendingWrites), so the override
    // feed entry is visible here without a sleep workaround.
    const entries = await channelStore.readFeed(channel.channelId);
    const override = entries.find(
      (e) =>
        e.type === "status_update" &&
        e.content.startsWith("Verification override")
    );
    expect(override).toBeDefined();
    expect(override!.fromDisplayName).toBe("Verifier");
    expect(override!.metadata.runId).toBe(run.id);
    expect(override!.metadata.ticketId).toBe("t_override");
    // The verifier tag encodes both the pass/fail state and the override.
    expect(String(override!.metadata.verification)).toMatch(
      /passed-with-override|failed-with-override/
    );
    expect(override!.metadata.rejectedCommands).toEqual(["rm -rf /tmp/nope"]);
    expect(override!.metadata.substitutedCommands).toEqual(["echo allowlisted"]);
  }, 30_000);
});
