import type { CommandInvoker, CommandResult } from "../agents/command-invoker.js";
import type { ArtifactStore } from "./artifact-store.js";
import type { ArtifactRecord } from "../domain/run.js";

export interface VerificationCommandResult {
  command: string;
  result: CommandResult;
  artifact: ArtifactRecord;
}

export interface VerificationRunResult {
  success: boolean;
  executed: VerificationCommandResult[];
  rejected: string[];
}

export interface VerificationRunInput {
  runId: string;
  phaseId: string;
  repoRoot: string;
  proposedCommands: string[];
  allowlistedCommands: string[];
}

export class VerificationRunner {
  constructor(
    private readonly invoker: CommandInvoker,
    private readonly artifactStore: ArtifactStore
  ) {}

  async run(input: VerificationRunInput): Promise<VerificationRunResult> {
    const selection = selectVerificationCommands(
      input.proposedCommands,
      input.allowlistedCommands
    );
    const executed: VerificationCommandResult[] = [];

    for (const command of selection.commandsToRun) {
      const { artifact, result } = await this.executeCommand({
        runId: input.runId,
        phaseId: input.phaseId,
        repoRoot: input.repoRoot,
        command
      });

      executed.push({
        command,
        result,
        artifact
      });
    }

    return {
      success: executed.every((entry) => entry.result.exitCode === 0),
      executed,
      rejected: selection.rejected
    };
  }

  async executeCommand(input: {
    runId: string;
    phaseId: string;
    repoRoot: string;
    command: string;
  }): Promise<{
    result: CommandResult;
    artifact: ArtifactRecord;
  }> {
    const result = await this.invoker.exec({
      command: "zsh",
      args: ["-c", input.command],
      cwd: input.repoRoot,
      timeoutMs: 300_000
    });
    const artifact = await this.artifactStore.saveCommandResult({
      runId: input.runId,
      phaseId: input.phaseId,
      command: input.command,
      result,
      cwd: input.repoRoot
    });

    return {
      result,
      artifact
    };
  }
}

export function selectVerificationCommands(
  proposedCommands: string[],
  allowlistedCommands: string[]
): {
  commandsToRun: string[];
  rejected: string[];
} {
  const allowed = new Set(allowlistedCommands.map(normalizeCommand));
  const normalizedProposed = uniqueNormalizedCommands(proposedCommands);
  const approvedProposed = normalizedProposed.filter((command) => allowed.has(command));
  const rejected = normalizedProposed.filter((command) => !allowed.has(command));

  return {
    commandsToRun:
      approvedProposed.length > 0
        ? approvedProposed
        : uniqueNormalizedCommands(allowlistedCommands),
    rejected
  };
}

function uniqueNormalizedCommands(commands: string[]): string[] {
  return [...new Set(commands.map(normalizeCommand).filter(Boolean))];
}

function normalizeCommand(command: string): string {
  return command.trim();
}
