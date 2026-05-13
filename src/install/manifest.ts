import { spawnSync } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { getRelayDir } from "../cli/paths.js";

export type Surface = "cli" | "tui" | "gui";

export const SURFACES: readonly Surface[] = ["cli", "tui", "gui"] as const;

/**
 * Targets for the Phase 4 SessionStart hook install (Plan 04-03).
 *
 * Each `HookTarget` corresponds to one external config file that `rly install`
 * writes a Relay-tagged entry into:
 *   - `claude` → `~/.claude/settings.json` (`SessionStart` hook array)
 *   - `codex`  → `~/.codex/hooks.json` (same shape, same matcher tag); the
 *               companion `[features].hooks = true` flag in `~/.codex/config.toml`
 *               is written separately (see `src/install/codex-toml.ts`) and
 *               not tracked in the manifest — its drift is a TOML-level concern.
 */
export type HookTarget = "claude" | "codex";

export const HOOK_TARGETS: readonly HookTarget[] = ["claude", "codex"] as const;

export interface SurfaceRecord {
  /** Semver from package.json at install time. */
  version: string;
  /** Repo HEAD SHA at install time, or null if not built from a git checkout. */
  sourceSha: string | null;
  /** ISO 8601 UTC timestamp. */
  installedAt: string;
}

/**
 * Manifest record for a SessionStart hook install (Plan 04-03 Task 2).
 *
 * `sha` is the SHA-256 of the GENERATED node-script body — deterministic
 * given a fixed `relayDir`, so drift on either external hook config file
 * (`~/.claude/settings.json` or `~/.codex/hooks.json`) registers as
 * "behind" against the current source. `command` is the absolute path
 * written into the config — typically `~/.relay/crosslink/hooks/session-start.sh`.
 */
export interface HookRecord {
  /** SHA-256 (hex) of the generated session-start node-script body. */
  sha: string;
  /** ISO 8601 UTC timestamp. */
  installedAt: string;
  /** Absolute path written into the agent config's `command` field. */
  command: string;
}

export interface InstallManifest {
  /**
   * Schema version. The Phase 4 `hooks` field is an ADDITIVE optional —
   * old (Phase 3) manifests parse without modification, so the version
   * stays at 1.
   */
  schemaVersion: 1;
  surfaces: Partial<Record<Surface, SurfaceRecord>>;
  /** Phase 4 Plan 04-03 — optional, absent on legacy manifests. */
  hooks?: Partial<Record<HookTarget, HookRecord>>;
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
  if (m.schemaVersion !== 1) return false;
  if (typeof m.surfaces !== "object" || m.surfaces === null) return false;
  // `hooks` is optional and additive (Phase 4 Plan 04-03). Accept missing,
  // empty object, or partial-target shapes. We do not deeply validate the
  // HookRecord shape here — `readManifest` falls back to empty on JSON.parse
  // errors, and downstream consumers (`getHookRecord`, `diffHook`) tolerate
  // undefined records.
  if (m.hooks !== undefined && (typeof m.hooks !== "object" || m.hooks === null)) return false;
  return true;
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
export function diffSurface(
  record: SurfaceRecord | undefined,
  source: SourceVersion
): SurfaceState {
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

// =========================================================================
// Phase 4 Plan 04-03 Task 2 — SessionStart hook drift tracking
// =========================================================================
//
// Mirrors the surface-record vocabulary (`fresh` / `current` / `behind`)
// against the same `SurfaceState` type — the user-facing meaning is
// identical, so reusing the type keeps `rly install --check` output
// uniform across surfaces and hooks. Drift detection is per-target
// (`claude` and `codex` independently) so a partial install (`--skip-codex`)
// reports honestly without polluting the surface drift report.

/** Read a single hook record from the manifest. Undefined when not installed. */
export function getHookRecord(
  manifest: InstallManifest,
  target: HookTarget
): HookRecord | undefined {
  return manifest.hooks?.[target];
}

/**
 * Stamp a hook target as installed at the given source SHA + command path.
 * Atomic read-modify-write through the same `writeManifest` path used for
 * surface records. Safe within a single `rly install` invocation; do not
 * run two installers concurrently.
 */
export async function markHookInstalled(
  target: HookTarget,
  sha: string,
  command: string
): Promise<void> {
  const manifest = await readManifest();
  manifest.hooks ??= {};
  manifest.hooks[target] = {
    sha,
    installedAt: new Date().toISOString(),
    command,
  };
  await writeManifest(manifest);
}

/**
 * Compare an installed hook record against the current source SHA.
 *
 * Reuses `SurfaceState` deliberately — `rly install --check` reports hook
 * drift in the same column / vocabulary as surface drift, so users only
 * have to learn one set of words ("current" / "behind" / "fresh").
 */
export function diffHook(record: HookRecord | undefined, source: { sha: string }): SurfaceState {
  if (!record) return "fresh";
  return record.sha === source.sha ? "current" : "behind";
}

export interface HookDriftEntry {
  target: HookTarget;
  record: HookRecord | undefined;
  state: SurfaceState;
}

/**
 * Per-target drift snapshot for the install-manifest's hook block. Callers
 * (e.g. `rly install --check`) pass the source SHAs they would write if
 * `rly install` were invoked right now; the function returns one entry per
 * target the caller asked about.
 *
 * Targets the caller omits from `sources` are skipped — letting
 * `--skip-codex` users see Claude drift without a phantom "codex: fresh"
 * row that doesn't reflect what they actually configured.
 */
export function reportHookDrift(
  manifest: InstallManifest,
  sources: Partial<Record<HookTarget, { sha: string }>>
): HookDriftEntry[] {
  const out: HookDriftEntry[] = [];
  for (const target of HOOK_TARGETS) {
    const source = sources[target];
    if (!source) continue;
    const record = getHookRecord(manifest, target);
    out.push({ target, record, state: diffHook(record, source) });
  }
  return out;
}
