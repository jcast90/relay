import type { FailureCategory, FailureClassification } from "../domain/agent.js";

export function buildRetryObjective(
  phaseGoal: string,
  classification: FailureClassification | null
): string {
  if (!classification) {
    return phaseGoal;
  }

  switch (classification.category) {
    case "fix_code":
      return `${phaseGoal} Prioritize repairing product or business logic failures before anything else.`;
    case "fix_test":
      return `${phaseGoal} Prioritize repairing tests, fixtures, mocks, or verification setup before changing product logic.`;
    case "bad_command_plan":
      return `${phaseGoal} Do not change product code first. Repair the verification command plan or execution setup.`;
    case "routing_error":
      // Router-sourced classifications are terminal: the ticket is blocked
      // pending operator fix-up of `assignedAlias` / `repoAssignments`. If a
      // routing_error ever reaches the retry path something is wrong, but
      // falling back to the bare objective is safer than crashing the loop.
      return phaseGoal;
  }
}

export function fallbackFailureClassification(input: {
  artifactContext: string[];
  rejectedCommands: string[];
}): FailureClassification {
  const combined =
    `${input.artifactContext.join("\n")}\n${input.rejectedCommands.join("\n")}`.toLowerCase();

  if (
    input.rejectedCommands.length > 0 ||
    combined.includes("not_allowlisted") ||
    combined.includes("command not found") ||
    combined.includes("requires at least node.js")
  ) {
    return {
      category: "bad_command_plan",
      rationale: "The failure points to a command-plan or execution-environment issue.",
      nextAction: "Adjust the verification command plan before changing product code.",
    };
  }

  if (
    combined.includes("expected") ||
    combined.includes("assert") ||
    combined.includes("test failed")
  ) {
    return {
      category: "fix_test",
      rationale: "The failing artifact looks isolated to tests or verification setup.",
      nextAction: "Repair tests, fixtures, mocks, or verification setup.",
    };
  }

  return {
    category: "fix_code",
    rationale: "The failing artifact most likely points to implementation logic.",
    nextAction: "Repair the product or business logic implicated by the failure.",
  };
}

export function buildRetryContext(classification: FailureClassification | null): string[] {
  if (!classification) {
    return [];
  }

  return [
    `Failure category: ${classification.category}`,
    `Failure rationale: ${classification.rationale}`,
    `Suggested next action: ${classification.nextAction}`,
  ];
}

export function isVerificationPlanIssue(category: FailureCategory | null): boolean {
  return category === "bad_command_plan";
}
