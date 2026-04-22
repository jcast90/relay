import { existsSync, lstatSync, mkdirSync, renameSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const NEW_DIR_NAME = ".relay";
const LEGACY_DIR_NAME = ".agent-harness";

let resolved: string | null = null;

/**
 * Resolve the Relay state directory (default `~/.relay/`), auto-migrating
 * from the legacy `~/.agent-harness/` path on first call. The migration is:
 *
 *   - If `~/.relay` exists, use it.
 *   - Else if `~/.agent-harness` exists AS A REAL DIRECTORY (not already a
 *     symlink), rename it to `~/.relay` and leave a back-compat symlink at
 *     the old path so external tools that still look there keep working.
 *   - Else create `~/.relay`.
 *
 * The result is cached for the process lifetime. `existsSync` / `lstatSync`
 * are synchronous by design — this runs once at startup and callers of the
 * state-dir are themselves synchronous path builders.
 */
export function getRelayDir(): string {
  if (resolved) return resolved;

  const home = homedir();
  const newPath = join(home, NEW_DIR_NAME);
  const legacyPath = join(home, LEGACY_DIR_NAME);

  if (existsSync(newPath)) {
    // Divergent state: both paths exist as real dirs. Could happen if a user
    // manually copied data across hosts or partially followed a migration
    // guide. Surface the orphaned legacy dir once per process so data isn't
    // silently lost — we still use the new path, but point at the old one.
    if (existsSync(legacyPath)) {
      const legacyStat = lstatSync(legacyPath);
      if (legacyStat.isDirectory() && !legacyStat.isSymbolicLink()) {
        console.warn(
          `[relay] ignoring legacy state dir at ${legacyPath} — using ${newPath}. ` +
            "Move or delete the legacy directory to silence this warning."
        );
      }
    }
    resolved = newPath;
    return resolved;
  }

  if (existsSync(legacyPath)) {
    const stat = lstatSync(legacyPath);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      try {
        renameSync(legacyPath, newPath);
        try {
          symlinkSync(newPath, legacyPath);
        } catch {
          // Back-compat symlink couldn't be created (permission / filesystem
          // quirk). Non-fatal — the new path works and external tools can be
          // updated manually.
        }
        resolved = newPath;
        return resolved;
      } catch {
        // Migration failed; fall back to the legacy path so the user's data
        // is never hidden. They'll see both references until the next
        // successful migration attempt.
        resolved = legacyPath;
        return resolved;
      }
    }
    // Legacy path is a symlink (already migrated) or not a dir — follow it.
    resolved = legacyPath;
    return resolved;
  }

  mkdirSync(newPath, { recursive: true });
  resolved = newPath;
  return resolved;
}

/** Test helper — force re-resolution on the next `getRelayDir()` call. */
export function __resetRelayDirCacheForTests(): void {
  resolved = null;
}
