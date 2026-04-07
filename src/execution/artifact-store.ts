import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";

import type { CommandResult } from "../agents/command-invoker.js";
import type { FailureClassification } from "../domain/agent.js";
import type { ClassificationResult } from "../domain/classification.js";
import type { PrLifecycle } from "../domain/pr-lifecycle.js";
import type { TicketLedgerEntry } from "../domain/ticket.js";
import type {
  ArtifactRecord,
  EvidenceRecord,
  HarnessRun,
  PhaseLedgerEntry,
  RunEvent,
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

export interface RunSnapshot {
  runId: string;
  featureRequest: string;
  state: HarnessRun["state"];
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  classification: HarnessRun["classification"];
  plan: HarnessRun["plan"];
  ticketPlan: HarnessRun["ticketPlan"];
  evidence: EvidenceRecord[];
  artifacts: ArtifactRecord[];
  phaseLedger: PhaseLedgerEntry[];
  ticketLedger: HarnessRun["ticketLedger"];
  eventCount: number;
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
  saveRunSnapshot(run: HarnessRun): Promise<string>;
  readRunSnapshot(runId: string): Promise<RunSnapshot | null>;
  appendEvent(runId: string, event: RunEvent): Promise<void>;
  readEventLog(runId: string): Promise<RunEvent[]>;
  savePrLifecycle(lifecycle: PrLifecycle): Promise<string>;
  readPrLifecycle(runId: string): Promise<PrLifecycle | null>;
  saveTicketLedger(input: { runId: string; ticketLedger: TicketLedgerEntry[] }): Promise<string>;
  readTicketLedger(runId: string): Promise<TicketLedgerEntry[] | null>;
  saveClassification(input: { runId: string; classification: ClassificationResult }): Promise<string>;
  saveDesignDoc(input: { runId: string; content: string }): Promise<string>;
  saveApprovalRecord(input: { runId: string; decision: "approved" | "rejected"; feedback?: string }): Promise<string>;
  readApprovalRecord(runId: string): Promise<{ decision: "approved" | "rejected"; feedback?: string; timestamp: string } | null>;
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

  async saveRunSnapshot(run: HarnessRun): Promise<string> {
    const runDir = join(this.rootDir, run.id);
    await mkdir(runDir, { recursive: true });

    const path = join(runDir, "run.json");
    const snapshot: RunSnapshot = {
      runId: run.id,
      featureRequest: run.featureRequest,
      state: run.state,
      startedAt: run.startedAt,
      updatedAt: run.updatedAt,
      completedAt: run.completedAt,
      classification: run.classification,
      plan: run.plan,
      ticketPlan: run.ticketPlan,
      evidence: run.evidence,
      artifacts: run.artifacts,
      phaseLedger: run.phaseLedger,
      ticketLedger: run.ticketLedger,
      eventCount: run.events.length
    };

    await writeFile(path, JSON.stringify(snapshot, null, 2));
    return path;
  }

  async readRunSnapshot(runId: string): Promise<RunSnapshot | null> {
    const path = join(this.rootDir, runId, "run.json");

    try {
      return JSON.parse(await readFile(path, "utf8")) as RunSnapshot;
    } catch {
      return null;
    }
  }

  async appendEvent(runId: string, event: RunEvent): Promise<void> {
    const runDir = join(this.rootDir, runId);
    await mkdir(runDir, { recursive: true });

    const path = join(runDir, "events.jsonl");
    await appendFile(path, JSON.stringify(event) + "\n");
  }

  async readEventLog(runId: string): Promise<RunEvent[]> {
    const path = join(this.rootDir, runId, "events.jsonl");

    try {
      const raw = await readFile(path, "utf8");
      return raw
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as RunEvent);
    } catch {
      return [];
    }
  }

  async savePrLifecycle(lifecycle: PrLifecycle): Promise<string> {
    const runDir = join(this.rootDir, lifecycle.runId);
    await mkdir(runDir, { recursive: true });

    const path = join(runDir, "pr-lifecycle.json");
    await writeFile(path, JSON.stringify(lifecycle, null, 2));
    return path;
  }

  async readPrLifecycle(runId: string): Promise<PrLifecycle | null> {
    const path = join(this.rootDir, runId, "pr-lifecycle.json");

    try {
      return JSON.parse(await readFile(path, "utf8")) as PrLifecycle;
    } catch {
      return null;
    }
  }

  async saveTicketLedger(input: {
    runId: string;
    ticketLedger: TicketLedgerEntry[];
  }): Promise<string> {
    const runDir = join(this.rootDir, input.runId);
    await mkdir(runDir, { recursive: true });

    const path = join(runDir, "ticket-ledger.json");

    await writeFile(
      path,
      JSON.stringify(
        {
          runId: input.runId,
          updatedAt: new Date().toISOString(),
          tickets: input.ticketLedger
        },
        null,
        2
      )
    );

    return path;
  }

  async readTicketLedger(runId: string): Promise<TicketLedgerEntry[] | null> {
    const path = join(this.rootDir, runId, "ticket-ledger.json");

    try {
      const raw = JSON.parse(await readFile(path, "utf8")) as {
        tickets?: TicketLedgerEntry[];
      };
      return raw.tickets ?? null;
    } catch {
      return null;
    }
  }

  async saveClassification(input: {
    runId: string;
    classification: ClassificationResult;
  }): Promise<string> {
    const runDir = join(this.rootDir, input.runId);
    await mkdir(runDir, { recursive: true });

    const path = join(runDir, "classification.json");

    await writeFile(
      path,
      JSON.stringify(
        {
          runId: input.runId,
          ...input.classification,
          classifiedAt: new Date().toISOString()
        },
        null,
        2
      )
    );

    return path;
  }

  async saveDesignDoc(input: {
    runId: string;
    content: string;
  }): Promise<string> {
    const runDir = join(this.rootDir, input.runId);
    await mkdir(runDir, { recursive: true });

    const path = join(runDir, "design-doc.md");
    await writeFile(path, input.content);
    return path;
  }

  async saveApprovalRecord(input: {
    runId: string;
    decision: "approved" | "rejected";
    feedback?: string;
  }): Promise<string> {
    const runDir = join(this.rootDir, input.runId);
    await mkdir(runDir, { recursive: true });

    const path = join(runDir, "approval.json");

    await writeFile(
      path,
      JSON.stringify(
        {
          runId: input.runId,
          decision: input.decision,
          feedback: input.feedback ?? null,
          timestamp: new Date().toISOString()
        },
        null,
        2
      )
    );

    return path;
  }

  async readApprovalRecord(runId: string): Promise<{
    decision: "approved" | "rejected";
    feedback?: string;
    timestamp: string;
  } | null> {
    const path = join(this.rootDir, runId, "approval.json");

    try {
      return JSON.parse(await readFile(path, "utf8")) as {
        decision: "approved" | "rejected";
        feedback?: string;
        timestamp: string;
      };
    } catch {
      return null;
    }
  }
}

function buildArtifactId(): string {
  return `artifact-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
