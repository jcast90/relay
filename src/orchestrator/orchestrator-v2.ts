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
import { classifyRequest } from "./classifier.js";
import { decomposePlanToTickets, buildTicketPlanFromPhases } from "./ticket-decomposer.js";
import { awaitApproval } from "./approval-gate.js";
import { TicketScheduler } from "./ticket-scheduler.js";

export class OrchestratorV2 {
  constructor(
    private readonly registry: AgentRegistry,
    private readonly repoRoot: string,
    private readonly verificationRunner: VerificationRunner,
    private readonly artifactStore: ArtifactStore,
    private readonly artifactsDir?: string
  ) {}

  async run(featureRequest: string): Promise<HarnessRun> {
    const now = new Date().toISOString();
    const run: HarnessRun = {
      id: buildRunId(),
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

    // Step 5: Approval gate (feature_large, architectural, multi_repo)
    if (tierNeedsApproval(classification.tier)) {
      await this.transition(run, "PlanAwaitingApproval", "phase_00");

      const approvalResult = await awaitApproval({
        run,
        artifactStore: this.artifactStore
      });

      if (approvalResult.decision === "rejected") {
        await this.transition(run, "PlanRejected", "phase_00");
        run.completedAt = new Date().toISOString();
        run.updatedAt = run.completedAt;
        await this.persistRunIndex(run);
        return run;
      }

      await this.transition(run, "PlanApproved", "phase_00");
    } else {
      // For feature_small and bugfix, skip approval and go straight to tickets
      await this.transition(run, "PlanAccepted", "phase_00");
    }

    // Step 6: Decompose to tickets
    const ticketPlan = await decomposePlanToTickets({
      run,
      plan: run.plan,
      classification,
      repoRoot: this.repoRoot,
      dispatch: (r, req) => this.dispatch(r, req)
    });

    run.ticketPlan = ticketPlan;
    run.ticketLedger = initializeTicketLedger(ticketPlan.tickets);

    this.recordEvent(run, "TicketsCreated", "phase_00", {
      ticketCount: String(ticketPlan.tickets.length)
    });

    await this.artifactStore.saveTicketLedger({
      runId: run.id,
      ticketLedger: run.ticketLedger
    });

    // Step 7: Execute tickets
    if (run.state !== "TICKETS_EXECUTING") {
      // For non-approval paths, we need to transition to TICKETS_EXECUTING
      // from PHASE_READY (since PlanAccepted -> PHASE_READY)
      // Use PhaseStarted -> PHASE_EXECUTE, then route to tickets
      // Actually, for the ticket path after PlanAccepted, we go PHASE_READY.
      // Let's handle this by checking state and transitioning appropriately.
    }

    const scheduler = new TicketScheduler(
      this.repoRoot,
      this.artifactStore,
      this.verificationRunner,
      (r, req) => this.dispatch(r, req),
      (r, type, phaseId, details) => this.recordEvent(r, type, phaseId, details)
    );

    const allTicketsSucceeded = await scheduler.executeAll(run);

    if (allTicketsSucceeded) {
      this.recordEvent(run, "AllTicketsComplete", "phase_00", {
        ticketCount: String(run.ticketLedger.length)
      });
    }

    run.completedAt = new Date().toISOString();
    run.updatedAt = run.completedAt;
    await this.persistRunIndex(run);

    return run;
  }

  private async executeTrivial(
    run: HarnessRun,
    featureRequest: string,
    classification: ClassificationResult
  ): Promise<HarnessRun> {
    const trivialPlan = createSeedPlan(featureRequest, this.repoRoot);
    run.plan = trivialPlan;

    const ticketPlan = buildTicketPlanFromPhases(trivialPlan, classification);
    run.ticketPlan = ticketPlan;
    run.ticketLedger = initializeTicketLedger(ticketPlan.tickets);

    // Fast-track: plan generated, accepted, execute
    await this.transition(run, "PlanGenerated", "phase_00");
    await this.transition(run, "PlanAccepted", "phase_00");

    this.recordEvent(run, "TicketsCreated", "phase_00", {
      ticketCount: String(ticketPlan.tickets.length),
      fastTrack: "trivial"
    });

    const scheduler = new TicketScheduler(
      this.repoRoot,
      this.artifactStore,
      this.verificationRunner,
      (r, req) => this.dispatch(r, req),
      (r, type, phaseId, details) => this.recordEvent(r, type, phaseId, details)
    );

    await scheduler.executeAll(run);

    run.completedAt = new Date().toISOString();
    run.updatedAt = run.completedAt;
    await this.persistRunIndex(run);

    return run;
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
          : `${this.repoRoot}/.agent-harness/artifacts/${run.id}`
      }
    });
    await this.artifactStore.saveRunSnapshot(run);
  }
}

function buildRunId(): string {
  return `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
