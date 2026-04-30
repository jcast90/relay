import { chmod, copyFile, mkdir, rename, stat } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { runRebuild } from "../cli/rebuild.js";
import {
  diffSurface,
  getSourceVersion,
  markInstalled,
  readManifest,
  type Surface,
  SURFACES,
} from "./manifest.js";

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
 */
async function atomicInstallBinary(src: string, dst: string): Promise<void> {
  const tmp = `${dst}.${process.pid}.tmp`;
  await mkdir(join(dst, ".."), { recursive: true });
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
  pnpmInstallAlreadyRan: boolean
): Promise<InstallResult> {
  const [manifest, source] = await Promise.all([readManifest(), getSourceVersion()]);
  const record = manifest.surfaces[surface];
  const state = diffSurface(record, source);

  if (!options.force && state === "current") {
    return {
      surface,
      status: "skipped",
      detail: `already at ${source.version}${source.sourceSha ? ` (${source.sourceSha.slice(0, 7)})` : ""}`,
    };
  }

  console.log(`\n[rly install] ▶ ${surface}`);

  // Compose runRebuild's targets so we only build what we're installing.
  // skipInstall is false the first time we run a build in this session
  // and true after — pnpm install is idempotent but a no-op call still
  // costs ~1s, and installing all three would otherwise pay it three times.
  const exit = await runRebuild({
    dist: surface === "cli",
    tui: surface === "tui",
    gui: surface === "gui",
    skipInstall: pnpmInstallAlreadyRan,
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

/**
 * Install one or more surfaces. Surfaces install in fixed order
 * (cli → tui → gui) so a user reading the output sees a predictable
 * progression. Failures short-circuit: if `tui` fails, `gui` doesn't
 * start. The manifest is updated per-surface so a partial install
 * still records what succeeded.
 */
export async function runInstall(options: InstallOptions): Promise<InstallResult[]> {
  const targets = options.surfaces.length === 0 ? [...SURFACES] : options.surfaces;
  // Preserve the canonical cli→tui→gui order even when caller passed
  // them out of order, so output is consistent across invocations.
  const ordered = SURFACES.filter((s) => targets.includes(s));
  const results: InstallResult[] = [];
  let pnpmRan = false;
  for (const surface of ordered) {
    const result = await installOne(surface, options, pnpmRan);
    results.push(result);
    if (result.status === "installed") pnpmRan = true;
    if (result.status === "failed") break;
  }
  return results;
}
