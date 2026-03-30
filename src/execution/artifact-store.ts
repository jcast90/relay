import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { CommandResult } from "../agents/command-invoker.js";
import type { FailureClassification } from "../domain/agent.js";
import type {
  ArtifactRecord,
  PhaseLedgerEntry,
  RunIndexEntry
} from "../domain/run.js";

export interface SaveCommandArtifactInput {
  runId: string;
  phaseId: string;
  command: string;
  result: CommandResult;
  cwd: string;
}

export interface CommandArtifactContent {
  artifactId: string;
  phaseId: string;
  command: string;
  cwd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  capturedAt: string;
}

export interface FailureClassificationArtifactContent {
  artifactId: string;
  phaseId: string;
  category: FailureClassification["category"];
  rationale: string;
  nextAction: string;
  capturedAt: string;
}

export interface ArtifactStore {
  saveCommandResult(input: SaveCommandArtifactInput): Promise<ArtifactRecord>;
  saveFailureClassification(input: {
    runId: string;
    phaseId: string;
    classification: FailureClassification;
  }): Promise<ArtifactRecord>;
  readCommandResult(path: string): Promise<CommandArtifactContent>;
  readFailureClassification(path: string): Promise<FailureClassificationArtifactContent>;
  savePhaseLedger(input: {
    runId: string;
    phaseLedger: PhaseLedgerEntry[];
  }): Promise<string>;
  saveRunsIndex(input: {
    entry: RunIndexEntry;
  }): Promise<string>;
  readRunsIndex(): Promise<RunIndexEntry[]>;
}

export class LocalArtifactStore implements ArtifactStore {
  constructor(private readonly rootDir: string) {}

  async saveCommandResult(
    input: SaveCommandArtifactInput
  ): Promise<ArtifactRecord> {
    const artifactId = buildArtifactId();
    const phaseDir = join(this.rootDir, input.runId, input.phaseId);

    await mkdir(phaseDir, {
      recursive: true
    });

    const path = join(phaseDir, `${artifactId}.json`);

    await writeFile(
      path,
      JSON.stringify(
        {
          artifactId,
          phaseId: input.phaseId,
          command: input.command,
          cwd: input.cwd,
          exitCode: input.result.exitCode,
          stdout: input.result.stdout,
          stderr: input.result.stderr,
          capturedAt: new Date().toISOString()
        },
        null,
        2
      )
    );

    return {
      artifactId,
      phaseId: input.phaseId,
      type: "command_result",
      path,
      command: input.command,
      exitCode: input.result.exitCode
    };
  }

  async readCommandResult(path: string): Promise<CommandArtifactContent> {
    return JSON.parse(await readFile(path, "utf8")) as CommandArtifactContent;
  }

  async saveFailureClassification(input: {
    runId: string;
    phaseId: string;
    classification: FailureClassification;
  }): Promise<ArtifactRecord> {
    const artifactId = buildArtifactId();
    const phaseDir = join(this.rootDir, input.runId, input.phaseId);

    await mkdir(phaseDir, {
      recursive: true
    });

    const path = join(phaseDir, `${artifactId}.json`);

    await writeFile(
      path,
      JSON.stringify(
        {
          artifactId,
          phaseId: input.phaseId,
          category: input.classification.category,
          rationale: input.classification.rationale,
          nextAction: input.classification.nextAction,
          capturedAt: new Date().toISOString()
        },
        null,
        2
      )
    );

    return {
      artifactId,
      phaseId: input.phaseId,
      type: "failure_classification",
      path,
      category: input.classification.category,
      rationale: input.classification.rationale,
      nextAction: input.classification.nextAction
    };
  }

  async readFailureClassification(
    path: string
  ): Promise<FailureClassificationArtifactContent> {
    return JSON.parse(
      await readFile(path, "utf8")
    ) as FailureClassificationArtifactContent;
  }

  async savePhaseLedger(input: {
    runId: string;
    phaseLedger: PhaseLedgerEntry[];
  }): Promise<string> {
    const runDir = join(this.rootDir, input.runId);

    await mkdir(runDir, {
      recursive: true
    });

    const path = join(runDir, "phase-ledger.json");

    await writeFile(
      path,
      JSON.stringify(
        {
          runId: input.runId,
          updatedAt: new Date().toISOString(),
          phases: input.phaseLedger
        },
        null,
        2
      )
    );

    return path;
  }

  async saveRunsIndex(input: {
    entry: RunIndexEntry;
  }): Promise<string> {
    const path = join(this.rootDir, "runs-index.json");
    const existing = await this.readRunsIndex();
    const next = [
      input.entry,
      ...existing.filter((entry) => entry.runId !== input.entry.runId)
    ].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

    await writeFile(
      path,
      JSON.stringify(
        {
          updatedAt: new Date().toISOString(),
          runs: next
        },
        null,
        2
      )
    );

    return path;
  }

  async readRunsIndex(): Promise<RunIndexEntry[]> {
    const path = join(this.rootDir, "runs-index.json");

    try {
      const raw = JSON.parse(await readFile(path, "utf8")) as {
        runs?: RunIndexEntry[];
      };
      return raw.runs ?? [];
    } catch {
      return [];
    }
  }
}

function buildArtifactId(): string {
  return `artifact-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
