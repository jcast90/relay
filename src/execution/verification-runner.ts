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
  /**
   * True when the agent's proposed commands were all rejected (not on the
   * allowlist) and we substituted the full allowlist instead of running the
   * agent's choices. Callers should surface this to users — otherwise
   * "verification passed" can hide the fact that none of the agent's
   * intended checks actually ran.
   */
  overridden: boolean;
  /**
   * When `overridden` is true, the commands the runner actually executed in
   * place of the agent's rejected proposals. Empty otherwise.
   */
  substitutedCommands: string[];
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
      rejected: selection.rejected,
      overridden: selection.overridden,
      substitutedCommands: selection.overridden ? [...selection.commandsToRun] : []
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
  /**
   * True when the agent proposed commands but none of them were on the
   * allowlist, so we fell back to running the full allowlist instead of the
   * agent's picks. Callers should surface this — otherwise the run appears
   * "verification passed" when the agent's intended checks never ran.
   */
  overridden: boolean;
} {
  const allowed = new Set(allowlistedCommands.map(normalizeCommand));
  const normalizedProposed = uniqueNormalizedCommands(proposedCommands);
  const approvedProposed = normalizedProposed.filter((command) => allowed.has(command));
  const rejected = normalizedProposed.filter((command) => !allowed.has(command));

  // Substitution happens when the agent proposed *something* but nothing it
  // proposed was approved, so we fall back to the allowlist. "No proposals"
  // does not count as an override — that's the documented default path.
  const overridden = normalizedProposed.length > 0 && approvedProposed.length === 0;

  return {
    commandsToRun:
      approvedProposed.length > 0
        ? approvedProposed
        : uniqueNormalizedCommands(allowlistedCommands),
    rejected,
    overridden
  };
}

function uniqueNormalizedCommands(commands: string[]): string[] {
  return [...new Set(commands.map(normalizeCommand).filter(Boolean))];
}

function normalizeCommand(command: string): string {
  return command.trim();
}
