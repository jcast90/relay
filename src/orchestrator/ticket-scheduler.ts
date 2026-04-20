import type { AgentResult, FailureClassification, WorkRequest } from "../domain/agent.js";
import { getAgentName } from "../domain/agent-names.js";
import { roleForWork } from "../domain/agent.js";
import type { AgentRegistry } from "../agents/registry.js";
import type { HarnessRun, RunEventType } from "../domain/run.js";
import type {
  TicketDefinition,
  TicketLedgerEntry
} from "../domain/ticket.js";
import {
  getReadyTickets,
  initializeTicketLedger
} from "../domain/ticket.js";
import type { ArtifactStore } from "../execution/artifact-store.js";
import type { VerificationRunner } from "../execution/verification-runner.js";
import { selectVerificationCommands } from "../execution/verification-runner.js";
import {
  buildRetryContext,
  buildRetryObjective,
  fallbackFailureClassification,
  isVerificationPlanIssue
} from "./failure-routing.js";

export interface TicketSchedulerOptions {
  maxConcurrency: number;
}

const DEFAULT_OPTIONS: TicketSchedulerOptions = {
  maxConcurrency: 3
};

// Sentinel marker returned by the wake-up channel — distinct from any real
// ticket completion record so the scheduler loop can detect and ignore it.
const WAKE_SENTINEL = { ticketId: "__wake__", success: false, wake: true } as const;

type RaceResult =
  | { ticketId: string; success: boolean; wake?: false }
  | { ticketId: "__wake__"; success: false; wake: true };

export class TicketScheduler {
  private readonly options: TicketSchedulerOptions;

  /** The run that the active `executeAll` is driving, if any. */
  private activeRun: HarnessRun | null = null;

  /** Resolves the next time an in-flight `executeAll` loop should re-scan. */
  private wakeResolve: (() => void) | null = null;

  /** Tail of queued single-ticket executions after `executeAll` resolved. */
  private enqueueTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly repoRoot: string,
    private readonly artifactStore: ArtifactStore,
    private readonly verificationRunner: VerificationRunner,
    private readonly registry: AgentRegistry,
    private readonly dispatch: (
      run: HarnessRun,
      request: Omit<WorkRequest, "runId">
    ) => Promise<AgentResult>,
    private readonly recordEvent: (
      run: HarnessRun,
      type: RunEventType,
      phaseId: string,
      details: Record<string, string>
    ) => void,
    options?: Partial<TicketSchedulerOptions>
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  async executeAll(run: HarnessRun): Promise<boolean> {
    this.activeRun = run;
    try {
      return await this.drain(run);
    } finally {
      // Defensive double-clear: drain's finally already cleared the marker
      // on the normal path. This catches the throw-without-clearing case.
      if (this.activeRun === run) {
        this.activeRun = null;
        this.wakeResolve = null;
      }
    }
  }

  /**
   * Append a ticket to the run's ledger and make sure it will be executed.
   *
   * Semantics:
   *  - Appends the ticket to `run.ticketPlan.tickets` and a matching entry to
   *    `run.ticketLedger` so persisted snapshots see it.
   *  - If an `executeAll` loop is currently driving this run, wake it so the
   *    new ticket is picked up on the next iteration.
   *  - Otherwise, spawn a fresh drain for just the new ticket. Concurrent
   *    `enqueue` calls in this mode are serialized behind a tail promise so
   *    we never run two drains for the same run at once.
   *
   * The concurrency cap from `TicketSchedulerOptions` is always respected —
   * the drain loop is the single place tickets transition to `executing`.
   */
  async enqueue(run: HarnessRun, ticket: TicketDefinition): Promise<void> {
    this.appendTicketToRun(run, ticket);

    if (this.activeRun === run) {
      // Loop is alive — poke it so the next iteration re-scans the ledger.
      this.wake();
      return;
    }

    // No active loop. Serialize fresh drains so we don't start a second one
    // while an earlier enqueue is still working.
    const next = this.enqueueTail.then(async () => {
      // If somebody started a real executeAll between scheduling and now,
      // the ticket is already in the ledger and that loop will see it.
      if (this.activeRun === run) {
        this.wake();
        return;
      }
      this.activeRun = run;
      try {
        await this.drain(run);
      } finally {
        if (this.activeRun === run) {
          this.activeRun = null;
          this.wakeResolve = null;
        }
      }
    });

    // Keep the chain alive even if one drain throws, so future enqueues still run.
    this.enqueueTail = next.catch(() => {
      /* swallow — failures are recorded on the ledger entry itself */
    });

    await next;
  }

  private async drain(run: HarnessRun): Promise<boolean> {
    const executing = new Map<string, Promise<RaceResult>>();

    try {
      return await this.drainLoop(run, executing);
    } finally {
      // Clear the active-run marker BEFORE drain returns, so a concurrent
      // enqueue() that races with drain-just-returning takes the fresh-drain
      // branch via enqueueTail instead of a no-op wake() on a dead loop.
      if (this.activeRun === run) {
        this.activeRun = null;
        this.wakeResolve = null;
      }
    }
  }

  private async drainLoop(
    run: HarnessRun,
    executing: Map<string, Promise<RaceResult>>
  ): Promise<boolean> {
    while (true) {
      const allCompleted = run.ticketLedger.every(
        (t) => t.status === "completed" || t.status === "failed"
      );

      if (allCompleted) {
        const anyFailed = run.ticketLedger.some((t) => t.status === "failed");
        return !anyFailed;
      }

      this.updateBlockedTickets(run);

      const ready = getReadyTickets(run.ticketLedger).filter(
        (t) => !executing.has(t.ticketId)
      );
      const slotsAvailable = this.options.maxConcurrency - executing.size;

      for (const ticket of ready.slice(0, slotsAvailable)) {
        const ticketDef = this.findTicketDefinition(run, ticket.ticketId);

        if (!ticketDef) {
          continue;
        }

        // Resolve which agent will work on this ticket
        const agentId = this.resolveAgentForTicket(ticketDef);
        const agentDisplayName = await getAgentName(agentId);

        this.updateTicketStatus(run, ticket.ticketId, {
          status: "executing",
          assignedAgentId: agentId,
          assignedAgentName: agentDisplayName,
          startedAt: new Date().toISOString()
        });

        this.recordEvent(run, "TicketStarted", ticket.ticketId, {
          ticketId: ticket.ticketId,
          title: ticket.title,
          assignedAgent: agentDisplayName,
          agentId
        });

        const promise = this.executeTicket(run, ticketDef).then(
          (success): RaceResult => ({ ticketId: ticket.ticketId, success }),
          (): RaceResult => ({ ticketId: ticket.ticketId, success: false })
        );

        executing.set(ticket.ticketId, promise);
      }

      if (executing.size === 0) {
        // No in-flight work and nothing ready to dispatch. Preserve the
        // original contract: signal failure so the caller knows the drain
        // ended without completing every ticket. Fresh `enqueue` calls after
        // this point spawn their own drain via the enqueueTail chain.
        return false;
      }

      const wakePromise = this.makeWakePromise();
      const completed = await Promise.race<RaceResult>([
        ...executing.values(),
        wakePromise
      ]);

      if ("wake" in completed && completed.wake) {
        // Wake signal fired — re-scan the ledger for newly appended work.
        continue;
      }

      executing.delete(completed.ticketId);

      if (completed.success) {
        this.updateTicketStatus(run, completed.ticketId, {
          status: "completed",
          verification: "passed",
          completedAt: new Date().toISOString()
        });
        this.recordEvent(run, "TicketCompleted", completed.ticketId, {
          ticketId: completed.ticketId
        });
      } else {
        this.updateTicketStatus(run, completed.ticketId, {
          status: "failed",
          verification: "failed_terminal",
          completedAt: new Date().toISOString()
        });
        this.recordEvent(run, "TicketFailed", completed.ticketId, {
          ticketId: completed.ticketId
        });
      }

      await this.persistTicketLedger(run);
    }
  }

  /**
   * Build a promise that resolves when `wake()` is called. Each iteration of
   * the drain loop consumes one and replaces it, so a wake signal only fires
   * the next Promise.race — never a stale one.
   */
  private makeWakePromise(): Promise<RaceResult> {
    return new Promise<RaceResult>((resolve) => {
      this.wakeResolve = () => {
        this.wakeResolve = null;
        resolve(WAKE_SENTINEL);
      };
    });
  }

  private wake(): void {
    const resolver = this.wakeResolve;
    this.wakeResolve = null;
    resolver?.();
  }

  private appendTicketToRun(run: HarnessRun, ticket: TicketDefinition): void {
    // Don't double-append. Idempotency keeps retries from accidentally cloning
    // a ticket onto the ledger twice.
    if (run.ticketLedger.some((t) => t.ticketId === ticket.id)) {
      return;
    }

    const [entry] = initializeTicketLedger([ticket]);
    run.ticketLedger.push(entry);

    if (run.ticketPlan) {
      run.ticketPlan.tickets.push(ticket);
    }
  }

  private async executeTicket(
    run: HarnessRun,
    ticket: TicketDefinition
  ): Promise<boolean> {
    let classification: FailureClassification | null = null;

    for (let loop = 1; loop <= ticket.retryPolicy.maxTestFixLoops; loop += 1) {
      await this.dispatch(run, {
        phaseId: ticket.id,
        kind: "implement_phase",
        specialty: ticket.specialty,
        title: ticket.title,
        objective: buildRetryObjective(ticket.objective, classification),
        acceptanceCriteria: ticket.acceptanceCriteria,
        allowedCommands: ticket.allowedCommands,
        verificationCommands: ticket.verificationCommands,
        docsToUpdate: ticket.docsToUpdate,
        context: [
          `Feature request: ${run.featureRequest}`,
          `Ticket: ${ticket.id} - ${ticket.title}`,
          `Verification loop: ${loop} of ${ticket.retryPolicy.maxTestFixLoops}`,
          ...buildRetryContext(classification)
        ],
        artifactContext: [],
        attempt: 1,
        maxAttempts: ticket.retryPolicy.maxAgentAttempts,
        priorEvidence: []
      });

      this.updateTicketStatus(run, ticket.id, {
        status: "verifying",
        verification: "running"
      });

      const testerResult = await this.dispatch(run, {
        phaseId: ticket.id,
        kind: "run_checks",
        specialty: ticket.specialty,
        title: `${ticket.title} checks`,
        objective: isVerificationPlanIssue(classification?.category ?? null)
          ? "Repair and run the bounded verification plan."
          : "Run the bounded verification plan.",
        acceptanceCriteria: ticket.acceptanceCriteria,
        allowedCommands: ticket.allowedCommands,
        verificationCommands: ticket.verificationCommands,
        docsToUpdate: ticket.docsToUpdate,
        context: [...ticket.acceptanceCriteria, ...buildRetryContext(classification)],
        artifactContext: [],
        attempt: 1,
        maxAttempts: ticket.retryPolicy.maxAgentAttempts,
        priorEvidence: []
      });

      const verificationResult = await this.executeVerificationCommands(
        run,
        ticket.id,
        testerResult.proposedCommands,
        ticket.verificationCommands
      );

      if (verificationResult.success) {
        return true;
      }

      classification = await this.classifyFailure(run, ticket, verificationResult.rejected);

      if (loop < ticket.retryPolicy.maxTestFixLoops) {
        this.updateTicketStatus(run, ticket.id, {
          status: "retry",
          verification: "failed_recoverable",
          lastClassification: {
            category: classification.category,
            rationale: classification.rationale,
            nextAction: classification.nextAction
          },
          attempt: loop + 1
        });
        this.recordEvent(run, "TicketRetried", ticket.id, {
          ticketId: ticket.id,
          loop: String(loop),
          category: classification.category
        });
        continue;
      }
    }

    return false;
  }

  private async classifyFailure(
    run: HarnessRun,
    ticket: TicketDefinition,
    rejectedCommands: string[]
  ): Promise<FailureClassification> {
    const result = await this.dispatch(run, {
      phaseId: ticket.id,
      kind: "classify_failure",
      specialty: ticket.specialty,
      title: `${ticket.title} failure classification`,
      objective:
        "Classify the failing artifacts. Choose: fix_code, fix_test, or bad_command_plan.",
      acceptanceCriteria: [
        "Use artifact contents to choose the most likely failure category.",
        "Explain the rationale and the next best retry action."
      ],
      allowedCommands: ticket.allowedCommands,
      verificationCommands: ticket.verificationCommands,
      docsToUpdate: [],
      context: rejectedCommands.length > 0
        ? [`Rejected commands: ${rejectedCommands.join(", ")}`]
        : [],
      artifactContext: [],
      attempt: 1,
      maxAttempts: ticket.retryPolicy.maxAgentAttempts,
      priorEvidence: []
    });

    return (
      result.failureClassification ??
      fallbackFailureClassification({
        artifactContext: [],
        rejectedCommands
      })
    );
  }

  private async executeVerificationCommands(
    run: HarnessRun,
    ticketId: string,
    proposedCommands: string[],
    allowlistedCommands: string[]
  ): Promise<{ success: boolean; rejected: string[] }> {
    const selection = selectVerificationCommands(
      proposedCommands,
      allowlistedCommands
    );

    let success = true;

    for (const command of selection.commandsToRun) {
      const entry = await this.verificationRunner.executeCommand({
        runId: run.id,
        phaseId: ticketId,
        repoRoot: this.repoRoot,
        command
      });

      success = success && entry.result.exitCode === 0;
    }

    return { success, rejected: selection.rejected };
  }

  private updateBlockedTickets(run: HarnessRun): void {
    const completedIds = new Set(
      run.ticketLedger
        .filter((t) => t.status === "completed")
        .map((t) => t.ticketId)
    );

    for (const entry of run.ticketLedger) {
      if (entry.status !== "blocked") {
        continue;
      }

      const depsResolved = entry.dependsOn.every((dep) => completedIds.has(dep));

      if (depsResolved) {
        entry.status = "ready";
        entry.updatedAt = new Date().toISOString();
      }
    }
  }

  private updateTicketStatus(
    run: HarnessRun,
    ticketId: string,
    patch: Partial<TicketLedgerEntry>
  ): void {
    const entry = run.ticketLedger.find((t) => t.ticketId === ticketId);

    if (!entry) {
      return;
    }

    Object.assign(entry, patch, { updatedAt: new Date().toISOString() });
  }

  private resolveAgentForTicket(ticket: TicketDefinition): string {
    try {
      const agent = this.registry.resolve({
        runId: "",
        phaseId: ticket.id,
        kind: "implement_phase",
        specialty: ticket.specialty,
        title: ticket.title,
        objective: ticket.objective,
        acceptanceCriteria: ticket.acceptanceCriteria,
        allowedCommands: ticket.allowedCommands,
        verificationCommands: ticket.verificationCommands,
        docsToUpdate: ticket.docsToUpdate,
        context: [],
        artifactContext: [],
        attempt: 1,
        maxAttempts: 1,
        priorEvidence: []
      });
      return agent.id;
    } catch {
      return "unknown";
    }
  }

  private findTicketDefinition(
    run: HarnessRun,
    ticketId: string
  ): TicketDefinition | null {
    return run.ticketPlan?.tickets.find((t) => t.id === ticketId) ?? null;
  }

  private async persistTicketLedger(run: HarnessRun): Promise<void> {
    run.ticketLedgerPath = await this.artifactStore.saveTicketLedger({
      runId: run.id,
      ticketLedger: run.ticketLedger
    });
  }
}
