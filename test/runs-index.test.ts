import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { LocalArtifactStore } from "../src/execution/artifact-store.js";

describe("runs index", () => {
  it("persists recent runs with jump targets", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "agent-harness-runs-index-"));
    const store = new LocalArtifactStore(artifactRoot);

    try {
      const firstPath = await store.saveRunsIndex({
        entry: {
          runId: "run-1",
          featureRequest: "First feature",
          state: "COMPLETE",
          startedAt: "2026-03-30T00:00:00.000Z",
          updatedAt: "2026-03-30T00:01:00.000Z",
          completedAt: "2026-03-30T00:01:00.000Z",
          phaseLedgerPath: "/tmp/run-1/phase-ledger.json",
          artifactsRoot: "/tmp/run-1"
        }
      });

      await store.saveRunsIndex({
        entry: {
          runId: "run-2",
          featureRequest: "Second feature",
          state: "FAILED",
          startedAt: "2026-03-30T00:02:00.000Z",
          updatedAt: "2026-03-30T00:03:00.000Z",
          completedAt: "2026-03-30T00:03:00.000Z",
          phaseLedgerPath: "/tmp/run-2/phase-ledger.json",
          artifactsRoot: "/tmp/run-2"
        }
      });

      const entries = await store.readRunsIndex();

      expect(firstPath).toContain("runs-index.json");
      expect(entries).toHaveLength(2);
      expect(entries[0]?.runId).toBe("run-2");
      expect(entries[0]?.phaseLedgerPath).toContain("phase-ledger.json");
      expect(entries[1]?.runId).toBe("run-1");
    } finally {
      await rm(artifactRoot, {
        recursive: true,
        force: true
      });
    }
  });
});
