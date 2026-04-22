import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createPrLifecycle } from "../src/domain/pr-lifecycle.js";
import { LocalArtifactStore } from "../src/execution/artifact-store.js";
import { FileHarnessStore } from "../src/storage/file-store.js";
import { STORE_NS } from "../src/storage/namespaces.js";
import type { BlobRef, ChangeEvent, HarnessStore, ReadLogOptions } from "../src/storage/store.js";
import type { HarnessRun, RunEvent } from "../src/domain/run.js";

/**
 * Minimal in-memory HarnessStore. Mirrors the T-101 FakeHarnessStore pattern
 * (test/channel-store-harness-store.test.ts) — only the methods the
 * LocalArtifactStore migration actually exercises are wired up with real
 * semantics; the rest throw to surface accidental usage during tests.
 */
class FakeHarnessStore implements HarnessStore {
  readonly docs: Map<string, unknown> = new Map();
  readonly blobs: Map<string, Uint8Array> = new Map();
  readonly mutateCalls: Array<{ ns: string; id: string }> = [];
  readonly blobCalls: Array<{ ns: string; id: string; meta?: Record<string, string> }> = [];

  private key(ns: string, id: string): string {
    return `${ns}\u0000${id}`;
  }

  async getDoc<T>(ns: string, id: string): Promise<T | null> {
    const v = this.docs.get(this.key(ns, id));
    return (v as T | undefined) ?? null;
  }

  async putDoc<T>(ns: string, id: string, doc: T): Promise<void> {
    this.docs.set(this.key(ns, id), doc);
  }

  async listDocs<T>(): Promise<T[]> {
    throw new Error("FakeHarnessStore.listDocs is not implemented");
  }

  async deleteDoc(): Promise<void> {
    throw new Error("FakeHarnessStore.deleteDoc is not implemented");
  }

  async appendLog(): Promise<void> {
    throw new Error("FakeHarnessStore.appendLog is not implemented");
  }

  async readLog<T>(_ns: string, _id: string, _opts?: ReadLogOptions): Promise<T[]> {
    throw new Error("FakeHarnessStore.readLog is not implemented");
  }

  async putBlob(
    ns: string,
    id: string,
    bytes: Uint8Array,
    meta?: Record<string, string>
  ): Promise<BlobRef> {
    this.blobCalls.push({ ns, id, meta });
    this.blobs.set(this.key(ns, id), bytes);
    return {
      ns,
      id,
      size: bytes.byteLength,
      contentType: meta?.["contentType"],
    };
  }

  async getBlob(ref: BlobRef): Promise<Uint8Array> {
    const bytes = this.blobs.get(this.key(ref.ns, ref.id));
    if (!bytes) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return bytes;
  }

  async mutate<T>(ns: string, id: string, fn: (prev: T | null) => T): Promise<T> {
    this.mutateCalls.push({ ns, id });
    const prev = (this.docs.get(this.key(ns, id)) as T | undefined) ?? null;
    const next = fn(prev);
    this.docs.set(this.key(ns, id), next);
    return next;
  }

  // eslint-disable-next-line require-yield
  async *watch(): AsyncIterable<ChangeEvent> {
    throw new Error("FakeHarnessStore.watch is not implemented");
  }
}

function buildTestRun(overrides?: Partial<HarnessRun>): HarnessRun {
  const now = "2026-04-20T00:00:00.000Z";
  return {
    id: "run-hs-1",
    featureRequest: "Widget",
    state: "PHASE_EXECUTE",
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
    runIndexPath: null,
    ...overrides,
  };
}

describe("LocalArtifactStore with HarnessStore injection", () => {
  let artifactsDir: string;
  let fake: FakeHarnessStore;
  let store: LocalArtifactStore;

  beforeEach(async () => {
    artifactsDir = await mkdtemp(join(tmpdir(), "as-hs-"));
    fake = new FakeHarnessStore();
    store = new LocalArtifactStore(artifactsDir, fake);
  });

  afterEach(async () => {
    await rm(artifactsDir, { recursive: true, force: true });
  });

  it("routes command-result artifacts through putBlob", async () => {
    const record = await store.saveCommandResult({
      runId: "run-hs-1",
      phaseId: "phase_01",
      command: "pnpm test",
      result: { exitCode: 0, stdout: "ok", stderr: "" },
      cwd: "/tmp",
    });

    expect(record.type).toBe("command_result");
    expect(record.path.startsWith("blob://")).toBe(true);
    expect(fake.blobCalls).toHaveLength(1);
    expect(fake.blobCalls[0].ns).toBe(STORE_NS.runArtifacts);
    expect(fake.blobCalls[0].meta?.contentType).toBe("application/json");

    const content = await store.readCommandResult(record.path);
    expect(content.command).toBe("pnpm test");
    expect(content.stdout).toBe("ok");
    expect(content.exitCode).toBe(0);
  });

  it("routes failure-classification artifacts through putBlob", async () => {
    const record = await store.saveFailureClassification({
      runId: "run-hs-1",
      phaseId: "phase_01",
      classification: {
        category: "fix_test",
        rationale: "verification setup",
        nextAction: "repair tests",
      },
    });

    expect(record.type).toBe("failure_classification");
    expect(record.path.startsWith("blob://")).toBe(true);
    expect(fake.blobCalls).toHaveLength(1);
    expect(fake.blobCalls[0].meta?.artifactType).toBe("failure_classification");

    const content = await store.readFailureClassification(record.path);
    expect(content.category).toBe("fix_test");
    expect(content.rationale).toBe("verification setup");
  });

  it("routes classification docs through putDoc", async () => {
    const uri = await store.saveClassification({
      runId: "run-hs-1",
      classification: {
        tier: "feature_small",
        rationale: "small change",
        suggestedSpecialties: [],
        estimatedTicketCount: 1,
        needsDesignDoc: false,
        needsUserApproval: false,
      },
    });

    expect(uri.startsWith("blob://")).toBe(true);
    const doc = await fake.getDoc<{ tier: string }>(
      STORE_NS.runArtifacts,
      "run-hs-1__classification"
    );
    expect(doc).not.toBeNull();
    expect(doc!.tier).toBe("feature_small");
  });

  it("routes design docs through putBlob", async () => {
    const uri = await store.saveDesignDoc({
      runId: "run-hs-1",
      content: "# Design\n\nSome markdown.",
    });

    expect(uri.startsWith("blob://")).toBe(true);
    expect(fake.blobCalls.some((c) => c.meta?.artifactType === "design_doc")).toBe(true);
    const bytes = await fake.getBlob({
      ns: STORE_NS.runArtifacts,
      id: "run-hs-1__design-doc",
      size: 0,
    });
    expect(new TextDecoder().decode(bytes)).toContain("# Design");
  });

  it("routes approval records through putDoc + getDoc", async () => {
    await store.saveApprovalRecord({
      runId: "run-hs-1",
      decision: "approved",
      feedback: "LGTM",
    });
    const record = await store.readApprovalRecord("run-hs-1");
    expect(record).not.toBeNull();
    expect(record!.decision).toBe("approved");
    expect(record!.feedback).toBe("LGTM");
  });

  it("writes a coordination record through HarnessStore.mutate for run snapshots", async () => {
    await store.saveRunSnapshot(buildTestRun());

    expect(fake.mutateCalls).toContainEqual({
      ns: STORE_NS.runArtifacts,
      id: "run-hs-1__run-snapshot",
    });

    // And the on-disk Rust-visible snapshot is still present at the
    // canonical path.
    const onDisk = join(artifactsDir, "run-hs-1", "run.json");
    await expect(stat(onDisk)).resolves.toBeTruthy();
  });

  it("writes coordination records for each Rust-visible mutation", async () => {
    const event: RunEvent = {
      type: "TaskSubmitted",
      phaseId: "phase_00",
      details: {},
      createdAt: "2026-04-20T00:00:00.000Z",
    };

    await store.appendEvent("run-hs-1", event);
    await store.saveTicketLedger({ runId: "run-hs-1", ticketLedger: [] });
    await store.savePhaseLedger({ runId: "run-hs-1", phaseLedger: [] });
    await store.saveRunsIndex({
      entry: {
        runId: "run-hs-1",
        featureRequest: "hi",
        state: "COMPLETE",
        startedAt: "2026-04-20T00:00:00.000Z",
        updatedAt: "2026-04-20T00:00:00.000Z",
        completedAt: "2026-04-20T00:00:00.000Z",
        channelId: null,
        phaseLedgerPath: "/tmp/phase-ledger.json",
        artifactsRoot: "/tmp",
      },
    });

    const ids = new Set(fake.mutateCalls.map((c) => c.id));
    expect(ids.has("run-hs-1__events")).toBe(true);
    expect(ids.has("run-hs-1__ticket-ledger")).toBe(true);
    expect(ids.has("run-hs-1__phase-ledger")).toBe(true);
    expect(ids.has("runs-index__runs-index")).toBe(true);
  });

  it("keeps Rust-visible run artifacts on disk (not under run-artifacts/)", async () => {
    await store.saveRunSnapshot(buildTestRun());
    await store.saveTicketLedger({ runId: "run-hs-1", ticketLedger: [] });
    await store.savePhaseLedger({ runId: "run-hs-1", phaseLedger: [] });

    // The data itself is on disk at the Rust-compat paths.
    await expect(stat(join(artifactsDir, "run-hs-1", "run.json"))).resolves.toBeTruthy();
    await expect(stat(join(artifactsDir, "run-hs-1", "ticket-ledger.json"))).resolves.toBeTruthy();
    await expect(stat(join(artifactsDir, "run-hs-1", "phase-ledger.json"))).resolves.toBeTruthy();

    // The HarnessStore's runArtifacts ns must NOT have picked up a doc mirror
    // for the Rust-visible payloads — only the coordination record.
    const snapshotDoc = await fake.getDoc(STORE_NS.runArtifacts, "run-hs-1");
    expect(snapshotDoc).toBeNull();
  });

  it("defaults to a real FileHarnessStore when no store is injected", async () => {
    // Smoke test: no store arg → ctor builds one via `buildHarnessStore()`.
    // Construction is lazy but must not throw.
    const defaulted = new LocalArtifactStore(artifactsDir);
    expect(defaulted).toBeInstanceOf(LocalArtifactStore);
  });
});

describe("LocalArtifactStore reads legacy Rust-layout fixtures", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "as-legacy-"));
    const src = fileURLToPath(new URL("./fixtures/legacy-artifacts", import.meta.url));
    await cp(src, workDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("reads pre-migration run.json, events.jsonl, and ledgers", async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), "as-legacy-hs-"));
    try {
      const store = new LocalArtifactStore(workDir, new FileHarnessStore(storeRoot));

      const snapshot = await store.readRunSnapshot("run-legacy-1");
      expect(snapshot).not.toBeNull();
      expect(snapshot!.runId).toBe("run-legacy-1");
      expect(snapshot!.featureRequest).toBe("Legacy feature");
      expect(snapshot!.state).toBe("COMPLETE");

      const events = await store.readEventLog("run-legacy-1");
      expect(events).toHaveLength(2);
      expect(events[0].type).toBe("TaskSubmitted");
      expect(events[1].type).toBe("ClassificationComplete");

      const tickets = await store.readTicketLedger("run-legacy-1");
      expect(tickets).not.toBeNull();
      expect(tickets!.map((t) => t.ticketId)).toEqual(["ticket-legacy-1"]);

      const runs = await store.readRunsIndex();
      expect(runs).toHaveLength(1);
      expect(runs[0].runId).toBe("run-legacy-1");

      const lifecycle = await store.readPrLifecycle("run-legacy-1");
      expect(lifecycle).not.toBeNull();
      expect(lifecycle!.currentStage).toBe("merged");
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  it("reads a pre-migration command-result artifact via its absolute path", async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), "as-legacy-cmd-hs-"));
    try {
      const store = new LocalArtifactStore(workDir, new FileHarnessStore(storeRoot));

      // Pre-T-103 artifacts were loose JSON files under
      // `<runId>/<phaseId>/<artifactId>.json` — the fallback path in
      // `readCommandResult` must still resolve them.
      const path = join(workDir, "run-legacy-1", "phase_01", "artifact-legacy-1.json");
      const content = await store.readCommandResult(path);
      expect(content.command).toBe("pnpm test");
      expect(content.exitCode).toBe(0);
      expect(content.stdout).toContain("legacy stdout");
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
    }
  });
});

describe("LocalArtifactStore error handling (malformed URIs & missing legacy paths)", () => {
  let artifactsDir: string;
  let fake: FakeHarnessStore;
  let store: LocalArtifactStore;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    artifactsDir = await mkdtemp(join(tmpdir(), "as-err-"));
    fake = new FakeHarnessStore();
    store = new LocalArtifactStore(artifactsDir, fake);
    // Silence the legacy-path warn so test output stays clean; tests that
    // care about the warning message assert against the spy explicitly.
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    warnSpy.mockRestore();
    await rm(artifactsDir, { recursive: true, force: true });
  });

  it("throws on a blob:// URI missing a slash", async () => {
    await expect(store.readCommandResult("blob://run-artifacts")).rejects.toThrow(
      /Invalid blob URI.*blob:\/\/run-artifacts/
    );
  });

  it("throws on a blob:// URI with an empty namespace", async () => {
    await expect(store.readCommandResult("blob:///abc")).rejects.toThrow(
      /Invalid blob URI.*empty namespace/
    );
  });

  it("throws on a blob:// URI with an empty id", async () => {
    await expect(store.readCommandResult("blob://run-artifacts/")).rejects.toThrow(
      /Invalid blob URI.*empty id/
    );
  });

  it("throws on a malformed blob:// URI passed to readFailureClassification", async () => {
    await expect(store.readFailureClassification("blob://bogus")).rejects.toThrow(
      /Invalid blob URI.*blob:\/\/bogus/
    );
  });

  it("wraps ENOENT on a legacy absolute path with contextual error", async () => {
    const missing = join(artifactsDir, "run-x", "phase_01", "missing.json");
    await expect(store.readCommandResult(missing)).rejects.toThrow(
      /Artifact not found at .*missing\.json.*legacy absolute-path fallback/
    );
  });

  it("warns once per distinct legacy path (but still reads the artifact)", async () => {
    // Seed a legacy artifact that can actually be read back so the call
    // resolves normally; we only care that the warn was triggered.
    const legacyDir = join(artifactsDir, "run-warn-1", "phase_00");
    await mkdir(legacyDir, { recursive: true });
    const legacyPath = join(legacyDir, "artifact-warn-1.json");
    await writeFile(
      legacyPath,
      JSON.stringify({
        artifactId: "artifact-warn-1",
        phaseId: "phase_00",
        command: "pnpm run x",
        cwd: "/tmp",
        exitCode: 0,
        stdout: "",
        stderr: "",
        capturedAt: "2026-04-20T00:00:00.000Z",
      })
    );

    await store.readCommandResult(legacyPath);
    await store.readCommandResult(legacyPath);
    const legacyCalls = warnSpy.mock.calls.filter((args) =>
      String(args[0]).includes("legacy absolute-path fallback")
    );
    expect(legacyCalls).toHaveLength(1);
  });

  it("throws (not silent null) on corrupt runs-index.json", async () => {
    await writeFile(join(artifactsDir, "runs-index.json"), "not json at all");
    await expect(store.readRunsIndex()).rejects.toThrow(
      /Failed to parse runs index at .*runs-index\.json/
    );
  });

  it("throws (not silent null) on corrupt run.json snapshot", async () => {
    await mkdir(join(artifactsDir, "run-bad"), { recursive: true });
    await writeFile(join(artifactsDir, "run-bad", "run.json"), "{broken");
    await expect(store.readRunSnapshot("run-bad")).rejects.toThrow(
      /Failed to parse run snapshot at .*run\.json/
    );
  });

  it("throws (not silent empty) on corrupt events.jsonl", async () => {
    await mkdir(join(artifactsDir, "run-bad-events"), { recursive: true });
    await writeFile(join(artifactsDir, "run-bad-events", "events.jsonl"), "{not json}\n");
    await expect(store.readEventLog("run-bad-events")).rejects.toThrow(
      /Failed to parse event log at .*events\.jsonl/
    );
  });

  it("throws (not silent null) on corrupt pr-lifecycle.json", async () => {
    await mkdir(join(artifactsDir, "run-bad-pr"), { recursive: true });
    await writeFile(join(artifactsDir, "run-bad-pr", "pr-lifecycle.json"), "nope");
    await expect(store.readPrLifecycle("run-bad-pr")).rejects.toThrow(
      /Failed to parse PR lifecycle at .*pr-lifecycle\.json/
    );
  });

  it("throws (not silent null) on corrupt ticket-ledger.json", async () => {
    await mkdir(join(artifactsDir, "run-bad-tickets"), { recursive: true });
    await writeFile(join(artifactsDir, "run-bad-tickets", "ticket-ledger.json"), "still not json");
    await expect(store.readTicketLedger("run-bad-tickets")).rejects.toThrow(
      /Failed to parse ticket ledger at .*ticket-ledger\.json/
    );
  });

  it("still returns [] for missing runs-index and null for missing snapshot/ledger/lifecycle", async () => {
    // ENOENT path must remain the original sentinel-return behavior; only
    // non-ENOENT errors are expected to throw.
    expect(await store.readRunsIndex()).toEqual([]);
    expect(await store.readRunSnapshot("run-nope")).toBeNull();
    expect(await store.readEventLog("run-nope")).toEqual([]);
    expect(await store.readPrLifecycle("run-nope")).toBeNull();
    expect(await store.readTicketLedger("run-nope")).toBeNull();
  });
});

describe("LocalArtifactStore blob round-trip (saveCommandResult -> readCommandResult)", () => {
  let artifactsDir: string;
  let fake: FakeHarnessStore;
  let store: LocalArtifactStore;

  beforeEach(async () => {
    artifactsDir = await mkdtemp(join(tmpdir(), "as-rt-"));
    fake = new FakeHarnessStore();
    store = new LocalArtifactStore(artifactsDir, fake);
  });

  afterEach(async () => {
    await rm(artifactsDir, { recursive: true, force: true });
  });

  it("writes a blob under the right ns/id and round-trips the exact bytes", async () => {
    const record = await store.saveCommandResult({
      runId: "run-rt-1",
      phaseId: "phase_07",
      command: "pnpm run build",
      result: { exitCode: 1, stdout: "line one\nline two", stderr: "boom" },
      cwd: "/work",
    });

    // The returned path is a blob URI with the expected ns prefix.
    expect(record.path).toMatch(/^blob:\/\/run-artifacts\/run-rt-1__phase_07__artifact-/);

    // Exactly one putBlob call landed under the run-artifacts ns.
    expect(fake.blobCalls).toHaveLength(1);
    expect(fake.blobCalls[0].ns).toBe(STORE_NS.runArtifacts);
    expect(fake.blobCalls[0].id).toMatch(/^run-rt-1__phase_07__artifact-/);

    // Round-trip recovers the original fields verbatim.
    const read = await store.readCommandResult(record.path);
    expect(read.command).toBe("pnpm run build");
    expect(read.cwd).toBe("/work");
    expect(read.exitCode).toBe(1);
    expect(read.stdout).toBe("line one\nline two");
    expect(read.stderr).toBe("boom");
    expect(read.phaseId).toBe("phase_07");
  });
});

describe("LocalArtifactStore PR lifecycle coordination record", () => {
  it("writes a coordination record through HarnessStore.mutate when savePrLifecycle runs", async () => {
    const artifactsDir = await mkdtemp(join(tmpdir(), "as-pr-coord-"));
    const fake = new FakeHarnessStore();
    const store = new LocalArtifactStore(artifactsDir, fake);

    try {
      const lifecycle = createPrLifecycle({
        runId: "run-pr-coord-1",
        branch: "feature/x",
      });
      await store.savePrLifecycle(lifecycle);

      expect(fake.mutateCalls).toContainEqual({
        ns: STORE_NS.runArtifacts,
        id: "run-pr-coord-1__pr-lifecycle",
      });
      const coord = await fake.getDoc<{ kind: string }>(
        STORE_NS.runArtifacts,
        "run-pr-coord-1__pr-lifecycle"
      );
      expect(coord).not.toBeNull();
      expect(coord!.kind).toBe("pr-lifecycle");
    } finally {
      await rm(artifactsDir, { recursive: true, force: true });
    }
  });
});
