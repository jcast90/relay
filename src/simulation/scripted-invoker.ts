import { writeFile } from "node:fs/promises";

import { createSeedPlan } from "../domain/phase-plan.js";
import type { CommandInvocation, CommandInvoker, CommandResult } from "../agents/command-invoker.js";

export class ScriptedInvoker implements CommandInvoker {
  constructor(private readonly cwd: string) {}

  async exec(invocation: CommandInvocation): Promise<CommandResult> {
    const prompt = invocation.args.at(-1) ?? invocation.stdin ?? "";
    const response = buildResponse(prompt, this.cwd);

    if (invocation.command === "codex") {
      const outputFlagIndex = invocation.args.findIndex((arg) => arg === "-o");
      const outputPath = outputFlagIndex >= 0
        ? invocation.args[outputFlagIndex + 1]
        : undefined;

      if (!outputPath) {
        throw new Error("Scripted codex invocation missing output file path.");
      }

      await writeFile(outputPath, JSON.stringify(response, null, 2));

      return {
        stdout: "",
        stderr: "",
        exitCode: 0
      };
    }

    return {
      stdout: JSON.stringify(response),
      stderr: "",
      exitCode: 0
    };
  }
}

function buildResponse(prompt: string, cwd: string) {
  const title = readField(prompt, "Title") ?? "Untitled work";
  const workKind = readField(prompt, "Work kind");

  if (workKind === "classify_request") {
    return {
      summary: `Classified "${title}" as a feature_small request.`,
      evidence: [
        "Request appears to be a moderate-scope feature addition."
      ],
      proposedCommands: [],
      blockers: [],
      classification: {
        tier: "feature_small",
        rationale: "Moderate scope feature request requiring a few implementation tickets.",
        suggestedSpecialties: ["general"],
        estimatedTicketCount: 3,
        needsDesignDoc: false,
        needsUserApproval: false
      }
    };
  }

  if (workKind === "generate_design_doc") {
    return {
      summary: `Generated design document for "${title}".`,
      evidence: [
        "Design document covers architecture, trade-offs, and implementation approach."
      ],
      proposedCommands: [],
      blockers: []
    };
  }

  if (workKind === "decompose_tickets") {
    return {
      summary: `Decomposed "${title}" into parallelizable tickets.`,
      evidence: [
        "Tickets were derived from the phase plan.",
        "Dependencies between tickets were identified."
      ],
      proposedCommands: [],
      blockers: [],
      ticketPlan: {
        version: 1,
        task: {
          title,
          featureRequest: title,
          repoRoot: cwd
        },
        classification: {
          tier: "feature_small",
          rationale: "Scripted classification for simulation.",
          suggestedSpecialties: ["general"],
          estimatedTicketCount: 2,
          needsDesignDoc: false,
          needsUserApproval: false
        },
        tickets: [
          {
            id: "ticket_01",
            title: "Implement core logic",
            objective: "Implement the primary feature logic.",
            specialty: "general",
            acceptanceCriteria: ["Core logic implemented and type-safe."],
            allowedCommands: ["pnpm typecheck"],
            verificationCommands: ["pnpm typecheck"],
            docsToUpdate: [],
            dependsOn: [],
            retryPolicy: { maxAgentAttempts: 2, maxTestFixLoops: 2 }
          },
          {
            id: "ticket_02",
            title: "Add tests and verification",
            objective: "Add tests for the implemented logic.",
            specialty: "testing",
            acceptanceCriteria: ["Tests pass for new logic."],
            allowedCommands: ["pnpm typecheck", "pnpm test"],
            verificationCommands: ["pnpm typecheck", "pnpm test"],
            docsToUpdate: ["README.md"],
            dependsOn: ["ticket_01"],
            retryPolicy: { maxAgentAttempts: 2, maxTestFixLoops: 2 }
          }
        ],
        finalVerification: { commands: ["pnpm typecheck", "pnpm test"] },
        docsToUpdate: ["README.md"]
      }
    };
  }

  if (workKind === "draft_plan") {
    return {
      summary: `Created a structured phase plan for "${title}".`,
      evidence: [
        "Planner produced a bounded multi-phase plan.",
        "Retry budgets and verification commands were included."
      ],
      proposedCommands: [],
      blockers: [],
      phasePlan: createSeedPlan(title, cwd)
    };
  }

  if (workKind === "implement_phase") {
    return {
      summary: `Prepared implementation guidance for "${title}".`,
      evidence: [
        "Implementation agent identified the phase objective.",
        "Acceptance criteria were preserved in the response."
      ],
      proposedCommands: ["pnpm typecheck"],
      blockers: []
    };
  }

  if (workKind === "classify_failure") {
    const artifactContext = readArtifactContext(prompt);
    const lowerArtifactContext = artifactContext.toLowerCase();

    let category: "fix_code" | "fix_test" | "bad_command_plan" = "fix_code";
    let rationale = "The failing artifact points to application or implementation logic.";
    let nextAction = "Repair the product or business logic implicated by the failing artifact.";

    if (
      lowerArtifactContext.includes("not_allowlisted") ||
      lowerArtifactContext.includes("command not found") ||
      lowerArtifactContext.includes("requires at least node.js")
    ) {
      category = "bad_command_plan";
      rationale = "The failure points to the verification command plan or execution environment.";
      nextAction = "Adjust the verification command plan before changing product code.";
    } else if (
      lowerArtifactContext.includes("expected") ||
      lowerArtifactContext.includes("assert") ||
      lowerArtifactContext.includes("test failed")
    ) {
      category = "fix_test";
      rationale = "The failure looks isolated to tests, fixtures, or verification setup.";
      nextAction = "Repair tests, fixtures, or verification setup before changing product code.";
    }

    return {
      summary: `Classified the failure for "${title}" as ${category}.`,
      evidence: [
        "Failure category was derived from captured artifact contents."
      ],
      proposedCommands: [],
      blockers: [],
      failureClassification: {
        category,
        rationale,
        nextAction
      }
    };
  }

  if (workKind === "run_checks") {
    return {
      summary: `Prepared a verification pass for "${title}".`,
      evidence: [
        "Verification commands were surfaced back to the harness."
      ],
      proposedCommands: ["pnpm typecheck", "pnpm test"],
      blockers: []
    };
  }

  return {
    summary: `Reviewed "${title}" for correctness and scope alignment.`,
    evidence: [
      "Review covered scope drift and missing acceptance criteria."
    ],
    proposedCommands: [],
    blockers: []
  };
}

function readField(prompt: string, label: string): string | null {
  const prefix = `${label}: `;
  const line = prompt.split("\n").find((entry) => entry.startsWith(prefix));
  return line ? line.slice(prefix.length) : null;
}

function readArtifactContext(prompt: string): string {
  const marker = "Artifact context:\n";
  const start = prompt.indexOf(marker);

  if (start < 0) {
    return "";
  }

  return prompt.slice(start + marker.length);
}
