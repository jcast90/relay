import { spawnSync } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { getRelayDir } from "../cli/paths.js";

export type Surface = "cli" | "tui" | "gui";

export const SURFACES: readonly Surface[] = ["cli", "tui", "gui"] as const;

export interface SurfaceRecord {
  /** Semver from package.json at install time. */
  version: string;
  /** Repo HEAD SHA at install time, or null if not built from a git checkout. */
  sourceSha: string | null;
  /** ISO 8601 UTC timestamp. */
  installedAt: string;
}

interface InstallManifest {
  schemaVersion: 1;
  surfaces: Partial<Record<Surface, SurfaceRecord>>;
}

const MANIFEST_FILE = "installed.json";

function manifestPath(): string {
  return join(getRelayDir(), MANIFEST_FILE);
}

function emptyManifest(): InstallManifest {
  return { schemaVersion: 1, surfaces: {} };
}

function isManifest(value: unknown): value is InstallManifest {
  if (!value || typeof value !== "object") return false;
  const m = value as InstallManifest;
  return m.schemaVersion === 1 && typeof m.surfaces === "object" && m.surfaces !== null;
}

/**
 * Read the install manifest. Treats a missing or unreadable file as an empty
 * manifest — on first install we want to write fresh, not error on the
 * absent file. A corrupt manifest also resolves to empty so a single bad
 * write can't permanently brick `rly install`.
 */
export async function readManifest(): Promise<InstallManifest> {
  let raw: string;
  try {
    raw = await readFile(manifestPath(), "utf8");
  } catch {
    return emptyManifest();
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (isManifest(parsed)) return parsed;
    return emptyManifest();
  } catch {
    return emptyManifest();
  }
}

async function writeManifest(manifest: InstallManifest): Promise<void> {
  const target = manifestPath();
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  await rename(tmp, target);
}

/**
 * Stamp a surface as installed at the given source version. Atomic
 * read-modify-write; safe to call concurrently from one process but not
 * across parallel `rly install` runs (we don't expect that).
 */
export async function markInstalled(
  surface: Surface,
  version: string,
  sourceSha: string | null
): Promise<void> {
  const manifest = await readManifest();
  manifest.surfaces[surface] = {
    version,
    sourceSha,
    installedAt: new Date().toISOString(),
  };
  await writeManifest(manifest);
}

export interface SourceVersion {
  version: string;
  sourceSha: string | null;
}

let sourceVersionCache: SourceVersion | null = null;

/**
 * Detect the source version Relay would install if `rly install` were run
 * right now: package.json `version` plus the repo HEAD SHA. The SHA is
 * null when we're not in a git checkout (e.g. running from a published
 * tarball) — in that case we fall back to comparing only the semver.
 *
 * Cached for the process lifetime — neither the package.json version nor
 * the HEAD SHA changes mid-process during normal use, and the startup
 * nudge calls this on every command.
 */
export async function getSourceVersion(): Promise<SourceVersion> {
  if (sourceVersionCache) return sourceVersionCache;

  const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
  const packageJsonPath = join(repoRoot, "package.json");
  let version = "0.0.0";
  try {
    const raw = await readFile(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw) as { version?: string };
    if (typeof parsed.version === "string") version = parsed.version;
  } catch {
    // Falls through to "0.0.0" — manifests will still compare equal across
    // runs from the same broken tree, just won't carry useful version info.
  }

  // `git rev-parse HEAD` is fast (~10ms) and avoids pulling a full git
  // library dependency just to read one ref. Stderr is suppressed because
  // outside a git checkout this prints to fd 2 even with --quiet.
  let sourceSha: string | null = null;
  try {
    const result = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.status === 0) {
      const trimmed = result.stdout.trim();
      if (trimmed.length > 0) sourceSha = trimmed;
    }
  } catch {
    // Git not installed or not on PATH — treat as "no SHA".
  }

  sourceVersionCache = { version, sourceSha };
  return sourceVersionCache;
}

export type SurfaceState = "fresh" | "current" | "behind";

/**
 * Compare a surface's installed record against the current source version.
 *
 * - `fresh` — no record. We've never installed this surface, so the
 *   user is likely running source directly. Don't nudge.
 * - `current` — matches the source SHA (or matches the semver when we
 *   couldn't read a SHA on either side).
 * - `behind` — installed differs from source. Nudge.
 */
export function diffSurface(record: SurfaceRecord | undefined, source: SourceVersion): SurfaceState {
  if (!record) return "fresh";
  // Prefer SHA comparison — it catches "same version, different commit"
  // (the common case during dev — every PR pre-release shares the version
  // string but has a different SHA). Fall back to version-only when either
  // side is missing a SHA.
  if (record.sourceSha && source.sourceSha) {
    return record.sourceSha === source.sourceSha ? "current" : "behind";
  }
  return record.version === source.version ? "current" : "behind";
}

export interface DriftReport {
  source: SourceVersion;
  surfaces: Record<Surface, { record: SurfaceRecord | undefined; state: SurfaceState }>;
  /** Surfaces in the `behind` state — what the nudge / `--check` reports. */
  behind: Surface[];
}

/**
 * Snapshot the current install state vs. source. Drives both the
 * `rly install --check` output and the startup nudge.
 */
export async function reportDrift(): Promise<DriftReport> {
  const [manifest, source] = await Promise.all([readManifest(), getSourceVersion()]);
  const surfaces = {} as DriftReport["surfaces"];
  const behind: Surface[] = [];
  for (const surface of SURFACES) {
    const record = manifest.surfaces[surface];
    const state = diffSurface(record, source);
    surfaces[surface] = { record, state };
    if (state === "behind") behind.push(surface);
  }
  return { source, surfaces, behind };
}

/** Test helper — clear the source-version cache so tests can vary it. */
export function __resetSourceVersionCacheForTests(): void {
  sourceVersionCache = null;
}
