import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { LocalArtifactStore } from "../src/execution/artifact-store.js";
import { FileHarnessStore } from "../src/storage/file-store.js";

describe("phase ledger persistence", () => {
  it("writes a compact phase ledger per run", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "relay-ledger-"));
    const storeRoot = await mkdtemp(join(tmpdir(), "relay-ledger-hs-"));
    const store = new LocalArtifactStore(artifactRoot, new FileHarnessStore(storeRoot));

    try {
      const path = await store.savePhaseLedger({
        runId: "run-1",
        phaseLedger: [
          {
            phaseId: "phase_01",
            title: "Build UI shell",
            specialty: "ui",
            lifecycle: "implementing",
            verification: "failed_recoverable",
            lastClassification: {
              category: "fix_test",
              rationale: "The failure is isolated to verification setup.",
              nextAction: "Repair the tests before changing product logic."
            },
            chosenNextAction: "Repair the tests before changing product logic.",
            updatedAt: "2026-03-30T00:00:00.000Z"
          }
        ]
      });

      expect(path).toContain("phase-ledger.json");
      const file = JSON.parse(await readFile(path, "utf8")) as {
        runId: string;
        phases: Array<{
          phaseId: string;
          verification: string;
          chosenNextAction: string;
        }>;
      };

      expect(file.runId).toBe("run-1");
      expect(file.phases[0]?.phaseId).toBe("phase_01");
      expect(file.phases[0]?.verification).toBe("failed_recoverable");
      expect(file.phases[0]?.chosenNextAction).toContain("Repair the tests");
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
