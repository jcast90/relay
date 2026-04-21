import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createPrLifecycle,
  advancePrStage,
  canTransition
} from "../src/domain/pr-lifecycle.js";
import { LocalArtifactStore } from "../src/execution/artifact-store.js";
import { FileHarnessStore } from "../src/storage/file-store.js";

describe("PR lifecycle domain", () => {
  it("creates a lifecycle in branch_created stage", () => {
    const lifecycle = createPrLifecycle({
      runId: "run-1",
      branch: "feature/widget"
    });

    expect(lifecycle.runId).toBe("run-1");
    expect(lifecycle.branch).toBe("feature/widget");
    expect(lifecycle.baseBranch).toBe("main");
    expect(lifecycle.currentStage).toBe("branch_created");
    expect(lifecycle.prNumber).toBeNull();
    expect(lifecycle.events).toHaveLength(1);
    expect(lifecycle.events[0].stage).toBe("branch_created");
  });

  it("advances through stages and records events", () => {
    let lifecycle = createPrLifecycle({
      runId: "run-1",
      branch: "feature/widget"
    });

    lifecycle = advancePrStage(lifecycle, "commits_pushed");
    expect(lifecycle.currentStage).toBe("commits_pushed");
    expect(lifecycle.events).toHaveLength(2);

    lifecycle = advancePrStage(lifecycle, "pr_opened", {
      prNumber: "42",
      prUrl: "https://github.com/org/repo/pull/42"
    });
    expect(lifecycle.currentStage).toBe("pr_opened");
    expect(lifecycle.prNumber).toBe(42);
    expect(lifecycle.prUrl).toBe("https://github.com/org/repo/pull/42");
    expect(lifecycle.events).toHaveLength(3);
  });

  it("validates transition rules", () => {
    expect(canTransition("branch_created", "commits_pushed")).toBe(true);
    expect(canTransition("branch_created", "merged")).toBe(false);
    expect(canTransition("pr_opened", "checks_running")).toBe(true);
    expect(canTransition("checks_passed", "merged")).toBe(true);
    expect(canTransition("merged", "closed")).toBe(false);
    expect(canTransition("approved", "merged")).toBe(true);
  });
});

describe("PR lifecycle persistence", () => {
  it("saves and reads PR lifecycle from disk", async () => {
    const root = await mkdtemp(join(tmpdir(), "pr-lifecycle-"));
    const storeRoot = await mkdtemp(join(tmpdir(), "pr-lifecycle-hs-"));
    const store = new LocalArtifactStore(root, new FileHarnessStore(storeRoot));

    try {
      const lifecycle = createPrLifecycle({
        runId: "run-pr-1",
        branch: "feature/test",
        baseBranch: "develop"
      });

      const path = await store.savePrLifecycle(lifecycle);
      expect(path).toContain("run-pr-1/pr-lifecycle.json");

      const read = await store.readPrLifecycle("run-pr-1");
      expect(read).not.toBeNull();
      expect(read!.branch).toBe("feature/test");
      expect(read!.baseBranch).toBe("develop");
      expect(read!.currentStage).toBe("branch_created");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  it("returns null for missing PR lifecycle", async () => {
    const root = await mkdtemp(join(tmpdir(), "pr-lifecycle-"));
    const storeRoot = await mkdtemp(join(tmpdir(), "pr-lifecycle-hs-"));
    const store = new LocalArtifactStore(root, new FileHarnessStore(storeRoot));

    try {
      const result = await store.readPrLifecycle("nonexistent");
      expect(result).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(storeRoot, { recursive: true, force: true });
    }
  });
});
