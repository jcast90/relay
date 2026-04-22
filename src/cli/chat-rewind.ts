import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { Channel, RepoAssignment } from "../domain/channel.js";
import { ChannelStore } from "../channels/channel-store.js";
import { getHarnessStore } from "../storage/factory.js";
import { SessionStore } from "./session-store.js";

const execFileAsync = promisify(execFile);

/**
 * Build the refname we stash a rewind snapshot under. One ref per
 * (session, key, repo) — the repo is implicit because the ref lives inside
 * that repo's `.git/refs/` directory.
 */
export function rewindRefName(sessionId: string, key: string): string {
  return `refs/harness-rewind/${sessionId}/${key}`;
}

export interface RewindSnapshotEntry {
  alias: string;
  repoPath: string;
  sha: string;
  ref: string;
}

export interface RewindSnapshotResult {
  key: string;
  snapshots: RewindSnapshotEntry[];
}

export interface RewindApplyEntry {
  alias: string;
  repoPath: string;
  sha: string;
}

export interface RewindApplyResult {
  reset: RewindApplyEntry[];
  removedMessages: number;
  clearedClaudeSessions: boolean;
}

/**
 * Dependencies injected into {@link rewindSnapshot} / {@link rewindApply}
 * so tests can run without touching `~/.relay/` or a real git repo.
 *
 * - `channelStore` is how we look up `repoAssignments` for a channel.
 * - `sessionStore` owns the session JSONL + index writes that get
 *   truncated on apply.
 * - `gitExec` runs `git <args>` in a given cwd. The default implementation
 *   is `execFile("git", …)`; tests swap in a fake that returns scripted
 *   stdout or throws.
 */
export interface RewindDeps {
  channelStore: Pick<ChannelStore, "getChannel">;
  sessionStore: Pick<SessionStore, "truncateBeforeTimestamp" | "clearClaudeSessionIds">;
  gitExec: (args: string[], opts: { cwd: string }) => Promise<{ stdout: string; stderr: string }>;
  /** Injectable clock for deterministic test keys. Defaults to `Date.now`. */
  now?: () => number;
}

export function defaultRewindDeps(): RewindDeps {
  return {
    channelStore: new ChannelStore(undefined, getHarnessStore()),
    sessionStore: new SessionStore(),
    gitExec: async (args, opts) => execFileAsync("git", args, { cwd: opts.cwd }),
  };
}

async function resolveChannelRepos(
  channelStore: RewindDeps["channelStore"],
  channelId: string
): Promise<RepoAssignment[]> {
  const channel = (await channelStore.getChannel(channelId)) as Channel | null;
  if (!channel) throw new Error(`Channel not found: ${channelId}`);
  return channel.repoAssignments ?? [];
}

/**
 * Snapshot the current HEAD of every channel repo under
 * `refs/harness-rewind/<sessionId>/<key>`. Returns the key so callers can
 * stash it as `rewindKey` metadata on the upcoming user message.
 */
export async function rewindSnapshot(
  channelId: string,
  sessionId: string,
  deps: RewindDeps = defaultRewindDeps()
): Promise<RewindSnapshotResult> {
  const repos = await resolveChannelRepos(deps.channelStore, channelId);
  const key = `${(deps.now ?? Date.now)()}`;
  const snapshots: RewindSnapshotEntry[] = [];
  for (const assignment of repos) {
    const refName = rewindRefName(sessionId, key);
    const { stdout: shaOut } = await deps.gitExec(["rev-parse", "HEAD"], {
      cwd: assignment.repoPath,
    });
    const sha = shaOut.trim();
    if (!sha) {
      throw new Error(`git rev-parse HEAD produced empty output in ${assignment.repoPath}`);
    }
    await deps.gitExec(["update-ref", refName, sha], {
      cwd: assignment.repoPath,
    });
    snapshots.push({
      alias: assignment.alias,
      repoPath: assignment.repoPath,
      sha,
      ref: refName,
    });
  }
  return { key, snapshots };
}

/**
 * Apply a previously captured rewind: hard-reset every channel repo to the
 * snapshotted SHA, truncate the chat log back to `messageTimestamp`, and
 * clear the Claude CLI session ids so the next turn starts fresh.
 *
 * Hardening (OSS-01 Gap #3):
 *   1. Pre-flight: every target ref must resolve in every repo.
 *   2. Pre-flight: every repo must be clean (`git status --porcelain` empty)
 *      so we don't silently clobber user hand-edits with `reset --hard`.
 *   3. Only truncate the session log after EVERY repo reset succeeds. If
 *      any reset fails mid-way, the log is preserved so the user can
 *      recover manually.
 */
export async function rewindApply(
  channelId: string,
  sessionId: string,
  key: string,
  messageTimestamp: string,
  deps: RewindDeps = defaultRewindDeps()
): Promise<RewindApplyResult> {
  const repos = await resolveChannelRepos(deps.channelStore, channelId);
  const refName = rewindRefName(sessionId, key);

  // --- Pre-flight: resolve refs + confirm clean worktrees across ALL repos
  // before mutating anything. Any failure aborts the whole operation.
  const resolved: Array<{ assignment: RepoAssignment; sha: string }> = [];
  for (const assignment of repos) {
    let sha: string;
    try {
      const { stdout } = await deps.gitExec(["rev-parse", "--verify", `${refName}^{commit}`], {
        cwd: assignment.repoPath,
      });
      sha = stdout.trim();
    } catch (err) {
      throw new Error(
        `Rewind ref ${refName} missing or unresolvable in ${assignment.repoPath} (alias @${assignment.alias}): ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
    if (!sha) {
      throw new Error(
        `Rewind ref ${refName} resolved to empty SHA in ${assignment.repoPath} (alias @${assignment.alias})`
      );
    }

    let porcelain: string;
    try {
      const { stdout } = await deps.gitExec(["status", "--porcelain"], {
        cwd: assignment.repoPath,
      });
      porcelain = stdout;
    } catch (err) {
      throw new Error(
        `git status failed in ${assignment.repoPath} (alias @${assignment.alias}): ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
    if (porcelain.trim().length > 0) {
      throw new Error(
        `Refusing to rewind: ${assignment.repoPath} (alias @${assignment.alias}) has uncommitted or untracked changes. Commit, stash, or clean them before rewinding.`
      );
    }

    resolved.push({ assignment, sha });
  }

  // --- Mutation phase: every reset must succeed before we touch the log.
  const reset: RewindApplyEntry[] = [];
  for (const { assignment, sha } of resolved) {
    await deps.gitExec(["reset", "--hard", sha], { cwd: assignment.repoPath });
    reset.push({
      alias: assignment.alias,
      repoPath: assignment.repoPath,
      sha,
    });
  }

  // Only now is it safe to truncate the chat log. If the loop above threw
  // on repo N of M, the earlier repos are already reset (git doesn't give
  // us free rollback) but the session log remains intact so the user can
  // reason about what happened.
  const removedMessages = await deps.sessionStore.truncateBeforeTimestamp(
    channelId,
    sessionId,
    messageTimestamp
  );
  const cleared = await deps.sessionStore.clearClaudeSessionIds(channelId, sessionId);

  return { reset, removedMessages, clearedClaudeSessions: cleared !== null };
}
