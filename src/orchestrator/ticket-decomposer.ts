import type { AgentResult, WorkRequest } from "../domain/agent.js";
import type { ClassificationResult } from "../domain/classification.js";
import type { PhasePlan } from "../domain/phase-plan.js";
import type { HarnessRun } from "../domain/run.js";
import {
  linearizeTickets,
  parseTicketPlan,
  validateTicketDag,
  type TicketPlan
} from "../domain/ticket.js";

export async function decomposePlanToTickets(input: {
  run: HarnessRun;
  plan: PhasePlan;
  classification: ClassificationResult;
  repoRoot: string;
  dispatch: (run: HarnessRun, request: Omit<WorkRequest, "runId">) => Promise<AgentResult>;
}): Promise<TicketPlan> {
  const result = await input.dispatch(input.run, {
    phaseId: "phase_00",
    kind: "decompose_tickets",
    specialty: "general",
    title: "Decompose plan into parallelizable tickets",
    objective: `Decompose the following plan into parallelizable tickets with dependency edges. Plan: ${input.plan.task.title}`,
    acceptanceCriteria: [
      "Each ticket must have clear acceptance criteria and verification commands.",
      "Tickets that can run in parallel should NOT depend on each other.",
      "Tickets that need sequential execution must declare dependsOn edges.",
      "The dependency graph must be a DAG (no cycles)."
    ],
    allowedCommands: [],
    verificationCommands: [],
    docsToUpdate: input.plan.docsToUpdate,
    context: [
      `Repository root: ${input.repoRoot}`,
      `Classification tier: ${input.classification.tier}`,
      `Estimated ticket count: ${input.classification.estimatedTicketCount}`,
      `Plan phases: ${input.plan.phases.map((p) => `${p.id}: ${p.title}`).join(", ")}`,
      ...input.plan.phases.map((p) =>
        `Phase ${p.id} (${p.specialty}): ${p.goal} [commands: ${p.verificationCommands.join(", ")}]`
      )
    ],
    artifactContext: [],
    attempt: 1,
    maxAttempts: 2,
    priorEvidence: []
  });

  if (result.ticketPlan) {
    return validateAndFixTicketPlan(result.ticketPlan);
  }

  return buildTicketPlanFromPhases(input.plan, input.classification);
}

function validateAndFixTicketPlan(plan: TicketPlan): TicketPlan {
  const dagResult = validateTicketDag(plan.tickets);

  if (dagResult.valid) {
    return plan;
  }

  return {
    ...plan,
    tickets: linearizeTickets(plan.tickets)
  };
}

export function buildTicketPlanFromPhases(
  plan: PhasePlan,
  classification: ClassificationResult
): TicketPlan {
  const tickets = plan.phases.map((phase, index) => ({
    id: `ticket_${String(index + 1).padStart(2, "0")}`,
    title: phase.title,
    objective: phase.goal,
    specialty: phase.specialty,
    acceptanceCriteria: phase.acceptanceCriteria,
    allowedCommands: phase.allowedCommands,
    verificationCommands: phase.verificationCommands,
    docsToUpdate: phase.docsToUpdate,
    dependsOn: index > 0 ? [`ticket_${String(index).padStart(2, "0")}`] : [],
    retryPolicy: phase.retryPolicy
  }));

  return parseTicketPlan({
    version: 1,
    task: plan.task,
    classification,
    tickets,
    finalVerification: plan.finalVerification,
    docsToUpdate: plan.docsToUpdate
  });
}
