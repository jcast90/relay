import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { LocalArtifactStore } from "../src/execution/artifact-store.js";
import { FileHarnessStore } from "../src/storage/file-store.js";

describe("artifact store", () => {
  it("persists and reads failure classification artifacts", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "relay-artifacts-"));
    const storeRoot = await mkdtemp(join(tmpdir(), "relay-artifacts-hs-"));
    const store = new LocalArtifactStore(artifactRoot, new FileHarnessStore(storeRoot));

    try {
      const artifact = await store.saveFailureClassification({
        runId: "run-1",
        phaseId: "phase-1",
        classification: {
          category: "fix_test",
          rationale: "The failure is isolated to verification setup.",
          nextAction: "Repair the tests before changing product logic."
        }
      });
      const content = await store.readFailureClassification(artifact.path);

      expect(artifact.type).toBe("failure_classification");
      if (artifact.type !== "failure_classification") {
        throw new Error("Expected failure classification artifact.");
      }

      expect(artifact.category).toBe("fix_test");
      expect(content.rationale).toContain("verification setup");
      expect(content.nextAction).toContain("Repair the tests");
    } finally {
      await rm(artifactRoot, {
        recursive: true,
        force: true
      });
      await rm(storeRoot, {
        recursive: true,
        force: true
      });
    }
  });
});
