import { mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { getRelayDir } from "../cli/paths.js";

/**
 * AL-9 — kill-switch "STOP file" watcher.
 *
 * The autonomous-loop driver polls for the existence of
 * `~/.relay/sessions/<sessionId>/STOP` at the start of each tick. When the
 * file appears, the driver flips the lifecycle to `winding_down` with
 * reason `"user-stop-signal"` — a graceful wind-down, not a force-kill.
 * In-flight workers finish their current step; the loop stops dispatching
 * new tickets.
 *
 * ## Why a file?
 *
 * A file is the smallest common denominator between three producers:
 *
 *   - CLI `rly session stop <sessionId>` — trivially writes a file.
 *   - Tauri `stop_session` command — shells out to the same CLI.
 *   - A human typing `touch ~/.relay/sessions/<id>/STOP` at a shell —
 *     always supported, always simple, no IPC plumbing to break.
 *
 * The alternative (a socket, a signal, a named pipe) would gain nothing
 * here: the loop tick cadence is 20s by default, and a filesystem poll
 * round-trip is trivial compared to that. File-based also survives a CLI
 * daemon crash — drop the file at any point and the loop picks it up on
 * its next tick.
 *
 * ## Why NOT force-kill?
 *
 * Ticket workers own git state (worktrees, branches, partial commits). A
 * hard SIGKILL mid-commit leaves the repo in a state that the post-run
 * cleanup can't reliably unwind. The lifecycle's `winding_down` state is
 * already the well-defined "stop dispatching, drain the current ticket"
 * transition — the STOP file just flips it from outside the process.
 */

/**
 * The fixed filename inside each session directory. No suffix, no
 * extension — `ls ~/.relay/sessions/<id>` has to immediately show the
 * stop signal when it's present. The loop and the CLI agree on this
 * name; changing it is a breaking change.
 */
export const STOP_FILE_NAME = "STOP";

/**
 * Resolve the absolute path to a session's STOP file. Exported for tests
 * and for callers (CLI, Tauri) that want to render the path in a log.
 */
export function stopFilePath(sessionId: string, rootDir?: string): string {
  const root = rootDir ?? getRelayDir();
  return join(root, "sessions", sessionId, STOP_FILE_NAME);
}

/**
 * Return `true` iff the STOP file currently exists for the session.
 *
 * Does NOT read the file contents — presence is the whole signal. Any
 * error other than ENOENT is surfaced to the caller so a corrupted
 * filesystem (permission denied, etc.) doesn't silently masquerade as
 * "no stop requested".
 */
export async function checkForStop(sessionId: string, rootDir?: string): Promise<boolean> {
  const path = stopFilePath(sessionId, rootDir);
  try {
    await stat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw err;
  }
}

/**
 * Options accepted by {@link writeStopFile}.
 */
export interface WriteStopFileOptions {
  /** Override `~/.relay` root (tests only). */
  rootDir?: string;
  /**
   * Freeform tag identifying who dropped the file: `"cli"`, `"gui"`,
   * `"test"`. Persisted to the file body for post-mortem debugging.
   */
  source?: string;
  /** Clock injection for deterministic tests. */
  clock?: () => number;
}

/**
 * Atomically write the STOP file for a session.
 *
 * Used by the CLI (`rly session stop <sessionId>`) and by the Tauri
 * `stop_session` command. The write is tmp + rename so a concurrent
 * {@link checkForStop} can never see a half-written file — it either
 * observes ENOENT (pre-rename) or the full STOP file (post-rename). The
 * session directory is created as needed so an operator can stop a
 * session whose `~/.relay/sessions/<id>/` tree doesn't exist yet (the
 * loop creates it lazily on its first write).
 *
 * The payload is a small JSON body with `requestedAt` + an optional
 * `source` tag — informative only. The loop treats presence, not
 * contents, as the kill signal, so future additions to this shape are
 * backwards-compatible.
 */
export async function writeStopFile(
  sessionId: string,
  options: WriteStopFileOptions = {}
): Promise<string> {
  if (!sessionId) {
    throw new Error("writeStopFile: sessionId is required");
  }
  const path = stopFilePath(sessionId, options.rootDir);
  const clock = options.clock ?? Date.now;
  const body = {
    sessionId,
    requestedAt: new Date(clock()).toISOString(),
    source: options.source ?? "unknown",
  };
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${clock()}`;
  await writeFile(tmp, JSON.stringify(body, null, 2), "utf8");
  try {
    await rename(tmp, path);
  } catch (err) {
    // Best-effort cleanup — the tmp file leak is preferable to swallowing
    // the rename error (the caller needs to know the signal didn't land).
    await unlink(tmp).catch(() => {});
    throw err;
  }
  return path;
}

/**
 * Remove the STOP file if it exists. No-op when absent. Primarily useful
 * for tests that reuse a session directory across cases and for an
 * operator who dropped the file by mistake and wants to un-stop a
 * session that hasn't ticked yet.
 */
export async function clearStopFile(sessionId: string, rootDir?: string): Promise<void> {
  const path = stopFilePath(sessionId, rootDir);
  try {
    await unlink(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}

/**
 * Default poll cadence for the autonomous-loop tick that calls
 * {@link checkForStop}. 20s is an operator-visible latency budget — the
 * acceptance criterion is "within one tick". The driver accepts an
 * override (e.g. tests pass 10–50ms so the integration runs in <1s).
 */
export const DEFAULT_STOP_POLL_INTERVAL_MS = 20_000;

/**
 * Reason string recorded on the lifecycle transition fired when a STOP
 * file is observed. Exported so tests and downstream tools (log
 * grepping, dashboard filters) can pin on a stable identifier.
 */
export const STOP_FILE_REASON = "user-stop-signal";
