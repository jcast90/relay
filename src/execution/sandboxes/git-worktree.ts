import { execFile } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { getRelayDir } from "../../cli/paths.js";
import type { DestroyResult, RepoRef, SandboxProvider, SandboxRef } from "../sandbox.js";
export type { DestroyResult } from "../sandbox.js";

// argv-based runner (no shell) keeps repo paths safe from shell expansion.
const runGitChild = promisify(execFile);

export interface RunGitResult {
  stdout: string;
  stderr: string;
  code: number;
  /**
   * Set when the spawn itself fails (e.g. `git` isn't on PATH) rather than git
   * exiting non-zero. Callers can distinguish "git not found" (spawnCode
   * `ENOENT`) from "git exited 128" (plain `code: 128`). Preserved as a string
   * because Node's spawn errors surface string codes (ENOENT, EACCES, …),
   * not numeric ones.
   */
  spawnCode?: string;
}

/**
 * Shell runner for git invocations. The default spawns git as a child
 * process with argv (no shell). Tests inject a mock so the provider is
 * unit-testable without a real git repo on disk.
 */
export type RunGit = (args: string[], cwd: string) => Promise<RunGitResult>;

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
  "use --force to delete it",
];

/**
 * Reject path segments that could escape the sandbox base dir via traversal
 * (`..`), collapse to the parent (`.`), pierce a directory boundary (`/`,
 * `\`), trip the kernel's null-byte guard, or carry whitespace that could
 * confuse downstream argv handling.
 *
 * Intentionally duplicated (with a narrower `kind` type) from
 * {@link ../../storage/file-store.ts} — see the PR review: a tiny local copy
 * is preferable to extracting a shared helper during a review-response commit.
 */
function assertSafeSegment(segment: string, kind: "runId" | "ticketId"): void {
  if (
    segment === "" ||
    segment === "." ||
    segment === ".." ||
    segment.includes("/") ||
    segment.includes("\\") ||
    segment.includes("\0") ||
    /\s/.test(segment)
  ) {
    throw new Error(`Unsafe path segment in ${kind}: ${segment}`);
  }
}

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
    // Spawn-level errors (git missing, permission denied, …) surface as
    // string codes on the thrown error. Preserve them separately from the
    // process exit code so callers can distinguish "git not installed"
    // (spawnCode=ENOENT) from "git exited non-zero" (code=128).
    if (typeof e.code === "string") {
      return {
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? String(err),
        code: 1,
        spawnCode: e.code,
      };
    }
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? String(err),
      code: typeof e.code === "number" ? e.code : 1,
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
  async create(repo: RepoRef, base: string, options?: CreateOptions): Promise<SandboxRef> {
    if (!options) {
      throw new Error("GitWorktreeSandboxProvider.create requires { runId, ticketId }");
    }
    // Validate BEFORE the non-null coerce in requireIds — an empty string
    // should surface as "Unsafe path segment" (not as the lower-priority
    // "requires { runId, ticketId }" message) so callers get a uniform
    // signal for path-injection attempts regardless of the bad value.
    assertSafeSegment(options.runId ?? "", "runId");
    assertSafeSegment(options.ticketId ?? "", "ticketId");
    const { runId, ticketId } = requireIds(options);

    const sandboxPath = join(this.baseDir, `run-${runId}`, ticketId);
    const branch = `sandbox/${runId}/${ticketId}`;
    const id = `runtime-${runId}-${ticketId}`;

    await mkdir(dirname(sandboxPath), { recursive: true });

    // A pre-existing target path almost always means a resumed run or crash
    // recovery — conditions T-203 is meant to handle. Fail loudly with a
    // distinguishable error instead of letting `git worktree add` return a
    // generic "directory already exists" that's harder for callers to reason
    // about.
    if (await pathExists(sandboxPath)) {
      throw new Error(
        `Sandbox path ${sandboxPath} already exists (runId=${runId}, ticketId=${ticketId}); T-203 recovery should handle resume`
      );
    }

    const result = await this.runGit(
      ["worktree", "add", "-b", branch, sandboxPath, base],
      repo.root
    );

    if (result.code !== 0) {
      throw new Error(
        `git worktree add failed for ${branch} at ${sandboxPath} (exit ${result.code}): ${result.stderr.trim() || "unknown error"}${result.stdout ? ` | stdout: ${result.stdout.trim()}` : ""}${result.spawnCode ? ` | spawnCode: ${result.spawnCode}` : ""}`
      );
    }

    const state: GitWorktreeStateFile = {
      runId,
      ticketId,
      createdAt: new Date().toISOString(),
      base,
      branch,
    };

    try {
      await writeFile(
        join(sandboxPath, ".relay-state.json"),
        `${JSON.stringify(state, null, 2)}\n`,
        "utf8"
      );
    } catch (err) {
      // The worktree exists on disk without its stamp — an orphan that T-203
      // can't identify. Best-effort roll back the `git worktree add`, then
      // rethrow with context so the caller sees both failures.
      // eslint-disable-next-line no-console
      console.debug(
        `[git-worktree] state-file write failed at ${sandboxPath}; attempting rollback`
      );
      const rollback = await this.runGit(["worktree", "remove", "--force", sandboxPath], repo.root);
      if (rollback.code !== 0) {
        // eslint-disable-next-line no-console
        console.debug(
          `[git-worktree] rollback failed for ${sandboxPath} (exit ${rollback.code}): ${rollback.stderr.trim() || "unknown error"}`
        );
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to write .relay-state.json at ${sandboxPath}: ${message}`);
    }

    this.ownerRepo.set(id, repo.root);

    return {
      id,
      workdir: { kind: "local", path: sandboxPath },
      meta: { branch, base, runId, ticketId },
    };
  }

  /**
   * Remove a worktree. Idempotent: a missing path resolves to
   * `{ kind: "missing" }`.
   *
   * When `git worktree remove` reports uncommitted changes — matched against
   * {@link DIRTY_STDERR_FRAGMENTS} (currently:
   * "contains modified or untracked files", "is dirty", "has modifications",
   * "use --force to delete it") — the worktree is preserved and the call
   * resolves with `{ kind: "preserved", reason: "dirty" }`. We do NOT add
   * `--force` implicitly: doing so would destroy uncommitted agent output
   * that a T-203 recovery sweep is expected to salvage. Pass
   * `{ force: true }` to override.
   */
  async destroy(ref: SandboxRef, opts: DestroyOptions = {}): Promise<DestroyResult> {
    if (ref.workdir.kind !== "local") {
      return { kind: "missing" };
    }

    // Validate the ids embedded in the ref before we act on them — a ref
    // fabricated with `ticketId="../escape"` must not steer us to a path
    // outside `baseDir`.
    const runIdFromRef = ref.meta?.runId;
    const ticketIdFromRef = ref.meta?.ticketId;
    if (runIdFromRef !== undefined) assertSafeSegment(runIdFromRef, "runId");
    if (ticketIdFromRef !== undefined) {
      assertSafeSegment(ticketIdFromRef, "ticketId");
    }

    const path = ref.workdir.path;

    if (!(await pathExists(path))) {
      // Missing path — nothing to remove. Logged at debug only so normal
      // re-entrancy (retry / resume) doesn't spam the console. TODO: swap
      // for a project-wide logger once one exists; `console.debug` is
      // intentional and temporary.
      // eslint-disable-next-line no-console
      console.debug(`[git-worktree] destroy: path ${path} missing, no-op`);
      return { kind: "missing" };
    }

    const cwd = this.ownerRepo.get(ref.id) ?? ref.meta?.repoRoot;
    if (!cwd) {
      // Without the origin repo we cannot run `git worktree remove`. Rather
      // than silently returning (which looks like success), surface the
      // problem so callers can either pass `ref.meta.repoRoot` or use the
      // same provider instance that created the ref.
      throw new Error(
        `Cannot destroy sandbox ${ref.id}: owner repo unknown and ref.meta.repoRoot is missing`
      );
    }

    const args = ["worktree", "remove"];
    if (opts.force) args.push("--force");
    args.push(path);

    const result = await this.runGit(args, cwd);

    if (result.code === 0) {
      this.ownerRepo.delete(ref.id);
      return { kind: "removed" };
    }

    if (!opts.force && isDirtyWorktreeError(result.stderr)) {
      // Preserve on-disk state so recovery tooling (T-203) can inspect the
      // dirty worktree and decide manually. This is the key safety property.
      return { kind: "preserved", reason: "dirty", stderr: result.stderr };
    }

    throw new Error(
      `git worktree remove failed for ${path} (exit ${result.code}): ${result.stderr.trim() || "unknown error"}${result.stdout ? ` | stdout: ${result.stdout.trim()}` : ""}${result.spawnCode ? ` | spawnCode: ${result.spawnCode}` : ""}`
    );
  }
}

function requireIds(options: CreateOptions | undefined): CreateOptions {
  if (!options?.runId || !options.ticketId) {
    throw new Error("GitWorktreeSandboxProvider.create requires { runId, ticketId }");
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
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}
