import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { LocalArtifactStore } from "../src/execution/artifact-store.js";
import type { HarnessRun, RunEvent } from "../src/domain/run.js";

function buildTestRun(overrides?: Partial<HarnessRun>): HarnessRun {
  const now = new Date().toISOString();

  return {
    id: "run-test-1",
    featureRequest: "Add a widget",
    state: "PHASE_EXECUTE",
    startedAt: now,
    updatedAt: now,
    completedAt: null,
    plan: null,
    events: [
      {
        type: "TaskSubmitted",
        phaseId: "phase_00",
        details: { featureRequest: "Add a widget" },
        createdAt: now
      }
    ],
    evidence: [],
    artifacts: [],
    phaseLedger: [],
    phaseLedgerPath: null,
    runIndexPath: null,
    ...overrides
  };
}

describe("run persistence", () => {
  it("saves and reads a full run snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "run-persist-"));
    const store = new LocalArtifactStore(root);

    try {
      const run = buildTestRun();
      const path = await store.saveRunSnapshot(run);

      expect(path).toContain("run-test-1/run.json");

      const snapshot = await store.readRunSnapshot("run-test-1");

      expect(snapshot).not.toBeNull();
      expect(snapshot!.runId).toBe("run-test-1");
      expect(snapshot!.featureRequest).toBe("Add a widget");
      expect(snapshot!.state).toBe("PHASE_EXECUTE");
      expect(snapshot!.eventCount).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns null for missing run snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "run-persist-"));
    const store = new LocalArtifactStore(root);

    try {
      const snapshot = await store.readRunSnapshot("nonexistent-run");
      expect(snapshot).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("appends and reads events from jsonl log", async () => {
    const root = await mkdtemp(join(tmpdir(), "run-persist-"));
    const store = new LocalArtifactStore(root);

    try {
      const event1: RunEvent = {
        type: "TaskSubmitted",
        phaseId: "phase_00",
        details: { featureRequest: "Test" },
        createdAt: new Date().toISOString()
      };

      const event2: RunEvent = {
        type: "PlanGenerated",
        phaseId: "phase_00",
        details: { state: "PLAN_REVIEW" },
        createdAt: new Date().toISOString()
      };

      await store.appendEvent("run-events-1", event1);
      await store.appendEvent("run-events-1", event2);

      const events = await store.readEventLog("run-events-1");

      expect(events).toHaveLength(2);
      expect(events[0].type).toBe("TaskSubmitted");
      expect(events[1].type).toBe("PlanGenerated");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns empty array for missing event log", async () => {
    const root = await mkdtemp(join(tmpdir(), "run-persist-"));
    const store = new LocalArtifactStore(root);

    try {
      const events = await store.readEventLog("nonexistent");
      expect(events).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
