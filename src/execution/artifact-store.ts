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
import { buildHarnessStore } from "../storage/factory.js";
import { STORE_NS } from "../storage/namespaces.js";
import type { HarnessStore } from "../storage/store.js";

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
  channelId: string | null;
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

/**
 * Coordination record written through the injected `HarnessStore` every time a
 * Rust/GUI-visible run artifact is mutated. Rust and the Tauri GUI read the
 * on-disk JSON/JSONL files directly (`runs-index.json`, `<runId>/run.json`,
 * `<runId>/ticket-ledger.json`, `<runId>/phase-ledger.json`,
 * `<runId>/pr-lifecycle.json`, `<runId>/events.jsonl`), so the data itself
 * stays direct-file. This small record serializes concurrent writers through
 * `store.mutate` — on Postgres (T-402) it runs under
 * `pg_advisory_xact_lock`, giving multi-process schedulers a cross-process
 * coordination hook. Advisory-only; nothing reads it today.
 */
interface RunArtifactCoordRecord {
  kind:
    | "run-snapshot"
    | "runs-index"
    | "phase-ledger"
    | "ticket-ledger"
    | "pr-lifecycle"
    | "events";
  updatedAt: string;
  count?: number;
}

function coordId(runId: string, kind: RunArtifactCoordRecord["kind"]): string {
  // Flat id encoding — `HarnessStore` rejects slashes in ids, so the runId
  // and the record kind are joined with a double-underscore separator that
  // cannot appear in a runId (`run-<ts>-<rand>`) or in the fixed kind set.
  return `${runId}__${kind}`;
}

function blobId(runId: string, phaseId: string, artifactId: string): string {
  return `${runId}__${phaseId}__${artifactId}`;
}

const BLOB_URI_PREFIX = "blob://";

function buildBlobUri(id: string): string {
  return `${BLOB_URI_PREFIX}${STORE_NS.runArtifacts}/${id}`;
}

/**
 * Parse a `blob://<ns>/<id>` URI or signal legacy-path fallback.
 *
 * Three possible outcomes:
 * - Input starts with `blob://` and is well-formed → returns `{ ns, id }`.
 * - Input starts with `blob://` but is malformed (missing slash, empty ns,
 *   or empty id) → throws with the offending URI included in the message.
 *   We do NOT silently treat a half-baked blob URI as a filesystem path;
 *   that would mask a real bug in whoever produced the URI.
 * - Input does not start with `blob://` → returns `null`, signaling that
 *   the caller should fall through to the pre-T-103 legacy absolute-path
 *   read. Existing run histories still carry absolute paths in `run.json`.
 */
function parseBlobUri(
  uri: string
): { ns: string; id: string } | null {
  if (!uri.startsWith(BLOB_URI_PREFIX)) return null;
  const rest = uri.slice(BLOB_URI_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash < 0) {
    throw new Error(
      `Invalid blob URI (missing '/'): ${uri}`
    );
  }
  const ns = rest.slice(0, slash);
  const id = rest.slice(slash + 1);
  if (!ns) {
    throw new Error(`Invalid blob URI (empty namespace): ${uri}`);
  }
  if (!id) {
    throw new Error(`Invalid blob URI (empty id): ${uri}`);
  }
  return { ns, id };
}

// Warn once per distinct legacy absolute path so operators know that an
// older run history is driving a direct-file read rather than the
// HarnessStore blob path.
const legacyPathWarned = new Set<string>();
function warnLegacyArtifactPath(path: string): void {
  if (legacyPathWarned.has(path)) return;
  legacyPathWarned.add(path);
  // eslint-disable-next-line no-console
  console.warn(
    `[artifact-store] Reading artifact via legacy absolute-path fallback: ${path}. ` +
      `This run predates T-103 and should be regenerated to migrate onto the HarnessStore blob backend.`
  );
}

async function readLegacyArtifactFile(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `Artifact not found at ${path} (legacy absolute-path fallback). Artifact may have been cleaned or written by a run on another machine.`
      );
    }
    throw err;
  }
}

export class LocalArtifactStore implements ArtifactStore {
  private readonly store: HarnessStore;

  /**
   * @param rootDir On-disk artifact root. This is the workspace-scoped
   *   `artifacts/` directory that Rust's `crates/harness-data` and the Tauri
   *   GUI read from directly — see `load_runs_for_workspace`,
   *   `load_ticket_ledger`. Do not move these paths without also updating
   *   the Rust crate and the desktop app.
   * @param store `HarnessStore` used for artifacts that have migrated off
   *   direct filesystem access (command results, failure classifications,
   *   classification docs, approval records, design docs) and for the
   *   coordination records written alongside Rust-compat writes. Defaults to
   *   `buildHarnessStore()` so callers that don't inject one pick up the
   *   process-wide default through the factory. Tests substitute a
   *   `FakeHarnessStore` here.
   *
   * NOTE: The Rust-visible artifacts (`runs-index.json`,
   * `<runId>/{run.json,events.jsonl,ticket-ledger.json,phase-ledger.json,
   * pr-lifecycle.json}`) continue to be written directly to `rootDir`. A
   * small coordination record is written through the store per mutation so
   * T-402's Postgres backend can layer cross-process coordination on top.
   * T-103a tracks aligning the Rust crate so the data itself can flow
   * through `HarnessStore`.
   */
  constructor(
    private readonly rootDir: string,
    store?: HarnessStore
  ) {
    this.store = store ?? buildHarnessStore();
  }

  async saveCommandResult(
    input: SaveCommandArtifactInput
  ): Promise<ArtifactRecord> {
    const artifactId = buildArtifactId();
    const content: CommandArtifactContent = {
      artifactId,
      phaseId: input.phaseId,
      command: input.command,
      cwd: input.cwd,
      exitCode: input.result.exitCode,
      stdout: input.result.stdout,
      stderr: input.result.stderr,
      capturedAt: new Date().toISOString()
    };

    const id = blobId(input.runId, input.phaseId, artifactId);
    const bytes = new TextEncoder().encode(JSON.stringify(content, null, 2));
    await this.store.putBlob(STORE_NS.runArtifacts, id, bytes, {
      contentType: "application/json",
      runId: input.runId,
      phaseId: input.phaseId,
      artifactType: "command_result"
    });

    return {
      artifactId,
      phaseId: input.phaseId,
      type: "command_result",
      path: buildBlobUri(id),
      command: input.command,
      exitCode: input.result.exitCode
    };
  }

  async readCommandResult(path: string): Promise<CommandArtifactContent> {
    const ref = parseBlobUri(path);
    if (ref) {
      const bytes = await this.store.getBlob({
        ns: ref.ns,
        id: ref.id,
        size: 0
      });
      return JSON.parse(new TextDecoder().decode(bytes)) as CommandArtifactContent;
    }
    // Legacy: pre-T-103 artifacts stored as loose files under `<runId>/<phaseId>/<artifactId>.json`.
    // Existing run histories still carry those absolute paths in `run.json`,
    // so we fall back to a direct read when the path isn't a blob URI.
    warnLegacyArtifactPath(path);
    return JSON.parse(await readLegacyArtifactFile(path)) as CommandArtifactContent;
  }

  async saveFailureClassification(input: {
    runId: string;
    phaseId: string;
    classification: FailureClassification;
  }): Promise<ArtifactRecord> {
    const artifactId = buildArtifactId();
    const content: FailureClassificationArtifactContent = {
      artifactId,
      phaseId: input.phaseId,
      category: input.classification.category,
      rationale: input.classification.rationale,
      nextAction: input.classification.nextAction,
      capturedAt: new Date().toISOString()
    };

    const id = blobId(input.runId, input.phaseId, artifactId);
    const bytes = new TextEncoder().encode(JSON.stringify(content, null, 2));
    await this.store.putBlob(STORE_NS.runArtifacts, id, bytes, {
      contentType: "application/json",
      runId: input.runId,
      phaseId: input.phaseId,
      artifactType: "failure_classification"
    });

    return {
      artifactId,
      phaseId: input.phaseId,
      type: "failure_classification",
      path: buildBlobUri(id),
      category: input.classification.category,
      rationale: input.classification.rationale,
      nextAction: input.classification.nextAction
    };
  }

  async readFailureClassification(
    path: string
  ): Promise<FailureClassificationArtifactContent> {
    const ref = parseBlobUri(path);
    if (ref) {
      const bytes = await this.store.getBlob({
        ns: ref.ns,
        id: ref.id,
        size: 0
      });
      return JSON.parse(
        new TextDecoder().decode(bytes)
      ) as FailureClassificationArtifactContent;
    }
    warnLegacyArtifactPath(path);
    return JSON.parse(
      await readLegacyArtifactFile(path)
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

    await this.writeCoordRecord(input.runId, "phase-ledger", input.phaseLedger.length);
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

    // Index-wide coordination record — shares the `runs-index` sentinel runId
    // since there is only one index per rootDir (workspace).
    await this.writeCoordRecord("runs-index", "runs-index", next.length);
    return path;
  }

  async readRunsIndex(): Promise<RunIndexEntry[]> {
    const path = join(this.rootDir, "runs-index.json");
    let content: string;

    try {
      content = await readFile(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw new Error(
        `Failed to read runs index at ${path}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }

    try {
      const raw = JSON.parse(content) as { runs?: RunIndexEntry[] };
      return raw.runs ?? [];
    } catch (err) {
      throw new Error(
        `Failed to parse runs index at ${path}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
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
      channelId: run.channelId,
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
    await this.writeCoordRecord(run.id, "run-snapshot", run.events.length);
    return path;
  }

  async readRunSnapshot(runId: string): Promise<RunSnapshot | null> {
    const path = join(this.rootDir, runId, "run.json");
    let content: string;

    try {
      content = await readFile(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw new Error(
        `Failed to read run snapshot at ${path}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }

    try {
      return JSON.parse(content) as RunSnapshot;
    } catch (err) {
      throw new Error(
        `Failed to parse run snapshot at ${path}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  async appendEvent(runId: string, event: RunEvent): Promise<void> {
    const runDir = join(this.rootDir, runId);
    await mkdir(runDir, { recursive: true });

    const path = join(runDir, "events.jsonl");
    await appendFile(path, JSON.stringify(event) + "\n");
    await this.writeCoordRecord(runId, "events");
  }

  async readEventLog(runId: string): Promise<RunEvent[]> {
    const path = join(this.rootDir, runId, "events.jsonl");
    let raw: string;

    try {
      raw = await readFile(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw new Error(
        `Failed to read event log at ${path}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }

    try {
      return raw
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as RunEvent);
    } catch (err) {
      throw new Error(
        `Failed to parse event log at ${path}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  async savePrLifecycle(lifecycle: PrLifecycle): Promise<string> {
    const runDir = join(this.rootDir, lifecycle.runId);
    await mkdir(runDir, { recursive: true });

    const path = join(runDir, "pr-lifecycle.json");
    await writeFile(path, JSON.stringify(lifecycle, null, 2));
    await this.writeCoordRecord(lifecycle.runId, "pr-lifecycle");
    return path;
  }

  async readPrLifecycle(runId: string): Promise<PrLifecycle | null> {
    const path = join(this.rootDir, runId, "pr-lifecycle.json");
    let content: string;

    try {
      content = await readFile(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw new Error(
        `Failed to read PR lifecycle at ${path}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }

    try {
      return JSON.parse(content) as PrLifecycle;
    } catch (err) {
      throw new Error(
        `Failed to parse PR lifecycle at ${path}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
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

    await this.writeCoordRecord(
      input.runId,
      "ticket-ledger",
      input.ticketLedger.length
    );
    return path;
  }

  async readTicketLedger(runId: string): Promise<TicketLedgerEntry[] | null> {
    const path = join(this.rootDir, runId, "ticket-ledger.json");
    let content: string;

    try {
      content = await readFile(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw new Error(
        `Failed to read ticket ledger at ${path}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }

    try {
      const raw = JSON.parse(content) as { tickets?: TicketLedgerEntry[] };
      return raw.tickets ?? null;
    } catch (err) {
      throw new Error(
        `Failed to parse ticket ledger at ${path}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  async saveClassification(input: {
    runId: string;
    classification: ClassificationResult;
  }): Promise<string> {
    const id = `${input.runId}__classification`;
    const doc = {
      runId: input.runId,
      ...input.classification,
      classifiedAt: new Date().toISOString()
    };
    await this.store.putDoc(STORE_NS.runArtifacts, id, doc);
    return buildBlobUri(id);
  }

  async saveDesignDoc(input: {
    runId: string;
    content: string;
  }): Promise<string> {
    const id = `${input.runId}__design-doc`;
    const bytes = new TextEncoder().encode(input.content);
    await this.store.putBlob(STORE_NS.runArtifacts, id, bytes, {
      contentType: "text/markdown",
      runId: input.runId,
      artifactType: "design_doc"
    });
    return buildBlobUri(id);
  }

  async saveApprovalRecord(input: {
    runId: string;
    decision: "approved" | "rejected";
    feedback?: string;
  }): Promise<string> {
    const id = `${input.runId}__approval`;
    const doc = {
      runId: input.runId,
      decision: input.decision,
      feedback: input.feedback ?? null,
      timestamp: new Date().toISOString()
    };
    await this.store.putDoc(STORE_NS.runArtifacts, id, doc);
    return buildBlobUri(id);
  }

  async readApprovalRecord(runId: string): Promise<{
    decision: "approved" | "rejected";
    feedback?: string;
    timestamp: string;
  } | null> {
    const id = `${runId}__approval`;
    const doc = await this.store.getDoc<{
      runId: string;
      decision: "approved" | "rejected";
      feedback: string | null;
      timestamp: string;
    }>(STORE_NS.runArtifacts, id);
    if (!doc) return null;
    return {
      decision: doc.decision,
      feedback: doc.feedback ?? undefined,
      timestamp: doc.timestamp
    };
  }

  /**
   * Advisory coordination record for Rust-visible run artifacts. See the
   * `RunArtifactCoordRecord` doc for rationale. Uses `mutate` so the call
   * runs under the backend's serialization primitive (in-process Promise
   * chain on `FileHarnessStore`; `pg_advisory_xact_lock` on Postgres).
   */
  private async writeCoordRecord(
    runId: string,
    kind: RunArtifactCoordRecord["kind"],
    count?: number
  ): Promise<void> {
    await this.store.mutate<RunArtifactCoordRecord>(
      STORE_NS.runArtifacts,
      coordId(runId, kind),
      () => ({
        kind,
        updatedAt: new Date().toISOString(),
        ...(count !== undefined ? { count } : {})
      })
    );
  }
}

function buildArtifactId(): string {
  return `artifact-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
