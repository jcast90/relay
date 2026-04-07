import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildWorkspaceId,
  getWorkspaceDir,
  readRegistry,
  registerWorkspace,
  resolveWorkspaceForRepo,
  writeRegistry
} from "../src/cli/workspace-registry.js";

describe("workspace registry", () => {
  it("generates deterministic workspace IDs from repo paths", () => {
    const id1 = buildWorkspaceId("/home/user/projects/my-repo");
    const id2 = buildWorkspaceId("/home/user/projects/my-repo");
    const id3 = buildWorkspaceId("/home/user/projects/other-repo");

    expect(id1).toBe(id2);
    expect(id1).not.toBe(id3);
    expect(id1).toContain("my-repo-");
    expect(id3).toContain("other-repo-");
  });

  it("workspace dir is under global root", () => {
    const dir = getWorkspaceDir("my-repo-abc123");
    expect(dir).toContain(".agent-harness/workspaces/my-repo-abc123");
  });

  it("registers and resolves workspaces via file-backed registry", async () => {
    // This test writes to the real global registry, so we use unique paths
    const fakePath = join(
      await mkdtemp(join(tmpdir(), "ws-reg-test-")),
      "fake-repo"
    );

    try {
      const entry = await registerWorkspace(fakePath);

      expect(entry.workspaceId).toBe(buildWorkspaceId(fakePath));
      expect(entry.repoPath).toBe(fakePath);

      const resolved = await resolveWorkspaceForRepo(fakePath);
      expect(resolved).not.toBeNull();
      expect(resolved!.workspaceId).toBe(entry.workspaceId);

      // Re-registering updates lastAccessedAt
      const updated = await registerWorkspace(fakePath);
      expect(updated.workspaceId).toBe(entry.workspaceId);
      expect(updated.lastAccessedAt >= entry.lastAccessedAt).toBe(true);

      // Unregistered path returns null
      const missing = await resolveWorkspaceForRepo("/nonexistent/path");
      expect(missing).toBeNull();
    } finally {
      // Clean up: remove our test entry from the global registry
      const registry = await readRegistry();
      registry.workspaces = registry.workspaces.filter(
        (w) => w.repoPath !== fakePath
      );
      await writeRegistry(registry);
      await rm(fakePath, { recursive: true, force: true }).catch(() => {});
    }
  });
});
