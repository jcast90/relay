import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const RELAY_DIR_NAME = ".relay";

let resolved: string | null = null;

/**
 * Resolve the Relay state directory (`~/.relay/`), creating it on first call
 * if it doesn't already exist.
 *
 * The result is cached for the process lifetime. `existsSync` is synchronous
 * by design — this runs once at startup and callers of the state-dir are
 * themselves synchronous path builders.
 */
export function getRelayDir(): string {
  if (resolved) return resolved;

  const home = homedir();
  const relayPath = join(home, RELAY_DIR_NAME);

  if (!existsSync(relayPath)) {
    mkdirSync(relayPath, { recursive: true });
  }

  resolved = relayPath;
  return resolved;
}

/** Test helper — force re-resolution on the next `getRelayDir()` call. */
export function __resetRelayDirCacheForTests(): void {
  resolved = null;
}
