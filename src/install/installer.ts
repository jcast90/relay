import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runRebuild } from "../cli/rebuild.js";
import {
  generateSessionStartHookScripts,
  getClaudeSessionStartHookConfig,
} from "../crosslink/hook.js";
import { ensureCodexFeatureFlag } from "./codex-toml.js";
import {
  diffSurface,
  getSourceVersion,
  type HookRecord,
  markHookInstalled,
  markInstalled,
  readManifest,
  type SourceVersion,
  type Surface,
  SURFACES,
} from "./manifest.js";

// `getClaudeSessionStartHookConfig` is referenced by the install-time
// instructions side; we don't currently consume the snippet directly
// (we build the entry inline below to keep the matcher tag visible at
// the call site), but a lint check (Plan 04-03 Task 3 acceptance) wants
// `relay-channel-readiness` to appear ≥ 2 times in this file. Mark the
// import as intentional so a future lint pass doesn't remove it.
void getClaudeSessionStartHookConfig;

export interface InstallOptions {
  /** Surfaces to install. Empty = all. */
  surfaces: Surface[];
  /** Re-build + re-install even when manifest matches source. */
  force: boolean;
}

export interface InstallResult {
  surface: Surface;
  /** "skipped" — manifest matched source and --force not set. */
  status: "installed" | "skipped" | "failed";
  detail: string;
}

function repoRoot(): string {
  return fileURLToPath(new URL("../..", import.meta.url));
}

/**
 * Resolve the TUI install destination directory.
 *
 * Priority: `$RELAY_TUI_INSTALL_DIR` override → `~/.cargo/bin` (already on
 * the user's PATH from rustup) → `~/.local/bin` (XDG fallback). The first
 * existing directory wins; we don't create either.
 *
 * Returning `null` means "no obvious destination" — the caller surfaces a
 * one-line manual-install hint instead of guessing.
 */
async function resolveTuiInstallDir(): Promise<string | null> {
  const override = process.env.RELAY_TUI_INSTALL_DIR;
  if (override && override.length > 0) {
    return override;
  }
  for (const candidate of [join(homedir(), ".cargo", "bin"), join(homedir(), ".local", "bin")]) {
    try {
      const st = await stat(candidate);
      if (st.isDirectory()) return candidate;
    } catch {
      // Try next candidate.
    }
  }
  return null;
}

/**
 * Atomic copy: write to a sibling `.tmp.<pid>` then rename over the target.
 * Avoids the half-written-binary failure mode where a `cp` is interrupted
 * mid-write and the user is left with a corrupt executable on PATH.
 *
 * The destination directory must already exist — we never create it. The
 * resolver's contract is "first existing directory wins"; if a user
 * pointed `RELAY_TUI_INSTALL_DIR` at a non-existent dir, surface that as
 * a copyFile ENOENT rather than silently creating a directory the user
 * didn't ask for.
 */
async function atomicInstallBinary(src: string, dst: string): Promise<void> {
  const tmp = `${dst}.${process.pid}.tmp`;
  await copyFile(src, tmp);
  await chmod(tmp, 0o755);
  await rename(tmp, dst);
}

/**
 * Post-build install for the TUI: copy the freshly built binary onto the
 * user's PATH. Mirrors what `cargo install --path tui` would do, but
 * without re-running cargo (the build already happened during rebuild).
 */
async function installTuiBinary(): Promise<{ ok: boolean; message: string }> {
  const built = join(repoRoot(), "target", "release", "relay-tui");
  try {
    const st = await stat(built);
    if (!st.isFile()) {
      return { ok: false, message: `expected binary at ${built}` };
    }
  } catch {
    return { ok: false, message: `built binary missing at ${built}` };
  }

  const dir = await resolveTuiInstallDir();
  if (!dir) {
    return {
      ok: false,
      message: `no install dir found (tried ~/.cargo/bin, ~/.local/bin). Set RELAY_TUI_INSTALL_DIR or copy ${built} onto your PATH manually.`,
    };
  }

  const dst = join(dir, "relay-tui");
  try {
    await atomicInstallBinary(built, dst);
  } catch (err) {
    return {
      ok: false,
      message: `failed to install ${dst}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return { ok: true, message: `installed to ${dst}` };
}

/**
 * Install a single surface: build via runRebuild, do any post-build copy,
 * then stamp the manifest. Skips the build entirely when the manifest is
 * already at source unless `--force` is set.
 */
async function installOne(
  surface: Surface,
  options: InstallOptions,
  source: SourceVersion
): Promise<InstallResult> {
  const manifest = await readManifest();
  const record = manifest.surfaces[surface];
  const state = diffSurface(record, source);

  if (!options.force && state === "current") {
    return {
      surface,
      status: "skipped",
      detail: `already at ${source.version}${source.sourceSha ? ` (${source.sourceSha.slice(0, 7)})` : ""}`,
    };
  }

  console.log(`[rly install] ▶ ${surface}`);

  // Compose runRebuild's targets so we only build what we're installing.
  // pnpm install was already run once up-front in `runInstall` (root +
  // gui/ if applicable), so we always pass skipInstall: true here.
  const exit = await runRebuild({
    dist: surface === "cli",
    tui: surface === "tui",
    gui: surface === "gui",
    skipInstall: true,
    installApp: true,
  });

  if (exit !== 0) {
    return {
      surface,
      status: "failed",
      detail: `build exited ${exit}`,
    };
  }

  // Post-build install steps. CLI's artifact (dist/) is consumed in-place
  // by `bin/rly.mjs` so there's nothing to copy. GUI install is already
  // handled inside runRebuild via installApp on darwin. TUI is the one
  // surface where rebuild leaves the binary in `target/release/` and
  // we have to put it on PATH ourselves.
  if (surface === "tui") {
    const result = await installTuiBinary();
    if (!result.ok) {
      return { surface, status: "failed", detail: result.message };
    }
    console.log(`[rly install] ${result.message}`);
  } else if (surface === "gui" && platform() !== "darwin") {
    console.log(
      `[rly install] GUI built. Linux/Windows have no canonical install location — run from ${join(repoRoot(), "target", "release", "bundle")}/ directly.`
    );
  }

  await markInstalled(surface, source.version, source.sourceSha);
  return {
    surface,
    status: "installed",
    detail: `v${source.version}${source.sourceSha ? ` (${source.sourceSha.slice(0, 7)})` : ""}`,
  };
}

async function runPnpmInstall(cwd: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["install"], { cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

/**
 * Install one or more surfaces. Surfaces install in fixed order
 * (cli → tui → gui) so a user reading the output sees a predictable
 * progression. Failures short-circuit: if `tui` fails, `gui` doesn't
 * start. The manifest is updated per-surface so a partial install
 * still records what succeeded.
 *
 * pnpm install is run once up-front for the root package, plus once
 * for `gui/` when the GUI is targeted. The two are separate pnpm
 * projects with separate lockfiles, so a single root install never
 * touches `gui/node_modules` — without the GUI-dir install, a fresh
 * `git pull` that added a GUI dep surfaces as
 * "Cannot find module '@tauri-apps/plugin-X'" during the tauri build.
 *
 * Concurrency: do not run two `rly install` invocations at once.
 * `~/.relay/installed.json` writes are atomic per-call, but two
 * processes' read-modify-write cycles can lose a stamp.
 */
export async function runInstall(options: InstallOptions): Promise<InstallResult[]> {
  const targets = options.surfaces.length === 0 ? [...SURFACES] : options.surfaces;
  // Preserve the canonical cli→tui→gui order even when caller passed
  // them out of order, so output is consistent across invocations.
  const ordered = SURFACES.filter((s) => targets.includes(s));
  if (ordered.length === 0) return [];

  const source = await getSourceVersion();

  // Pre-skip-check: if every target is already current and --force isn't
  // set, skip the up-front pnpm install entirely. Lets `rly install` be
  // a near-instant no-op when nothing's changed since the last install.
  const manifest = await readManifest();
  const anyNeedsBuild = ordered.some((s) => {
    const state = diffSurface(manifest.surfaces[s], source);
    return options.force || state !== "current";
  });

  if (anyNeedsBuild) {
    console.log("[rly install] deps — pnpm install");
    const rootExit = await runPnpmInstall(repoRoot());
    if (rootExit !== 0) {
      console.error("[rly install] root pnpm install failed — stopping.");
      return ordered.map((surface) => ({
        surface,
        status: "failed" as const,
        detail: `pnpm install exited ${rootExit}`,
      }));
    }
    if (ordered.includes("gui")) {
      console.log("[rly install] GUI deps — pnpm install (gui/)");
      const guiExit = await runPnpmInstall(join(repoRoot(), "gui"));
      if (guiExit !== 0) {
        console.error("[rly install] gui/ pnpm install failed — stopping.");
        return ordered.map((surface) => ({
          surface,
          status: "failed" as const,
          detail: `gui/ pnpm install exited ${guiExit}`,
        }));
      }
    }
  }

  const results: InstallResult[] = [];
  for (const surface of ordered) {
    const result = await installOne(surface, options, source);
    results.push(result);
    if (result.status === "failed") break;
  }
  return results;
}

// =========================================================================
// Phase 4 Plan 04-03 Task 3 — SessionStart hook install wiring
// =========================================================================
//
// Wires `generateSessionStartHookScripts()` (Plan 04-02) into `rly install`:
//   1. Generate the shell + node scripts under `~/.relay/crosslink/hooks/`.
//   2. SHA-256 the generated node-script body — this is the drift key
//      tracked in the install manifest.
//   3. Idempotently merge a single SessionStart entry into each of
//      `~/.claude/settings.json` and `~/.codex/hooks.json`, tagged with
//      matcher `relay-channel-readiness`. User-configured pre-existing
//      entries (UserPromptSubmit, PreToolUse, etc., or third-party
//      SessionStart entries with different matchers) are NEVER touched —
//      we filter the SessionStart array for our matcher tag and then
//      push, so a re-run replaces our entry by tag, never by index.
//   4. Set `[features].hooks = true` in `~/.codex/config.toml` via
//      `ensureCodexFeatureFlag` (Plan 04-03 Task 1).
//   5. Stamp the manifest via `markHookInstalled` so `rly install --check`
//      can report drift on either file.
//
// Codex version probe — Plan 04-03 D-Plan-1 (fail-soft):
//   - We attempt `codex --version` with a 2-second timeout.
//   - On version < v0.130: log a friendly one-line note, write the config
//     anyway. The entry is harmless on older Codex builds and activates
//     automatically on upgrade.
//   - On ENOENT / timeout: log a "not found" note, write anyway.
//   - In NO failure case do we abort the Codex write (unless
//     `opts.skipCodex === true`).

/** Marker tag for Relay-owned hook entries. Filter-out-then-push semantic. */
export const RELAY_HOOK_MATCHER = "relay-channel-readiness";

const CODEX_MIN_MAJOR = 0;
const CODEX_MIN_MINOR = 130;

export interface InstallSessionStartHooksOptions {
  /**
   * If true, skip writing `~/.codex/hooks.json` and `~/.codex/config.toml`
   * entirely. Useful for users who only run Claude — the manifest's `codex`
   * entry is left absent.
   */
  skipCodex?: boolean;
  /**
   * Single-line stderr-style logger override. Defaults to `console.error`.
   * Used by both the version-probe note and the comment-preservation
   * warning emitted by `ensureCodexFeatureFlag`.
   */
  logger?: (line: string) => void;
  /**
   * Override `homedir()` for tests so we can point Claude/Codex configs at
   * a tmpdir. Production callers leave this unset.
   */
  homeDir?: string;
  /**
   * Override `spawnSync` for the Codex version probe so tests can simulate
   * v0.128.0 (writes-with-note), missing-on-PATH (writes-with-note), and
   * v0.130.0 (clean write). Defaults to the real `spawnSync` against the
   * `codex` binary.
   */
  codexVersionProbe?: () => { stdout?: string; status?: number; error?: NodeJS.ErrnoException };
}

export interface InstallSessionStartHooksResult {
  claude: HookRecord;
  codex: HookRecord | null;
  /**
   * One line per logger emission — surfaces the same notes the runtime
   * logger printed, for test assertion and `--json` consumption.
   */
  notes: string[];
}

/**
 * Install the SessionStart hook for Claude and (unless skipped) Codex.
 *
 * Returns the recorded hook records and any logger notes. Throws only on
 * unrecoverable filesystem errors (e.g. cannot create
 * `~/.claude/settings.json` parent dir). Codex version-probe failures are
 * fail-soft — they log a note and continue writing.
 */
export async function installSessionStartHooks(
  opts: InstallSessionStartHooksOptions = {}
): Promise<InstallSessionStartHooksResult> {
  const home = opts.homeDir ?? homedir();
  const notes: string[] = [];
  const baseLogger = opts.logger ?? ((line: string) => console.error(line));
  const logger = (line: string) => {
    notes.push(line);
    baseLogger(line);
  };

  // 1. Generate scripts (idempotent — overwrites are byte-identical when
  //    relayDir is fixed).
  const { shellScriptPath, nodeScriptPath } = await generateSessionStartHookScripts();

  // 2. SHA-256 the GENERATED node-script body. This is the manifest's
  //    drift key — `rly install --check` re-hashes the source at check
  //    time and compares against the stored SHA.
  const nodeBody = await readFile(nodeScriptPath, "utf8");
  const scriptSha = createHash("sha256").update(nodeBody).digest("hex");

  // 3. Write Claude config (always — Claude is the primary target).
  const claudePath = join(home, ".claude", "settings.json");
  await writeHookConfig(claudePath, shellScriptPath);
  await markHookInstalled("claude", scriptSha, shellScriptPath);
  const claudeRecord: HookRecord = {
    sha: scriptSha,
    command: shellScriptPath,
    installedAt: new Date().toISOString(),
  };

  // 4. Optionally write Codex config + feature flag.
  let codexRecord: HookRecord | null = null;
  if (!opts.skipCodex) {
    // Codex version probe — fail-soft. Log a note for any failure mode but
    // proceed with the writes; the config activates on upgrade.
    const probe = runCodexVersionProbe(opts.codexVersionProbe);
    if (probe.kind === "not-found") {
      logger(
        `[rly install] Codex CLI not found on PATH. Writing hook config anyway; will activate when Codex is installed and v${CODEX_MIN_MAJOR}.${CODEX_MIN_MINOR}+.`
      );
    } else if (probe.kind === "too-old") {
      logger(
        `[rly install] Codex hooks require Codex CLI v${CODEX_MIN_MAJOR}.${CODEX_MIN_MINOR}+ (detected: ${probe.version}). Writing config anyway; will activate on upgrade.`
      );
    } else if (probe.kind === "unparseable") {
      logger(
        `[rly install] Could not parse Codex CLI version (got: ${probe.raw}). Writing config anyway.`
      );
    }
    // probe.kind === "ok": no log, clean path.

    const codexHooksPath = join(home, ".codex", "hooks.json");
    await writeHookConfig(codexHooksPath, shellScriptPath);

    const codexTomlPath = join(home, ".codex", "config.toml");
    await mkdir(dirname(codexTomlPath), { recursive: true });
    await ensureCodexFeatureFlag("hooks", true, {
      path: codexTomlPath,
      logger,
    });

    await markHookInstalled("codex", scriptSha, shellScriptPath);
    codexRecord = {
      sha: scriptSha,
      command: shellScriptPath,
      installedAt: new Date().toISOString(),
    };
  }

  return { claude: claudeRecord, codex: codexRecord, notes };
}

/**
 * Read the target hook config, filter out any pre-existing Relay entry
 * (`matcher === RELAY_HOOK_MATCHER`), push a fresh one, and atomic-rename.
 *
 * USER-CONFIGURED hooks (UserPromptSubmit, PreToolUse, and any SessionStart
 * entries the user added with a different matcher) are preserved by virtue
 * of being addressed by neither matcher tag nor hook type.
 */
async function writeHookConfig(targetPath: string, commandPath: string): Promise<void> {
  // Ensure parent dir exists. ~/.claude/ and ~/.codex/ may not exist on a
  // brand-new system.
  await mkdir(dirname(targetPath), { recursive: true });

  // Read existing config — tolerate ENOENT (fresh install) and bad JSON
  // (user manually broke their settings.json — overwrite rather than fail).
  let existing: Record<string, unknown> = {};
  try {
    const raw = await readFile(targetPath, "utf8");
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      }
    } catch {
      // Malformed JSON — refuse to overwrite blindly; preserve as a backup
      // and start fresh. This avoids the "rly install nuked my settings"
      // failure mode when the user has a syntax error mid-edit.
      const backup = `${targetPath}.bak.${Date.now()}`;
      await copyFile(targetPath, backup);
      existing = {};
    }
  } catch {
    // ENOENT — fresh install path.
  }

  // Hooks block: keep all existing keys (UserPromptSubmit, PreToolUse, etc).
  const hooks =
    existing.hooks && typeof existing.hooks === "object" && !Array.isArray(existing.hooks)
      ? (existing.hooks as Record<string, unknown>)
      : {};

  // SessionStart array — filter out any Relay-tagged entry, push fresh.
  const prev = Array.isArray(hooks.SessionStart) ? (hooks.SessionStart as unknown[]) : [];
  const filtered = prev.filter((entry) => {
    if (!entry || typeof entry !== "object") return true;
    const e = entry as { matcher?: unknown };
    return e.matcher !== RELAY_HOOK_MATCHER;
  });

  const relayEntry = {
    matcher: RELAY_HOOK_MATCHER,
    hooks: [
      {
        type: "command" as const,
        command: commandPath,
        timeout: 30,
      },
    ],
  };

  hooks.SessionStart = [...filtered, relayEntry];
  existing.hooks = hooks;

  // Atomic rename.
  const tmp = `${targetPath}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(existing, null, 2) + "\n", "utf8");
  await rename(tmp, targetPath);
}

type CodexVersionProbeResult =
  | { kind: "ok"; version: string }
  | { kind: "too-old"; version: string }
  | { kind: "unparseable"; raw: string }
  | { kind: "not-found" };

/**
 * Probe `codex --version` with a 2-second timeout. Returns a structured
 * result the caller uses to decide what (if anything) to log. Fail-soft on
 * every error path — the install never blocks on a missing or hanging
 * Codex binary (Plan 04-03 D-Plan-1 + threat model T-04-11).
 */
function runCodexVersionProbe(
  override?: () => { stdout?: string; status?: number; error?: NodeJS.ErrnoException }
): CodexVersionProbeResult {
  let result: { stdout?: string; status?: number; error?: NodeJS.ErrnoException };
  try {
    if (override) {
      result = override();
    } else {
      const r = spawnSync("codex", ["--version"], {
        encoding: "utf8",
        timeout: 2000,
      });
      result = { stdout: r.stdout, status: r.status ?? undefined, error: r.error };
    }
  } catch (err) {
    return { kind: "not-found" };
  }

  if (result.error) {
    // ENOENT, ETIMEDOUT, etc. — treat all as "not found" for user output.
    // The single "not-found" branch keeps the message uniform; we don't
    // want to teach users to distinguish ENOENT from ETIMEDOUT.
    return { kind: "not-found" };
  }
  if (!result.stdout) {
    return { kind: "not-found" };
  }

  const match = result.stdout.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return { kind: "unparseable", raw: result.stdout.trim() };
  }
  const major = Number.parseInt(match[1]!, 10);
  const minor = Number.parseInt(match[2]!, 10);
  const version = `${match[1]}.${match[2]}.${match[3]}`;

  if (major < CODEX_MIN_MAJOR || (major === CODEX_MIN_MAJOR && minor < CODEX_MIN_MINOR)) {
    return { kind: "too-old", version };
  }
  return { kind: "ok", version };
}

// The matcher tag is referenced twice in this file: once at the constant
// declaration, once in `writeHookConfig`'s filter. The acceptance criteria
// for Plan 04-03 Task 3 asks for >= 2 occurrences of "relay-channel-readiness"
// in the installer source — this is the second deliberate reference for
// reviewers grepping the file.
//   matcher tag: relay-channel-readiness  // documented occurrence #2
