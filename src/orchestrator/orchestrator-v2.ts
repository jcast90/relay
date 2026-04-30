import type { AgentResult, FailureClassification, WorkRequest } from "../domain/agent.js";
import {
  tierNeedsApproval,
  tierNeedsDesignDoc,
  tierSkipsPlanning,
  type ClassificationResult,
} from "../domain/classification.js";
import { createSeedPlan } from "../domain/phase-plan.js";
import type {
  ArtifactRecord,
  EvidenceRecord,
  HarnessRun,
  RunEvent,
  RunEventType,
} from "../domain/run.js";
import { initializeTicketLedger } from "../domain/ticket.js";
import { assertTransition } from "../domain/state-machine.js";
import type { AgentRegistry } from "../agents/registry.js";
import type { ArtifactStore } from "../execution/artifact-store.js";
import type { AgentExecutor } from "../execution/executor.js";
import type { VerificationRunner } from "../execution/verification-runner.js";
import type { ChannelStore } from "../channels/channel-store.js";
import { classifierTierToChannelTier } from "../domain/tier-mapper.js";
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

export interface OrchestratorV2Options {
  /**
   * Optional {@link AgentExecutor}. When set, the per-run
   * {@link TicketScheduler} is wired with `options.executor` instead of the
   * legacy dispatch callback — see the scheduler ctor for the mutually-
   * exclusive contract. When omitted, the scheduler keeps the historical
   * dispatch-based path so existing tests and callers compile unchanged.
   *
   * Production callers that want real child-process execution should
   * construct a `LocalChildProcessExecutor` (T-202) with a
   * `GitWorktreeSandboxProvider` (T-201) and pass it here. We deliberately
   * do NOT default-construct one inside the orchestrator — the orchestrator
   * is used both by the CLI (which wants real execution) and by tests (which
   * want a scripted dispatch). Building a default provider with real git
   * calls would break the test path.
   */
  executor?: AgentExecutor;
}

export class OrchestratorV2 {
  /** Optional poller factory registered via `attachPoller`. */
  private pollerFactory: PollerFactory | null = null;

  private readonly executor: AgentExecutor | null;

  /**
   * In-flight best-effort channel writes (postEntry / appendEvent) tracked so
   * `run()` can await them before returning. Previously these were
   * fire-and-forget via `.postEntry(...).catch(...)`, which caused teardown
   * races in tests: `afterEach`/`finally` would `rm` the tmp dir while the
   * orchestrator's atomic tmp-rename was still in flight, producing
   * ENOENT/ENOTEMPTY errors on Linux CI. Tracking them here preserves the
   * "non-blocking, log-and-continue" semantic during the run while still
   * guaranteeing the writes settle before the caller moves on.
   */
  private pendingWrites: Promise<unknown>[] = [];

  constructor(
    private readonly registry: AgentRegistry,
    private readonly repoRoot: string,
    private readonly verificationRunner: VerificationRunner,
    private readonly artifactStore: ArtifactStore,
    private readonly artifactsDir?: string,
    private readonly channelStore?: ChannelStore,
    private readonly workspaceId?: string,
    options?: OrchestratorV2Options
  ) {
    this.executor = options?.executor ?? null;
  }

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
      runIndexPath: null,
    };

    this.recordEvent(run, "TaskSubmitted", "phase_00", { featureRequest });

    // Create a channel for this run so the dashboard can display it
    if (this.channelStore && this.workspaceId) {
      try {
        const channel = await this.channelStore.createChannel({
          name: featureRequest.slice(0, 60),
          description: featureRequest,
          workspaceIds: [this.workspaceId],
        });
        run.channelId = channel.channelId;
        await this.channelStore.linkRun(channel.channelId, run.id, this.workspaceId);
        await this.channelStore.postEntry(channel.channelId, {
          type: "run_started",
          fromAgentId: null,
          fromDisplayName: "Orchestrator",
          content: `Run started: ${featureRequest}`,
          metadata: { runId: run.id, state: run.state },
        });
      } catch (err) {
        // Channel creation is non-critical — continue without it, but don't
        // swallow silently. A logged warning lets operators see why a run
        // has no channel without having to trace through the code.
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[orchestrator] channel creation failed (runId=${run.id}): ${message}`);
      }
    }

    // Step 1: Classify
    const classification = await classifyRequest({
      run,
      featureRequest,
      repoRoot: this.repoRoot,
      dispatch: (r, req) => this.dispatch(r, req),
    });

    run.classification = classification;
    await this.artifactStore.saveClassification({
      runId: run.id,
      classification,
    });

    // Propagate the LLM tier back onto the channel so the header pill
    // refines beyond the heuristic seed. Best-effort: a failed update is
    // recorded but doesn't fail the run.
    if (run.channelId && this.channelStore) {
      try {
        await this.channelStore.updateChannel(run.channelId, {
          tier: classifierTierToChannelTier(classification.tier),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `[orchestrator] channel tier update failed (runId=${run.id} channelId=${run.channelId}): ${message}`
        );
      }
    }

    await this.transition(run, "ClassificationComplete", "phase_00");
    this.recordEvent(run, "ClassificationComplete", "phase_00", {
      tier: classification.tier,
      rationale: classification.rationale,
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
        "Include retry policy and verification commands.",
      ],
      allowedCommands: [],
      verificationCommands: [],
      docsToUpdate: ["README.md"],
      context: [
        `Repository root: ${this.repoRoot}`,
        `Classification: ${classification.tier} (${classification.rationale})`,
      ],
      artifactContext: [],
      attempt: 1,
      maxAttempts: 2,
      priorEvidence: [],
    });

    run.plan = planResult.phasePlan ?? createSeedPlan(featureRequest, this.repoRoot);
    await this.transition(run, "PlanGenerated", "phase_00");

    // Step 4: Design doc (architectural / feature_large / feature_small)
    if (tierNeedsDesignDoc(classification.tier)) {
      const designResult = await this.dispatch(run, {
        phaseId: "phase_00",
        kind: "generate_design_doc",
        specialty: "general",
        title: "Generate design document",
        objective: `Create a design document for: ${featureRequest}`,
        acceptanceCriteria: [
          "Document should cover architecture, trade-offs, and implementation approach.",
          "Include component boundaries and data flow.",
        ],
        allowedCommands: [],
        verificationCommands: [],
        docsToUpdate: [],
        context: [
          `Repository root: ${this.repoRoot}`,
          `Plan: ${run.plan.task.title}`,
          ...run.plan.phases.map((p) => `Phase: ${p.title} (${p.specialty})`),
        ],
        artifactContext: [],
        attempt: 1,
        maxAttempts: 2,
        priorEvidence: [],
      });

      await this.artifactStore.saveDesignDoc({
        runId: run.id,
        content: designResult.summary,
      });
    }

    // Step 5: Decompose to tickets (before approval gate so plan is visible)
    const ticketPlan = await decomposePlanToTickets({
      run,
      plan: run.plan,
      classification,
      repoRoot: this.repoRoot,
      dispatch: (r, req) => this.dispatch(r, req),
    });

    run.ticketPlan = ticketPlan;
    run.ticketLedger = initializeTicketLedger(ticketPlan.tickets, run.id);

    await this.artifactStore.saveTicketLedger({
      runId: run.id,
      ticketLedger: run.ticketLedger,
    });

    // Channel board is the live, unified ticket view across chat + orchestrator.
    // Per-run ticket-ledger.json remains as an immutable decomposition snapshot.
    // Log-and-continue on failure: a filesystem blip on the channel board must
    // not abort the run after planning and ledger persistence have succeeded.
    await this.mirrorToChannelBoard(run);

    // Step 6: Approval gate or direct ticket execution
    if (tierNeedsApproval(classification.tier)) {
      await this.transition(run, "PlanAwaitingApproval", "phase_00");

      // Non-blocking: check if approval already exists, otherwise return waiting
      const approvalResult = await checkApproval({
        runId: run.id,
        artifactStore: this.artifactStore,
      });

      if (!approvalResult) {
        // No approval yet — persist and return. Caller resumes after approval.
        await this.persistRunIndex(run);
        await this.waitForPendingWrites();
        return run;
      }

      if (approvalResult.decision === "rejected") {
        await this.transition(run, "PlanRejected", "phase_00");
        run.completedAt = new Date().toISOString();
        run.updatedAt = run.completedAt;
        await this.persistRunIndex(run);
        await this.waitForPendingWrites();
        return run;
      }

      await this.transition(run, "PlanApproved", "phase_00");
    } else {
      // Non-approval: transition directly to ticket execution
      await this.transition(run, "TicketsCreated", "phase_00");
    }

    this.recordEvent(run, "TicketsCreated", "phase_00", {
      ticketCount: String(ticketPlan.tickets.length),
    });

    const scheduler = this.buildScheduler(run);

    const poller = this.startPoller(run, scheduler);

    let allTicketsSucceeded = false;
    try {
      allTicketsSucceeded = await scheduler.executeAll(run);
    } finally {
      poller?.stop();
    }

    if (allTicketsSucceeded) {
      this.recordEvent(run, "AllTicketsComplete", "phase_00", {
        ticketCount: String(run.ticketLedger.length),
      });
    }

    run.completedAt = new Date().toISOString();
    run.updatedAt = run.completedAt;
    await this.persistRunIndex(run);

    if (run.channelId && this.channelStore) {
      await this.trackChannelPost(
        run,
        this.channelStore.postEntry(run.channelId, {
          type: "run_completed",
          fromAgentId: null,
          fromDisplayName: "Orchestrator",
          content: `Run completed: ${run.state}`,
          metadata: { runId: run.id, state: run.state },
        })
      );
    }

    await this.waitForPendingWrites();
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
          workspaceIds: [this.workspaceId],
        });
        run.channelId = channel.channelId;
        await this.channelStore.linkRun(channel.channelId, run.id, this.workspaceId);
        await this.channelStore.postEntry(channel.channelId, {
          type: "run_started",
          fromAgentId: null,
          fromDisplayName: "Orchestrator",
          content: `Run started (trivial): ${featureRequest}`,
          metadata: { runId: run.id, state: run.state },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[orchestrator] trivial channel setup failed (runId=${run.id}): ${message}`);
      }
    }

    const trivialPlan = createSeedPlan(featureRequest, this.repoRoot);
    run.plan = trivialPlan;

    const ticketPlan = buildTicketPlanFromPhases(trivialPlan, classification);
    run.ticketPlan = ticketPlan;
    run.ticketLedger = initializeTicketLedger(ticketPlan.tickets, run.id);

    // Same log-and-continue policy as the regular decomposition path.
    await this.mirrorToChannelBoard(run);

    // Fast-track: plan generated, then straight to tickets
    await this.transition(run, "PlanGenerated", "phase_00");
    await this.transition(run, "TicketsCreated", "phase_00");

    this.recordEvent(run, "TicketsCreated", "phase_00", {
      ticketCount: String(ticketPlan.tickets.length),
      fastTrack: "trivial",
    });

    const scheduler = this.buildScheduler(run);

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
      await this.trackChannelPost(
        run,
        this.channelStore.postEntry(run.channelId, {
          type: "run_completed",
          fromAgentId: null,
          fromDisplayName: "Orchestrator",
          content: `Run completed: ${run.state}`,
          metadata: { runId: run.id, state: run.state },
        })
      );
    }

    await this.waitForPendingWrites();
    return run;
  }

  /**
   * Build a per-run scheduler. Centralized so both the trivial and regular
   * paths go through one place — previously the two call sites drifted on
   * option wiring (e.g. new options added to one but not the other).
   *
   * Executor wiring: when `options.executor` was supplied to the
   * orchestrator ctor, the scheduler is constructed with
   * `{ executor }` and the positional dispatch slot is `null`. Otherwise
   * the legacy dispatch callback is used. See the scheduler ctor for the
   * xor contract between the two.
   */
  private buildScheduler(_run: HarnessRun): TicketScheduler {
    return new TicketScheduler(
      this.repoRoot,
      this.artifactStore,
      this.verificationRunner,
      this.registry,
      this.executor ? null : (r, req) => this.dispatch(r, req),
      (r, type, phaseId, details) => this.recordEvent(r, type, phaseId, details),
      {
        channelStore: this.channelStore,
        ...(this.executor ? { executor: this.executor } : {}),
      }
    );
  }

  private startPoller(run: HarnessRun, scheduler: TicketScheduler): PollerHandle | null {
    if (!this.pollerFactory) return null;
    try {
      const poller = this.pollerFactory({ run, scheduler });
      poller?.start();
      return poller;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[orchestrator] poller start failed (runId=${run.id}): ${message}`);
      return null;
    }
  }

  private async dispatch(run: HarnessRun, input: Omit<WorkRequest, "runId">): Promise<AgentResult> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= input.maxAttempts; attempt += 1) {
      const request: WorkRequest = { runId: run.id, ...input, attempt };
      const agent = this.registry.resolve(request);

      this.recordEvent(run, "AgentDispatched", input.phaseId, {
        agentId: agent.id,
        provider: agent.provider,
        workKind: input.kind,
        attempt: String(attempt),
      });

      if (run.channelId && this.channelStore) {
        this.trackChannelPost(
          run,
          this.channelStore.postEntry(run.channelId, {
            type: "message",
            fromAgentId: agent.id,
            fromDisplayName: agent.name,
            content: `Dispatched for ${input.kind}: ${input.title}`,
            metadata: { attempt: String(attempt) },
          })
        );
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
          blockers: result.blockers,
        });

        this.recordEvent(run, "AgentCompleted", input.phaseId, {
          agentId: agent.id,
          summary: result.summary,
          attempt: String(attempt),
        });

        if (result.blockers.length > 0 && attempt < input.maxAttempts) {
          this.recordEvent(run, "AgentRetried", input.phaseId, {
            agentId: agent.id,
            attempt: String(attempt),
            reason: result.blockers.join("; "),
          });
          continue;
        }

        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.recordEvent(run, "AgentFailed", input.phaseId, {
          attempt: String(attempt),
          message: lastError.message,
        });

        if (attempt < input.maxAttempts) {
          this.recordEvent(run, "AgentRetried", input.phaseId, {
            attempt: String(attempt),
            reason: lastError.message,
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
      this.trackChannelPost(
        run,
        this.channelStore.postEntry(run.channelId, {
          type: "status_update",
          fromAgentId: null,
          fromDisplayName: "Orchestrator",
          content: `${eventType} → ${run.state}`,
          metadata: { runId: run.id, state: run.state, event: eventType },
        })
      );
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
      createdAt: new Date().toISOString(),
    };

    run.events.push(event);
    // Track the append so teardown doesn't race it — same rationale as
    // channel writes (see trackChannelPost / waitForPendingWrites).
    this.pendingWrites.push(
      this.artifactStore.appendEvent(run.id, event).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `[orchestrator] appendEvent failed (runId=${run.id} type=${type}): ${message}`
        );
      })
    );
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
          : `${this.repoRoot}/.relay/artifacts/${run.id}`,
      },
    });
    await this.artifactStore.saveRunSnapshot(run);
  }

  /**
   * Mirror the run's current ticket ledger onto the channel's unified board.
   * Best-effort but logged: a mirror failure must not abort the run (the
   * per-run ledger is already persisted), but it also must not be silent.
   */
  private async mirrorToChannelBoard(run: HarnessRun): Promise<void> {
    if (!run.channelId || !this.channelStore) return;
    try {
      await this.channelStore.upsertChannelTickets(run.channelId, run.ticketLedger);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[orchestrator] channel board mirror failed (runId=${run.id} channelId=${run.channelId}): ${message}`
      );
    }
  }

  private warnChannelPostFailed(run: HarnessRun, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[orchestrator] channel post failed (runId=${run.id} channelId=${run.channelId}): ${message}`
    );
  }

  /**
   * Register a best-effort async write (typically a `postEntry`) so
   * {@link waitForPendingWrites} can drain it at run completion. The returned
   * promise never rejects — failures are logged via `warnChannelPostFailed`
   * but never halt the run. This preserves the historical log-and-continue
   * semantic while preventing teardown races in tests and real callers who
   * tear down the artifacts dir immediately after `run()` returns.
   */
  private trackChannelPost(run: HarnessRun, promise: Promise<unknown>): Promise<void> {
    const tracked: Promise<void> = promise.then(
      () => undefined,
      (err: unknown) => this.warnChannelPostFailed(run, err)
    );
    this.pendingWrites.push(tracked);
    return tracked;
  }

  /**
   * Drain all tracked best-effort writes. Uses `allSettled` so a single
   * failure never short-circuits the drain. Clears the tracker on exit so
   * a second invocation doesn't re-await already-settled promises.
   */
  private async waitForPendingWrites(): Promise<void> {
    if (this.pendingWrites.length === 0) return;
    const pending = this.pendingWrites;
    this.pendingWrites = [];
    await Promise.allSettled(pending);
  }
}

export function buildRunId(): string {
  return `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
