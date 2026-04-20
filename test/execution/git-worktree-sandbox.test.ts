import { execFile as execFileCb } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import type { RepoRef } from "../../src/execution/sandbox.js";
import { resolveLocalPath } from "../../src/execution/sandbox.js";
import {
  GitWorktreeSandboxProvider,
  type RunGit,
  type RunGitResult
} from "../../src/execution/sandboxes/git-worktree.js";

const runRealGit = promisify(execFileCb);

interface RecordedCall {
  args: string[];
  cwd: string;
}

// Mocked runGit: mirrors the side effects a real `git worktree add` would
// produce on the filesystem (creating the target dir) so the provider's
// subsequent `.relay-state.json` write lands on a real path.
function makeRecordingRunGit(
  responder: (call: RecordedCall) => RunGitResult | Promise<RunGitResult> = () => ({
    stdout: "",
    stderr: "",
    code: 0
  })
): { runGit: RunGit; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const runGit: RunGit = async (args, cwd) => {
    calls.push({ args, cwd });
    const result = await responder({ args, cwd });
    if (
      result.code === 0 &&
      args[0] === "worktree" &&
      args[1] === "add"
    ) {
      // `-b <branch> <path> <base>` — the path is the 4th positional arg.
      const path = args[4];
      if (path) {
        await mkdir(path, { recursive: true });
      }
    }
    if (
      result.code === 0 &&
      args[0] === "worktree" &&
      args[1] === "remove"
    ) {
      const path = args[args.length - 1];
      if (path) {
        await rm(path, { recursive: true, force: true });
      }
    }
    return result;
  };
  return { runGit, calls };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

const repo: RepoRef = { root: "/tmp/fake-repo" };

describe("GitWorktreeSandboxProvider.create", () => {
  it("invokes git worktree add with the expected args", async () => {
    const { runGit, calls } = makeRecordingRunGit();
    const baseDir = "/tmp/relay-sandboxes-unit";
    const provider = new GitWorktreeSandboxProvider({ baseDir, runGit });

    const ref = await provider.create(repo, "main", {
      runId: "run-abc",
      ticketId: "T-042"
    });

    expect(calls).toHaveLength(1);
    const expectedPath = join(baseDir, "run-run-abc", "T-042");
    expect(calls[0]).toEqual({
      args: [
        "worktree",
        "add",
        "-b",
        "sandbox/run-abc/T-042",
        expectedPath,
        "main"
      ],
      cwd: repo.root
    });

    expect(ref.id).toBe("runtime-run-abc-T-042");
    expect(ref.workdir.kind).toBe("local");
    expect(resolveLocalPath(ref)).toBe(expectedPath);
    expect(ref.meta?.branch).toBe("sandbox/run-abc/T-042");
    expect(ref.meta?.base).toBe("main");
    expect(ref.meta?.runId).toBe("run-abc");
    expect(ref.meta?.ticketId).toBe("T-042");

    await rm(baseDir, { recursive: true, force: true });
  });

  it("writes .relay-state.json with the expected shape", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "relay-gwt-state-"));
    const { runGit } = makeRecordingRunGit();
    const provider = new GitWorktreeSandboxProvider({ baseDir, runGit });

    const ref = await provider.create(repo, "develop", {
      runId: "run-xyz",
      ticketId: "T-007"
    });

    const statePath = join(
      resolveLocalPath(ref) ?? "/missing",
      ".relay-state.json"
    );
    const raw = JSON.parse(await readFile(statePath, "utf8"));

    expect(raw).toMatchObject({
      runId: "run-xyz",
      ticketId: "T-007",
      base: "develop",
      branch: "sandbox/run-xyz/T-007"
    });
    expect(typeof raw.createdAt).toBe("string");
    expect(Number.isNaN(Date.parse(raw.createdAt))).toBe(false);

    await rm(baseDir, { recursive: true, force: true });
  });

  it("returns a ref with workdir.kind=local and expected meta.branch", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "relay-gwt-ref-"));
    const { runGit } = makeRecordingRunGit();
    const provider = new GitWorktreeSandboxProvider({ baseDir, runGit });

    const ref = await provider.create(repo, "main", {
      runId: "r1",
      ticketId: "T-1"
    });

    expect(ref.workdir).toEqual({
      kind: "local",
      path: join(baseDir, "run-r1", "T-1")
    });
    expect(ref.meta?.branch).toBe("sandbox/r1/T-1");

    await rm(baseDir, { recursive: true, force: true });
  });

  it("throws with descriptive error when git worktree add fails", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "relay-gwt-fail-"));
    const { runGit } = makeRecordingRunGit(() => ({
      stdout: "",
      stderr: "fatal: invalid reference: nope",
      code: 128
    }));
    const provider = new GitWorktreeSandboxProvider({ baseDir, runGit });

    await expect(
      provider.create(repo, "nope", { runId: "r", ticketId: "T" })
    ).rejects.toThrow(/invalid reference/);

    await rm(baseDir, { recursive: true, force: true });
  });

  it("yields distinct paths and refs for two concurrent creates", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "relay-gwt-conc-"));
    const { runGit } = makeRecordingRunGit();
    const provider = new GitWorktreeSandboxProvider({ baseDir, runGit });

    const [a, b] = await Promise.all([
      provider.create(repo, "main", { runId: "run-a", ticketId: "T-1" }),
      provider.create(repo, "main", { runId: "run-b", ticketId: "T-2" })
    ]);

    expect(a.id).not.toBe(b.id);
    expect(resolveLocalPath(a)).not.toBe(resolveLocalPath(b));
    expect(resolveLocalPath(a)).toBe(join(baseDir, "run-run-a", "T-1"));
    expect(resolveLocalPath(b)).toBe(join(baseDir, "run-run-b", "T-2"));

    await rm(baseDir, { recursive: true, force: true });
  });
});

describe("GitWorktreeSandboxProvider.destroy", () => {
  it("invokes git worktree remove without --force by default", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "relay-gwt-rm-"));
    const { runGit, calls } = makeRecordingRunGit();
    const provider = new GitWorktreeSandboxProvider({ baseDir, runGit });

    const ref = await provider.create(repo, "main", {
      runId: "r",
      ticketId: "T"
    });

    await provider.destroy(ref);

    const removeCall = calls.find((c) => c.args[1] === "remove");
    expect(removeCall).toBeDefined();
    expect(removeCall!.args).toEqual([
      "worktree",
      "remove",
      resolveLocalPath(ref)
    ]);
    expect(removeCall!.args).not.toContain("--force");
    expect(removeCall!.cwd).toBe(repo.root);

    await rm(baseDir, { recursive: true, force: true });
  });

  it("adds --force when destroy is called with { force: true }", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "relay-gwt-force-"));
    const { runGit, calls } = makeRecordingRunGit();
    const provider = new GitWorktreeSandboxProvider({ baseDir, runGit });

    const ref = await provider.create(repo, "main", {
      runId: "r",
      ticketId: "T"
    });

    await provider.destroy(ref, { force: true });

    const removeCall = calls.find((c) => c.args[1] === "remove");
    expect(removeCall).toBeDefined();
    expect(removeCall!.args).toEqual([
      "worktree",
      "remove",
      "--force",
      resolveLocalPath(ref)
    ]);

    await rm(baseDir, { recursive: true, force: true });
  });

  it("is idempotent when the worktree path does not exist", async () => {
    const { runGit, calls } = makeRecordingRunGit();
    const provider = new GitWorktreeSandboxProvider({
      baseDir: "/tmp/relay-gwt-missing-never-created",
      runGit
    });

    // Build a ref for a path that was never created on disk.
    const phantom = {
      id: "runtime-ghost-T-0",
      workdir: {
        kind: "local" as const,
        path: "/tmp/relay-gwt-missing-never-created/run-ghost/T-0"
      },
      meta: { branch: "sandbox/ghost/T-0" }
    };

    await expect(provider.destroy(phantom)).resolves.toBeUndefined();
    // No git invocation should happen when the path is missing.
    expect(calls).toHaveLength(0);
  });

  it("preserves the worktree when remove fails due to uncommitted changes", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "relay-gwt-dirty-"));
    let failNextRemove = false;

    const runGit: RunGit = async (args) => {
      if (args[0] === "worktree" && args[1] === "add") {
        const path = args[4];
        if (path) await mkdir(path, { recursive: true });
        return { stdout: "", stderr: "", code: 0 };
      }
      if (failNextRemove && args[1] === "remove") {
        return {
          stdout: "",
          stderr:
            "fatal: '...' contains modified or untracked files, use --force to delete it",
          code: 128
        };
      }
      return { stdout: "", stderr: "", code: 0 };
    };

    const provider = new GitWorktreeSandboxProvider({ baseDir, runGit });
    const ref = await provider.create(repo, "main", {
      runId: "r",
      ticketId: "T-dirty"
    });

    const path = resolveLocalPath(ref)!;
    expect(await exists(path)).toBe(true);

    failNextRemove = true;
    // The provider must NOT throw; it preserves the worktree.
    await expect(provider.destroy(ref)).resolves.toBeUndefined();

    // On-disk state intact for T-203 recovery.
    expect(await exists(path)).toBe(true);
    expect(await exists(join(path, ".relay-state.json"))).toBe(true);

    await rm(baseDir, { recursive: true, force: true });
  });

  it("rejects on a non-dirty, non-missing failure", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "relay-gwt-err-"));
    let phase: "add" | "remove" = "add";

    const runGit: RunGit = async (args) => {
      if (phase === "add") {
        const path = args[4];
        if (path) await mkdir(path, { recursive: true });
        return { stdout: "", stderr: "", code: 0 };
      }
      if (args[1] === "remove") {
        return {
          stdout: "",
          stderr: "fatal: catastrophic failure",
          code: 128
        };
      }
      return { stdout: "", stderr: "", code: 0 };
    };

    const provider = new GitWorktreeSandboxProvider({ baseDir, runGit });
    const ref = await provider.create(repo, "main", {
      runId: "r",
      ticketId: "T-err"
    });

    phase = "remove";
    await expect(provider.destroy(ref)).rejects.toThrow(
      /catastrophic failure/
    );

    await rm(baseDir, { recursive: true, force: true });
  });
});

// Integration test gated behind RELAY_TEST_REAL_GIT=1. Uses a real git repo in
// a temp dir so CI stays fast and hermetic by default.
const realGitSuite =
  process.env.RELAY_TEST_REAL_GIT === "1" ? describe : describe.skip;

realGitSuite("GitWorktreeSandboxProvider — real git integration", () => {
  it("creates and destroys a real worktree", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "relay-gwt-repo-"));
    const baseDir = await mkdtemp(join(tmpdir(), "relay-gwt-real-"));

    await runRealGit("git", ["init", "-b", "main"], { cwd: repoRoot });
    await runRealGit(
      "git",
      ["-c", "user.email=a@b.c", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"],
      { cwd: repoRoot }
    );

    const provider = new GitWorktreeSandboxProvider({ baseDir });
    const ref = await provider.create(
      { root: repoRoot },
      "main",
      { runId: "real", ticketId: "T-real" }
    );

    const path = resolveLocalPath(ref)!;
    expect(await exists(path)).toBe(true);
    expect(await exists(join(path, ".relay-state.json"))).toBe(true);

    await provider.destroy(ref);
    expect(await exists(path)).toBe(false);

    await rm(repoRoot, { recursive: true, force: true });
    await rm(baseDir, { recursive: true, force: true });
  });
});
