import type { AgentResult, FailureClassification, WorkRequest } from "../domain/agent.js";
import {
  tierNeedsApproval,
  tierNeedsDesignDoc,
  tierSkipsPlanning,
  type ClassificationResult
} from "../domain/classification.js";
import { createSeedPlan } from "../domain/phase-plan.js";
import type {
  ArtifactRecord,
  EvidenceRecord,
  HarnessRun,
  RunEvent,
  RunEventType
} from "../domain/run.js";
import { initializeTicketLedger } from "../domain/ticket.js";
import { assertTransition } from "../domain/state-machine.js";
import type { AgentRegistry } from "../agents/registry.js";
import type { ArtifactStore } from "../execution/artifact-store.js";
import type { VerificationRunner } from "../execution/verification-runner.js";
import type { ChannelStore } from "../channels/channel-store.js";
import { classifyRequest } from "./classifier.js";
import { decomposePlanToTickets, buildTicketPlanFromPhases } from "./ticket-decomposer.js";
import { checkApproval } from "./approval-gate.js";
import { TicketScheduler } from "./ticket-scheduler.js";

/**
 * Anything the orchestrator can hook into for follow-up enqueueing (PR poller,
 * review watcher, etc.). Must expose a `stop()` the orchestrator can call when
 * the run finalizes. Kept as a structural type so the orchestrator does not
 * depend on `@aoagents/*` — callers build and attach pollers from the CLI.
 */
export interface PollerHandle {
  start(): void;
  stop(): void;
}

/** Factory supplied by callers that want a poller built per-run. */
export type PollerFactory = (input: {
  run: HarnessRun;
  scheduler: TicketScheduler;
}) => PollerHandle | null;

export class OrchestratorV2 {
  /** Optional poller factory registered via `attachPoller`. */
  private pollerFactory: PollerFactory | null = null;

  constructor(
    private readonly registry: AgentRegistry,
    private readonly repoRoot: string,
    private readonly verificationRunner: VerificationRunner,
    private readonly artifactStore: ArtifactStore,
    private readonly artifactsDir?: string,
    private readonly channelStore?: ChannelStore,
    private readonly workspaceId?: string
  ) {}

  /**
   * Register a factory that builds a poller (typically a `PrPoller` wired to
   * a `SchedulerFollowUpDispatcher`) once a scheduler exists for the run.
   *
   * Chosen over baking SCM/tracker construction into the orchestrator because
   * the poller needs a `HarnessProject`, a `GITHUB_TOKEN` (optional), and SCM
   * plugin wiring — none of which belong in orchestrator-v2's core contract.
   * The CLI/startup path owns env + project config and is the right place to
   * skip this when `GITHUB_TOKEN` is missing.
   */
  attachPoller(factory: PollerFactory): void {
    this.pollerFactory = factory;
  }

  async run(featureRequest: string, runId?: string): Promise<HarnessRun> {
    const now = new Date().toISOString();
    const run: HarnessRun = {
      id: runId ?? buildRunId(),
      featureRequest,
      state: "CLASSIFYING",
      startedAt: now,
      updatedAt: now,
      completedAt: null,
      channelId: null,
      classification: null,
      plan: null,
      ticketPlan: null,
      events: [],
      evidence: [],
      artifacts: [],
      phaseLedger: [],
      phaseLedgerPath: null,
      ticketLedger: [],
      ticketLedgerPath: null,
      runIndexPath: null
    };

    this.recordEvent(run, "TaskSubmitted", "phase_00", { featureRequest });

    // Create a channel for this run so the dashboard can display it
    if (this.channelStore && this.workspaceId) {
      try {
        const channel = await this.channelStore.createChannel({
          name: featureRequest.slice(0, 60),
          description: featureRequest,
          workspaceIds: [this.workspaceId]
        });
        run.channelId = channel.channelId;
        await this.channelStore.linkRun(channel.channelId, run.id, this.workspaceId);
        await this.channelStore.postEntry(channel.channelId, {
          type: "run_started",
          fromAgentId: null,
          fromDisplayName: "Orchestrator",
          content: `Run started: ${featureRequest}`,
          metadata: { runId: run.id, state: run.state }
        });
      } catch {
        // Channel creation is non-critical — continue without it
      }
    }

    // Step 1: Classify
    const classification = await classifyRequest({
      run,
      featureRequest,
      repoRoot: this.repoRoot,
      dispatch: (r, req) => this.dispatch(r, req)
    });

    run.classification = classification;
    await this.artifactStore.saveClassification({
      runId: run.id,
      classification
    });

    await this.transition(run, "ClassificationComplete", "phase_00");
    this.recordEvent(run, "ClassificationComplete", "phase_00", {
      tier: classification.tier,
      rationale: classification.rationale
    });

    // Step 2: Route by tier
    if (tierSkipsPlanning(classification.tier)) {
      return this.executeTrivial(run, featureRequest, classification);
    }

    // Step 3: Plan
    const planResult = await this.dispatch(run, {
      phaseId: "phase_00",
      kind: "draft_plan",
      specialty: "general",
      title: "Plan feature rollout",
      objective: featureRequest,
      acceptanceCriteria: [
        "Create bounded phases with acceptance criteria.",
        "Include retry policy and verification commands."
      ],
      allowedCommands: [],
      verificationCommands: [],
      docsToUpdate: ["README.md"],
      context: [
        `Repository root: ${this.repoRoot}`,
        `Classification: ${classification.tier} (${classification.rationale})`
      ],
      artifactContext: [],
      attempt: 1,
      maxAttempts: 2,
      priorEvidence: []
    });

    run.plan = planResult.phasePlan ?? createSeedPlan(featureRequest, this.repoRoot);
    await this.transition(run, "PlanGenerated", "phase_00");

    // Step 4: Design doc (architectural tier)
    if (tierNeedsDesignDoc(classification.tier)) {
      const designResult = await this.dispatch(run, {
        phaseId: "phase_00",
        kind: "generate_design_doc",
        specialty: "general",
        title: "Generate design document",
        objective: `Create an architectural design document for: ${featureRequest}`,
        acceptanceCriteria: [
          "Document should cover architecture, trade-offs, and implementation approach.",
          "Include component boundaries and data flow."
        ],
        allowedCommands: [],
        verificationCommands: [],
        docsToUpdate: [],
        context: [
          `Repository root: ${this.repoRoot}`,
          `Plan: ${run.plan.task.title}`,
          ...run.plan.phases.map((p) => `Phase: ${p.title} (${p.specialty})`)
        ],
        artifactContext: [],
        attempt: 1,
        maxAttempts: 2,
        priorEvidence: []
      });

      await this.artifactStore.saveDesignDoc({
        runId: run.id,
        content: designResult.summary
      });
    }

    // Step 5: Decompose to tickets (before approval gate so plan is visible)
    const ticketPlan = await decomposePlanToTickets({
      run,
      plan: run.plan,
      classification,
      repoRoot: this.repoRoot,
      dispatch: (r, req) => this.dispatch(r, req)
    });

    run.ticketPlan = ticketPlan;
    run.ticketLedger = initializeTicketLedger(ticketPlan.tickets);

    await this.artifactStore.saveTicketLedger({
      runId: run.id,
      ticketLedger: run.ticketLedger
    });

    // Step 6: Approval gate or direct ticket execution
    if (tierNeedsApproval(classification.tier)) {
      await this.transition(run, "PlanAwaitingApproval", "phase_00");

      // Non-blocking: check if approval already exists, otherwise return waiting
      const approvalResult = await checkApproval({
        runId: run.id,
        artifactStore: this.artifactStore
      });

      if (!approvalResult) {
        // No approval yet — persist and return. Caller resumes after approval.
        await this.persistRunIndex(run);
        return run;
      }

      if (approvalResult.decision === "rejected") {
        await this.transition(run, "PlanRejected", "phase_00");
        run.completedAt = new Date().toISOString();
        run.updatedAt = run.completedAt;
        await this.persistRunIndex(run);
        return run;
      }

      await this.transition(run, "PlanApproved", "phase_00");
    } else {
      // Non-approval: transition directly to ticket execution
      await this.transition(run, "TicketsCreated", "phase_00");
    }

    this.recordEvent(run, "TicketsCreated", "phase_00", {
      ticketCount: String(ticketPlan.tickets.length)
    });

    const scheduler = new TicketScheduler(
      this.repoRoot,
      this.artifactStore,
      this.verificationRunner,
      this.registry,
      (r, req) => this.dispatch(r, req),
      (r, type, phaseId, details) => this.recordEvent(r, type, phaseId, details)
    );

    const poller = this.startPoller(run, scheduler);

    let allTicketsSucceeded = false;
    try {
      allTicketsSucceeded = await scheduler.executeAll(run);
    } finally {
      poller?.stop();
    }

    if (allTicketsSucceeded) {
      this.recordEvent(run, "AllTicketsComplete", "phase_00", {
        ticketCount: String(run.ticketLedger.length)
      });
    }

    run.completedAt = new Date().toISOString();
    run.updatedAt = run.completedAt;
    await this.persistRunIndex(run);

    if (run.channelId && this.channelStore) {
      await this.channelStore.postEntry(run.channelId, {
        type: "run_completed",
        fromAgentId: null,
        fromDisplayName: "Orchestrator",
        content: `Run completed: ${run.state}`,
        metadata: { runId: run.id, state: run.state }
      }).catch(() => {});
    }

    return run;
  }

  private async executeTrivial(
    run: HarnessRun,
    featureRequest: string,
    classification: ClassificationResult
  ): Promise<HarnessRun> {
    // Create channel for trivial runs too
    if (this.channelStore && this.workspaceId && !run.channelId) {
      try {
        const channel = await this.channelStore.createChannel({
          name: featureRequest.slice(0, 60),
          description: featureRequest,
          workspaceIds: [this.workspaceId]
        });
        run.channelId = channel.channelId;
        await this.channelStore.linkRun(channel.channelId, run.id, this.workspaceId);
        await this.channelStore.postEntry(channel.channelId, {
          type: "run_started",
          fromAgentId: null,
          fromDisplayName: "Orchestrator",
          content: `Run started (trivial): ${featureRequest}`,
          metadata: { runId: run.id, state: run.state }
        });
      } catch {
        // non-critical
      }
    }

    const trivialPlan = createSeedPlan(featureRequest, this.repoRoot);
    run.plan = trivialPlan;

    const ticketPlan = buildTicketPlanFromPhases(trivialPlan, classification);
    run.ticketPlan = ticketPlan;
    run.ticketLedger = initializeTicketLedger(ticketPlan.tickets);

    // Fast-track: plan generated, then straight to tickets
    await this.transition(run, "PlanGenerated", "phase_00");
    await this.transition(run, "TicketsCreated", "phase_00");

    this.recordEvent(run, "TicketsCreated", "phase_00", {
      ticketCount: String(ticketPlan.tickets.length),
      fastTrack: "trivial"
    });

    const scheduler = new TicketScheduler(
      this.repoRoot,
      this.artifactStore,
      this.verificationRunner,
      this.registry,
      (r, req) => this.dispatch(r, req),
      (r, type, phaseId, details) => this.recordEvent(r, type, phaseId, details)
    );

    const poller = this.startPoller(run, scheduler);
    try {
      await scheduler.executeAll(run);
    } finally {
      poller?.stop();
    }

    run.completedAt = new Date().toISOString();
    run.updatedAt = run.completedAt;
    await this.persistRunIndex(run);

    if (run.channelId && this.channelStore) {
      await this.channelStore.postEntry(run.channelId, {
        type: "run_completed",
        fromAgentId: null,
        fromDisplayName: "Orchestrator",
        content: `Run completed: ${run.state}`,
        metadata: { runId: run.id, state: run.state }
      }).catch(() => {});
    }

    return run;
  }

  private startPoller(
    run: HarnessRun,
    scheduler: TicketScheduler
  ): PollerHandle | null {
    if (!this.pollerFactory) return null;
    try {
      const poller = this.pollerFactory({ run, scheduler });
      poller?.start();
      return poller;
    } catch {
      return null;
    }
  }

  private async dispatch(
    run: HarnessRun,
    input: Omit<WorkRequest, "runId">
  ): Promise<AgentResult> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= input.maxAttempts; attempt += 1) {
      const request: WorkRequest = { runId: run.id, ...input, attempt };
      const agent = this.registry.resolve(request);

      this.recordEvent(run, "AgentDispatched", input.phaseId, {
        agentId: agent.id,
        provider: agent.provider,
        workKind: input.kind,
        attempt: String(attempt)
      });

      if (run.channelId && this.channelStore) {
        this.channelStore.postEntry(run.channelId, {
          type: "message",
          fromAgentId: agent.id,
          fromDisplayName: agent.name,
          content: `Dispatched for ${input.kind}: ${input.title}`,
          metadata: { attempt: String(attempt) }
        }).catch(() => {});
      }

      try {
        const result = await agent.run(request);

        this.recordEvidence(run, {
          phaseId: input.phaseId,
          agentId: agent.id,
          provider: agent.provider,
          workKind: input.kind,
          attempt,
          summary: result.summary,
          evidence: result.evidence,
          proposedCommands: result.proposedCommands,
          blockers: result.blockers
        });

        this.recordEvent(run, "AgentCompleted", input.phaseId, {
          agentId: agent.id,
          summary: result.summary,
          attempt: String(attempt)
        });

        if (result.blockers.length > 0 && attempt < input.maxAttempts) {
          this.recordEvent(run, "AgentRetried", input.phaseId, {
            agentId: agent.id,
            attempt: String(attempt),
            reason: result.blockers.join("; ")
          });
          continue;
        }

        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.recordEvent(run, "AgentFailed", input.phaseId, {
          attempt: String(attempt),
          message: lastError.message
        });

        if (attempt < input.maxAttempts) {
          this.recordEvent(run, "AgentRetried", input.phaseId, {
            attempt: String(attempt),
            reason: lastError.message
          });
          continue;
        }
      }
    }

    throw lastError ?? new Error("Agent execution failed without a reported error.");
  }

  private async transition(
    run: HarnessRun,
    eventType: RunEventType,
    phaseId: string
  ): Promise<void> {
    run.state = assertTransition(run.state, eventType);
    run.updatedAt = new Date().toISOString();
    this.recordEvent(run, eventType, phaseId, { state: run.state });
    await this.persistRunIndex(run);

    if (run.channelId && this.channelStore) {
      this.channelStore.postEntry(run.channelId, {
        type: "status_update",
        fromAgentId: null,
        fromDisplayName: "Orchestrator",
        content: `${eventType} → ${run.state}`,
        metadata: { runId: run.id, state: run.state, event: eventType }
      }).catch(() => {});
    }
  }

  private recordEvent(
    run: HarnessRun,
    type: RunEventType,
    phaseId: string,
    details: Record<string, string>
  ): void {
    const event: RunEvent = {
      type,
      phaseId,
      details,
      createdAt: new Date().toISOString()
    };

    run.events.push(event);
    this.artifactStore.appendEvent(run.id, event).catch(() => {});
  }

  private recordEvidence(run: HarnessRun, record: EvidenceRecord): void {
    run.evidence.push(record);
  }

  private async persistRunIndex(run: HarnessRun): Promise<void> {
    run.runIndexPath = await this.artifactStore.saveRunsIndex({
      entry: {
        runId: run.id,
        featureRequest: run.featureRequest,
        state: run.state,
        startedAt: run.startedAt,
        updatedAt: run.updatedAt,
        completedAt: run.completedAt,
        channelId: run.channelId,
        phaseLedgerPath: run.phaseLedgerPath,
        artifactsRoot: this.artifactsDir
          ? `${this.artifactsDir}/${run.id}`
          : `${this.repoRoot}/.relay/artifacts/${run.id}`
      }
    });
    await this.artifactStore.saveRunSnapshot(run);
  }
}

export function buildRunId(): string {
  return `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
