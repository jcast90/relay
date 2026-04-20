import { execFile } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { getRelayDir } from "../../cli/paths.js";
import type {
  RepoRef,
  SandboxProvider,
  SandboxRef
} from "../sandbox.js";

// argv-based runner (no shell) keeps repo paths safe from shell expansion.
const runGitChild = promisify(execFile);

export interface RunGitResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Shell runner for git invocations. The default spawns git as a child
 * process with argv (no shell). Tests inject a mock so the provider is
 * unit-testable without a real git repo on disk.
 */
export type RunGit = (
  args: string[],
  cwd: string
) => Promise<RunGitResult>;

export interface GitWorktreeSandboxOptions {
  /** Parent dir holding all sandboxes for this harness. */
  baseDir?: string;
  /** Shell runner for git. Default spawns a child process; tests inject a mock. */
  runGit?: RunGit;
}

export interface GitWorktreeStateFile {
  runId: string;
  ticketId: string;
  createdAt: string;
  base: string;
  branch: string;
}

export interface CreateOptions {
  runId: string;
  ticketId: string;
}

export interface DestroyOptions {
  force?: boolean;
}

// Matches stderr emitted by `git worktree remove` when the worktree has
// uncommitted changes — we read these fragments to decide whether to preserve
// the worktree for crash-recovery inspection instead of deleting work.
const DIRTY_STDERR_FRAGMENTS = [
  "contains modified or untracked files",
  "is dirty",
  "has modifications",
  "use --force to delete it"
];

const defaultRunGit: RunGit = async (args, cwd) => {
  try {
    const { stdout, stderr } = await runGitChild("git", args, { cwd });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
    };
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? String(err),
      code: typeof e.code === "number" ? e.code : 1
    };
  }
};

/**
 * SandboxProvider backed by `git worktree`. One worktree per active ticket,
 * keyed by (runId, ticketId), rooted at a configurable base dir.
 *
 * Branch naming `sandbox/<runId>/<ticketId>` makes `git worktree list` readable
 * at a glance — operators can trace each checkout back to its owning run and
 * ticket without cross-referencing state files.
 *
 * The provider writes a `.relay-state.json` stamp inside each worktree so a
 * future crash-recovery scan can identify orphaned sandboxes (e.g. after the
 * harness exits without a graceful `destroy`).
 */
export class GitWorktreeSandboxProvider implements SandboxProvider {
  private readonly baseDir: string;
  private readonly runGit: RunGit;
  private readonly ownerRepo = new Map<string, string>();

  constructor(options: GitWorktreeSandboxOptions = {}) {
    this.baseDir = options.baseDir ?? join(getRelayDir(), "sandboxes");
    this.runGit = options.runGit ?? defaultRunGit;
  }

  /**
   * Create a fresh worktree for `(runId, ticketId)` branched from `base`.
   *
   * The caller owns the lifecycle. If `destroy` is never called (e.g. harness
   * crash), the worktree and its `.relay-state.json` remain on disk for T-203
   * recovery — deletion is never implicit.
   */
  async create(
    repo: RepoRef,
    base: string,
    options?: CreateOptions
  ): Promise<SandboxRef> {
    const { runId, ticketId } = requireIds(options);

    const sandboxPath = join(this.baseDir, `run-${runId}`, ticketId);
    const branch = `sandbox/${runId}/${ticketId}`;
    const id = `runtime-${runId}-${ticketId}`;

    await mkdir(dirname(sandboxPath), { recursive: true });

    const result = await this.runGit(
      ["worktree", "add", "-b", branch, sandboxPath, base],
      repo.root
    );

    if (result.code !== 0) {
      throw new Error(
        `git worktree add failed for ${branch} at ${sandboxPath}: ${result.stderr.trim() || "unknown error"}`
      );
    }

    const state: GitWorktreeStateFile = {
      runId,
      ticketId,
      createdAt: new Date().toISOString(),
      base,
      branch
    };

    await writeFile(
      join(sandboxPath, ".relay-state.json"),
      `${JSON.stringify(state, null, 2)}\n`,
      "utf8"
    );

    this.ownerRepo.set(id, repo.root);

    return {
      id,
      workdir: { kind: "local", path: sandboxPath },
      meta: { branch, base, runId, ticketId }
    };
  }

  /**
   * Remove a worktree. Idempotent: a missing path is a silent no-op.
   *
   * When `git worktree remove` reports uncommitted changes, the worktree is
   * preserved (we do NOT add `--force` implicitly). This lets T-203 crash
   * recovery inspect stale sandboxes without destroying unflushed work.
   * Pass `{ force: true }` to force deletion.
   */
  async destroy(ref: SandboxRef, opts: DestroyOptions = {}): Promise<void> {
    if (ref.workdir.kind !== "local") {
      return;
    }

    const path = ref.workdir.path;

    if (!(await pathExists(path))) {
      // Missing path — nothing to remove. Logged at debug only so normal
      // re-entrancy (retry / resume) doesn't spam the console.
      // eslint-disable-next-line no-console
      console.debug?.(`[git-worktree] destroy: path ${path} missing, no-op`);
      return;
    }

    const cwd = this.ownerRepo.get(ref.id) ?? ref.meta?.repoRoot;
    if (!cwd) {
      // Without the origin repo we cannot run `git worktree remove`. This
      // should only happen on a ref from a different provider instance; leave
      // the worktree in place for manual / T-203 cleanup.
      return;
    }

    const args = ["worktree", "remove"];
    if (opts.force) args.push("--force");
    args.push(path);

    const result = await this.runGit(args, cwd);

    if (result.code === 0) {
      this.ownerRepo.delete(ref.id);
      return;
    }

    if (!opts.force && isDirtyWorktreeError(result.stderr)) {
      // Preserve on-disk state so recovery tooling (T-203) can inspect the
      // dirty worktree and decide manually. This is the key safety property.
      return;
    }

    throw new Error(
      `git worktree remove failed for ${path}: ${result.stderr.trim() || "unknown error"}`
    );
  }
}

function requireIds(options: CreateOptions | undefined): CreateOptions {
  if (!options?.runId || !options.ticketId) {
    throw new Error(
      "GitWorktreeSandboxProvider.create requires { runId, ticketId }"
    );
  }
  return options;
}

function isDirtyWorktreeError(stderr: string): boolean {
  const lower = stderr.toLowerCase();
  return DIRTY_STDERR_FRAGMENTS.some((f) => lower.includes(f));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
