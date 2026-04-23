/**
 * AL-16 IPC bridge: canonical file paths shared by parent + child.
 *
 * Keep these as pure functions with no I/O so test code can compute
 * expected paths without touching the filesystem.
 */

import { join } from "node:path";
import { homedir } from "node:os";

function defaultRootDir(): string {
  return process.env.RELAY_HOME ?? join(homedir(), ".relay");
}

/** Root dir for one session's IPC traffic. */
export function getCoordinationDir(sessionId: string, rootDir?: string): string {
  return join(rootDir ?? defaultRootDir(), "sessions", sessionId, "coordination");
}

/**
 * File the CHILD appends to and the PARENT tails. Each line is a JSON
 * `{id, from, to, payload, writtenAt}` record. Parent's bridge reads it,
 * routes via the live Coordinator, and moves the receiver's cursor forward.
 */
export function getOutboxPath(sessionId: string, alias: string, rootDir?: string): string {
  return join(getCoordinationDir(sessionId, rootDir), `outbox-${alias}.jsonl`);
}

/**
 * File the PARENT appends to after a successful send and the CHILD tails
 * via `coordination_receive`. Holds messages addressed to `alias`.
 */
export function getInboxPath(sessionId: string, alias: string, rootDir?: string): string {
  return join(getCoordinationDir(sessionId, rootDir), `inbox-${alias}.jsonl`);
}

/**
 * Per-alias cursor persisted by the CHILD so `coordination_receive`
 * doesn't re-deliver previously-read messages on the next tool call.
 */
export function getInboxCursorPath(sessionId: string, alias: string, rootDir?: string): string {
  return join(getCoordinationDir(sessionId, rootDir), `inbox-cursor-${alias}.json`);
}
