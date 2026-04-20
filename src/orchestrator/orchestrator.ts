import type { FailureClassification, WorkRequest } from "../domain/agent.js";
import { createSeedPlan } from "../domain/phase-plan.js";
import type {
  ArtifactRecord,
  EvidenceRecord,
  HarnessRun,
  PhaseLedgerEntry,
  RunEvent,
  RunEventType
} from "../domain/run.js";
import { assertTransition } from "../domain/state-machine.js";
import { AgentRegistry } from "../agents/registry.js";
import type { ArtifactStore } from "../execution/artifact-store.js";
import {
  selectVerificationCommands,
  VerificationRunner
} from "../execution/verification-runner.js";
import {
  buildRetryContext,
  buildRetryObjective,
  fallbackFailureClassification,
  isVerificationPlanIssue
} from "./failure-routing.js";

export class Orchestrator {
  constructor(
    private readonly registry: AgentRegistry,
    private readonly repoRoot: string,
    private readonly verificationRunner: VerificationRunner,
    private readonly artifactStore: ArtifactStore,
    private readonly artifactsDir?: string
  ) {}

  async run(featureRequest: string, runId?: string): Promise<HarnessRun> {
    const now = new Date().toISOString();
    const run: HarnessRun = {
      id: runId ?? buildRunId(),
      featureRequest,
      state: "DRAFT_PLAN",
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

    this.recordEvent(run, "TaskSubmitted", "phase_00", {
      featureRequest
    });

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
      context: [`Repository root: ${this.repoRoot}`],
      artifactContext: [],
      attempt: 1,
      maxAttempts: 2,
      priorEvidence: []
    });
    run.plan = planResult.phasePlan ?? createSeedPlan(featureRequest, this.repoRoot);
    this.initializePhaseLedger(run);
    await this.persistPhaseLedger(run);
    await this.transition(run, "PlanGenerated", "phase_00");
    await this.transition(run, "PlanAccepted", "phase_00");

    for (const phase of run.plan.phases) {
      await this.transition(run, "PhaseStarted", phase.id);
      await this.updatePhaseLedger(run, phase.id, {
        lifecycle: "implementing",
        verification: "pending",
        chosenNextAction: "Implement the current phase objective."
      });

      const checksPassed = await this.executePhaseUntilVerified(run, phase, featureRequest);

      if (!checksPassed) {
        run.completedAt = new Date().toISOString();
        run.updatedAt = run.completedAt;
        await this.persistRunIndex(run);
        return run;
      }

      await this.dispatch(run, {
        phaseId: phase.id,
        kind: "review_changes",
        specialty: phase.specialty,
        title: `${phase.title} review`,
        objective: "Review the implementation and test plan.",
        acceptanceCriteria: phase.acceptanceCriteria,
        allowedCommands: phase.allowedCommands,
        verificationCommands: phase.verificationCommands,
        docsToUpdate: phase.docsToUpdate,
        context: phase.acceptanceCriteria,
        artifactContext: await this.collectArtifactContext(run, phase.id, {
          includeSuccessful: true,
          limit: 3
        }),
        attempt: 1,
        maxAttempts: phase.retryPolicy.maxAgentAttempts,
        priorEvidence: this.collectPhaseEvidence(run, phase.id)
      });
      await this.transition(run, "ReviewResolved", phase.id);
      await this.updatePhaseLedger(run, phase.id, {
        lifecycle: "completed",
        chosenNextAction: "Phase complete. Advance to the next phase."
      });
    }
    await this.transition(run, "NoPhasesRemain", run.plan.phases.at(-1)?.id ?? "phase_00");
    run.completedAt = new Date().toISOString();
    run.updatedAt = run.completedAt;
    await this.persistRunIndex(run);

    return run;
  }

  private async dispatch(
    run: HarnessRun,
    input: Omit<WorkRequest, "runId">
  ) {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= input.maxAttempts; attempt += 1) {
      const request: WorkRequest = {
        runId: run.id,
        ...input,
        attempt
      };
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

  private async executePhaseUntilVerified(
    run: HarnessRun,
    phase: NonNullable<HarnessRun["plan"]>["phases"][number],
    featureRequest: string
  ): Promise<boolean> {
    let classification: FailureClassification | null = null;

    for (
      let loop = 1;
      loop <= phase.retryPolicy.maxTestFixLoops;
      loop += 1
    ) {
      await this.dispatch(run, {
        phaseId: phase.id,
        kind: "implement_phase",
        specialty: phase.specialty,
        title: phase.title,
        objective: buildRetryObjective(phase.goal, classification),
        acceptanceCriteria: phase.acceptanceCriteria,
        allowedCommands: phase.allowedCommands,
        verificationCommands: phase.verificationCommands,
        docsToUpdate: phase.docsToUpdate,
        context: [
          `Feature request: ${featureRequest}`,
          `Verification loop: ${loop} of ${phase.retryPolicy.maxTestFixLoops}`,
          ...buildRetryContext(classification)
        ],
        artifactContext: await this.collectArtifactContext(run, phase.id, {
          includeSuccessful: false,
          limit: 2
        }),
        attempt: 1,
        maxAttempts: phase.retryPolicy.maxAgentAttempts,
        priorEvidence: this.collectPhaseEvidence(run, phase.id)
      });
      await this.transition(run, "PatchGenerated", phase.id);
      await this.updatePhaseLedger(run, phase.id, {
        lifecycle: "implementing",
        verification: "running",
        chosenNextAction: classification
          ? classification.nextAction
          : "Run the verification commands for the current phase."
      });

      const testerResult = await this.dispatch(run, {
        phaseId: phase.id,
        kind: "run_checks",
        specialty: phase.specialty,
        title: `${phase.title} checks`,
        objective: isVerificationPlanIssue(classification?.category ?? null)
          ? "Repair and run the bounded verification plan."
          : "Run the bounded verification plan.",
        acceptanceCriteria: phase.acceptanceCriteria,
        allowedCommands: phase.allowedCommands,
        verificationCommands: phase.verificationCommands,
        docsToUpdate: phase.docsToUpdate,
        context: [...phase.acceptanceCriteria, ...buildRetryContext(classification)],
        artifactContext: await this.collectArtifactContext(run, phase.id, {
          includeSuccessful: false,
          limit: 2
        }),
        attempt: 1,
        maxAttempts: phase.retryPolicy.maxAgentAttempts,
        priorEvidence: this.collectPhaseEvidence(run, phase.id)
      });

      const verificationResult = await this.executeVerificationCommands(
        run,
        phase.id,
        testerResult.proposedCommands,
        phase.verificationCommands
      );

      if (verificationResult.success) {
        await this.transition(run, "ChecksPassed", phase.id);
        await this.updatePhaseLedger(run, phase.id, {
          lifecycle: "reviewing",
          verification: "passed",
          chosenNextAction: "Verification passed. Proceed to review."
        });
        return true;
      }

      classification = await this.classifyFailure(
        run,
        phase,
        verificationResult.rejected
      );

      if (loop < phase.retryPolicy.maxTestFixLoops) {
        await this.transition(run, "ChecksFailedRecoverable", phase.id);
        await this.updatePhaseLedger(run, phase.id, {
          lifecycle: "implementing",
          verification: "failed_recoverable",
          chosenNextAction: classification.nextAction
        });
        continue;
      }

      await this.transition(run, "ChecksFailedNonRecoverable", phase.id);
      await this.updatePhaseLedger(run, phase.id, {
        lifecycle: "failed",
        verification: "failed_terminal",
        chosenNextAction: classification.nextAction
      });
      return false;
    }

    return false;
  }

  private async classifyFailure(
    run: HarnessRun,
    phase: NonNullable<HarnessRun["plan"]>["phases"][number],
    rejectedCommands: string[]
  ): Promise<FailureClassification> {
    const artifactContext = await this.collectArtifactContext(run, phase.id, {
      includeSuccessful: false,
      limit: 3
    });
    const classificationResult = await this.dispatch(run, {
      phaseId: phase.id,
      kind: "classify_failure",
      specialty: phase.specialty,
      title: `${phase.title} failure classification`,
      objective:
        "Classify the failing artifacts before retrying. Choose one category: fix_code, fix_test, or bad_command_plan.",
      acceptanceCriteria: [
        "Use artifact contents to choose the most likely failure category.",
        "Explain the rationale and the next best retry action."
      ],
      allowedCommands: phase.allowedCommands,
      verificationCommands: phase.verificationCommands,
      docsToUpdate: [],
      context: rejectedCommands.length > 0
        ? [`Rejected commands: ${rejectedCommands.join(", ")}`]
        : [],
      artifactContext,
      attempt: 1,
      maxAttempts: phase.retryPolicy.maxAgentAttempts,
      priorEvidence: this.collectPhaseEvidence(run, phase.id)
    });

    const classification =
      classificationResult.failureClassification ??
      fallbackFailureClassification({
        artifactContext,
        rejectedCommands
      });

    this.recordEvent(run, "FailureClassified", phase.id, {
      category: classification.category,
      rationale: classification.rationale,
      nextAction: classification.nextAction
    });
    const artifact = await this.artifactStore.saveFailureClassification({
      runId: run.id,
      phaseId: phase.id,
      classification
    });
    this.recordArtifact(run, artifact);
    this.recordEvent(run, "ArtifactCaptured", phase.id, {
      artifactId: artifact.artifactId,
      path: artifact.path
    });
    await this.updatePhaseLedger(run, phase.id, {
      lastClassification: {
        category: classification.category,
        rationale: classification.rationale,
        nextAction: classification.nextAction
      },
      chosenNextAction: classification.nextAction
    });

    return classification;
  }

  private async executeVerificationCommands(
    run: HarnessRun,
    phaseId: string,
    proposedCommands: string[],
    allowlistedCommands: string[]
  ) {
    const selection = selectVerificationCommands(
      proposedCommands,
      allowlistedCommands
    );

    for (const rejected of selection.rejected) {
      this.recordEvent(run, "CommandRejected", phaseId, {
        command: rejected,
        reason: "not_allowlisted"
      });
    }

    let success = true;

    for (const command of selection.commandsToRun) {
      this.recordEvent(run, "CommandStarted", phaseId, {
        command
      });
      const entry = await this.verificationRunner.executeCommand({
        runId: run.id,
        phaseId,
        repoRoot: this.repoRoot,
        command
      });

      this.recordArtifact(run, entry.artifact);
      this.recordEvent(run, "ArtifactCaptured", phaseId, {
        artifactId: entry.artifact.artifactId,
        path: entry.artifact.path
      });
      this.recordEvent(run, "CommandCompleted", phaseId, {
        command,
        exitCode: String(entry.result.exitCode),
        stdoutBytes: String(entry.result.stdout.length),
        stderrBytes: String(entry.result.stderr.length)
      });
      this.recordEvidence(run, {
        phaseId,
        agentId: "harness-verifier",
        provider: "harness",
        workKind: "run_checks",
        attempt: 1,
        summary: `Executed "${command}" with exit code ${entry.result.exitCode}.`,
        evidence: [
          `artifact=${entry.artifact.path}`,
          `stdout_bytes=${entry.result.stdout.length}`,
          `stderr_bytes=${entry.result.stderr.length}`
        ],
        proposedCommands: [command],
        blockers:
          entry.result.exitCode === 0
            ? []
            : [`Verification command failed: ${command}`]
      });

      success = success && entry.result.exitCode === 0;
    }

    return {
      success,
      executedCount: selection.commandsToRun.length,
      rejected: selection.rejected
    };
  }

  private async transition(
    run: HarnessRun,
    eventType: RunEventType,
    phaseId: string
  ): Promise<void> {
    run.state = assertTransition(run.state, eventType);
    run.updatedAt = new Date().toISOString();
    this.recordEvent(run, eventType, phaseId, {
      state: run.state
    });
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

  private recordArtifact(run: HarnessRun, record: ArtifactRecord): void {
    run.artifacts.push(record);
  }

  private initializePhaseLedger(run: HarnessRun): void {
    run.phaseLedger = (run.plan?.phases ?? []).map((phase) => ({
      phaseId: phase.id,
      title: phase.title,
      specialty: phase.specialty,
      lifecycle: "pending",
      verification: "pending",
      lastClassification: null,
      chosenNextAction: "Await phase start.",
      updatedAt: new Date().toISOString()
    }));
  }

  private async updatePhaseLedger(
    run: HarnessRun,
    phaseId: string,
    patch: Partial<PhaseLedgerEntry>
  ): Promise<void> {
    const entry = run.phaseLedger.find((item) => item.phaseId === phaseId);

    if (!entry) {
      return;
    }

    Object.assign(entry, patch, {
      updatedAt: new Date().toISOString()
    });

    await this.persistPhaseLedger(run);
  }

  private async persistPhaseLedger(run: HarnessRun): Promise<void> {
    run.phaseLedgerPath = await this.artifactStore.savePhaseLedger({
      runId: run.id,
      phaseLedger: run.phaseLedger
    });
    run.updatedAt = new Date().toISOString();
    await this.persistRunIndex(run);
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

  private collectPhaseEvidence(run: HarnessRun, phaseId: string): string[] {
    return run.evidence
      .filter((record) => record.phaseId === phaseId)
      .map((record) => `${record.agentId}: ${record.summary}`);
  }

  private async collectArtifactContext(
    run: HarnessRun,
    phaseId: string,
    options: {
      includeSuccessful: boolean;
      limit: number;
    }
  ): Promise<string[]> {
    const artifacts = run.artifacts
      .filter((record) => record.phaseId === phaseId)
      .filter((record) => record.type === "command_result")
      .filter((record) => options.includeSuccessful || record.exitCode !== 0)
      .slice(-options.limit);

    const contexts = await Promise.all(
      artifacts.map(async (artifact) =>
        formatArtifactContext(await this.artifactStore.readCommandResult(artifact.path))
      )
    );

    return contexts;
  }
}

function buildRunId(): string {
  return `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function formatArtifactContext(input: {
  artifactId: string;
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}): string {
  const stdout = excerptOutput(input.stdout);
  const stderr = excerptOutput(input.stderr);

  return [
    `Artifact ${input.artifactId}`,
    `Command: ${input.command}`,
    `Exit code: ${input.exitCode}`,
    "STDOUT:",
    stdout,
    "STDERR:",
    stderr
  ].join("\n");
}

function excerptOutput(output: string): string {
  if (!output.trim()) {
    return "(empty)";
  }

  const maxChars = 1200;
  const lines = output.trim().split("\n");
  const tail = lines.slice(-12).join("\n");

  if (tail.length <= maxChars) {
    return tail;
  }

  return tail.slice(tail.length - maxChars);
}
