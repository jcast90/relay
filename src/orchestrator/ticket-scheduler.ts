import type { AgentResult, FailureClassification, WorkRequest } from "../domain/agent.js";
import type { HarnessRun, RunEventType } from "../domain/run.js";
import type { TicketDefinition, TicketLedgerEntry } from "../domain/ticket.js";
import { getReadyTickets } from "../domain/ticket.js";
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

export class TicketScheduler {
  private readonly options: TicketSchedulerOptions;

  constructor(
    private readonly repoRoot: string,
    private readonly artifactStore: ArtifactStore,
    private readonly verificationRunner: VerificationRunner,
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
    const executing = new Map<string, Promise<{ ticketId: string; success: boolean }>>();

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

        this.updateTicketStatus(run, ticket.ticketId, {
          status: "executing",
          startedAt: new Date().toISOString()
        });

        this.recordEvent(run, "TicketStarted", ticket.ticketId, {
          ticketId: ticket.ticketId,
          title: ticket.title
        });

        const promise = this.executeTicket(run, ticketDef).then(
          (success) => ({ ticketId: ticket.ticketId, success }),
          () => ({ ticketId: ticket.ticketId, success: false })
        );

        executing.set(ticket.ticketId, promise);
      }

      if (executing.size === 0) {
        return false;
      }

      const completed = await Promise.race(executing.values());
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
