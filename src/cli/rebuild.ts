import { spawn } from "node:child_process";
import { cp, rm, stat } from "node:fs/promises";
import { platform } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolve the Relay repo root from this module's location so `rly rebuild`
 * works from any cwd. Mirrors launch-gui-tui.ts — dist/cli/rebuild.js
 * → ../.. is the repo root.
 */
function resolveRepoRoot(): string {
  return fileURLToPath(new URL("../..", import.meta.url));
}

async function runTool(command: string, args: string[], cwd: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

export interface RebuildOptions {
  /** Rebuild the TS dist (tsc). Default true when no target flags are set. */
  dist: boolean;
  /** Rebuild the Rust TUI via cargo. */
  tui: boolean;
  /** Rebuild the Tauri GUI bundle. */
  gui: boolean;
  /** Skip the up-front `pnpm install`. */
  skipInstall: boolean;
  /**
   * After a successful GUI build on macOS, copy the produced `.app`
   * over `/Applications/Relay.app` so the user's Finder/Dock launch
   * points at the fresh build. Without this, users rebuild happily and
   * then re-launch the stale installed app — the single most common
   * "I updated but nothing changed" footgun. Off on non-darwin
   * platforms and for `--gui`-excluded runs.
   */
  installApp: boolean;
}

export function parseRebuildFlags(args: string[]): RebuildOptions {
  const all = args.includes("--all");
  const explicitTui = args.includes("--tui");
  const explicitGui = args.includes("--gui");
  const explicitDist = args.includes("--dist");
  const anyExplicit = explicitTui || explicitGui || explicitDist;

  const known = new Set([
    "--all",
    "--tui",
    "--gui",
    "--dist",
    "--skip-install",
    "--no-install-app",
  ]);
  for (const arg of args) {
    if (arg.startsWith("--") && !known.has(arg)) {
      console.warn(
        `[rly rebuild] ignoring unknown flag ${arg}. Supported: --all, --dist, --tui, --gui, --skip-install, --no-install-app.`
      );
    }
  }

  return {
    dist: all || explicitDist || !anyExplicit,
    tui: all || explicitTui,
    gui: all || explicitGui,
    skipInstall: args.includes("--skip-install"),
    installApp: !args.includes("--no-install-app"),
  };
}

/**
 * Best-effort request for the running Relay GUI to quit, so we can
 * replace `/Applications/Relay.app` without fighting a mapped binary
 * or an open Finder window. Succeeds silently if Relay isn't running.
 *
 * Uses AppleScript because it also flushes window state / lets the
 * app's own graceful-shutdown hooks fire; a raw `pkill` would leave
 * unsaved state behind.
 */
async function quitRunningRelayApp(): Promise<void> {
  await new Promise<void>((resolve) => {
    const child = spawn("osascript", ["-e", 'tell application "Relay" to quit'], {
      stdio: "ignore",
    });
    // Whether osascript succeeds (quit delivered), fails (not running),
    // or errors (no osascript — unlikely on macOS), we proceed with the
    // copy. The copy itself is the source of truth for failure.
    child.on("close", () => resolve());
    child.on("error", () => resolve());
  });
}

/**
 * Copy the freshly built `.app` bundle over `/Applications/Relay.app`
 * so Finder / Dock / Launchpad point at the new binary. macOS only —
 * Linux and Windows don't have a canonical install location, so the
 * user runs from `target/release/bundle/…` themselves.
 *
 * Returns 0 on success (or when the build didn't produce a bundle we
 * can find — we print a warning but don't fail the rebuild). Non-zero
 * only when the copy itself errors (permissions, disk full).
 */
async function installGuiAppOnMac(repoRoot: string): Promise<number> {
  const builtAppPath = join(repoRoot, "target", "release", "bundle", "macos", "Relay.app");
  try {
    const st = await stat(builtAppPath);
    if (!st.isDirectory()) {
      console.warn(
        `[rly rebuild] expected .app bundle at ${builtAppPath} — skipping install step.`
      );
      return 0;
    }
  } catch {
    console.warn(
      `[rly rebuild] no .app bundle at ${builtAppPath} — skipping install step. The Tauri build may have produced the bundle elsewhere (check tauri.conf.json bundle targets).`
    );
    return 0;
  }

  const installedPath = "/Applications/Relay.app";
  console.log(`[rly rebuild] installing to ${installedPath}`);

  // Ask the running app to quit first — replacing an .app whose
  // binary is currently mapped into a live process "works" on APFS
  // (directory entries get relinked) but the running process keeps
  // executing the old code and any future relaunch from Dock could
  // race the copy. Quitting cleanly avoids both issues.
  await quitRunningRelayApp();

  try {
    await rm(installedPath, { recursive: true, force: true });
    await cp(builtAppPath, installedPath, { recursive: true });
  } catch (err) {
    console.error(
      `[rly rebuild] failed to install ${installedPath}: ${err instanceof Error ? err.message : String(err)}`
    );
    console.error(`[rly rebuild] you can install manually: cp -R "${builtAppPath}" /Applications/`);
    return 1;
  }

  console.log(
    `[rly rebuild] installed. Open /Applications/Relay.app (or Spotlight "Relay") to launch the updated build.`
  );
  return 0;
}

/**
 * Rebuild one or more Relay artifacts. Called from `rly rebuild` in the
 * main CLI dispatch. Prints progress inline; individual step failures
 * short-circuit the remaining steps so the user sees the actual error.
 *
 * Always runs `pnpm install` first unless --skip-install. Cheap when
 * already in sync (~1s no-op); critical right after `git pull` if the
 * merged PRs added new dependencies — otherwise tsc surfaces a
 * "Cannot find module X" and the real fix (re-sync node_modules) is
 * hidden behind what looks like a code bug.
 */
export async function runRebuild(options: RebuildOptions): Promise<number> {
  const repoRoot = resolveRepoRoot();

  if (!options.skipInstall) {
    console.log("[rly rebuild] deps — pnpm install");
    const exit = await runTool("pnpm", ["install"], repoRoot);
    if (exit !== 0) {
      console.error("[rly rebuild] pnpm install failed — stopping.");
      return exit;
    }
  }

  if (options.dist) {
    console.log("[rly rebuild] TS dist — pnpm build");
    const exit = await runTool("pnpm", ["build"], repoRoot);
    if (exit !== 0) {
      console.error("[rly rebuild] dist build failed — stopping.");
      return exit;
    }
  }

  if (options.tui) {
    console.log("[rly rebuild] TUI — cargo build --release -p relay-tui");
    const exit = await runTool("cargo", ["build", "--release", "-p", "relay-tui"], repoRoot);
    if (exit !== 0) {
      console.error("[rly rebuild] TUI build failed — stopping.");
      return exit;
    }
  }

  if (options.gui) {
    // gui/ is its own pnpm project with its own lockfile — it's not part
    // of the root workspace, so a root `pnpm install` never touches it.
    // Without this step, a freshly-added GUI dep surfaces as
    // "Cannot find module '@tauri-apps/plugin-X'" during tsc and the
    // actual fix (install gui deps) is hidden behind what looks like a
    // code bug. Cheap no-op when already in sync.
    if (!options.skipInstall) {
      console.log("[rly rebuild] GUI deps — pnpm install (gui/)");
      const installExit = await runTool("pnpm", ["install"], `${repoRoot}/gui`);
      if (installExit !== 0) {
        console.error("[rly rebuild] GUI pnpm install failed — stopping.");
        return installExit;
      }
    }
    console.log("[rly rebuild] GUI — pnpm gui:build");
    const exit = await runTool("pnpm", ["gui:build"], repoRoot);
    if (exit !== 0) {
      console.error("[rly rebuild] GUI build failed — stopping.");
      return exit;
    }

    // Install the freshly built bundle over /Applications/Relay.app on
    // macOS so Finder/Dock/Spotlight land on the new binary. The old
    // behavior left the built .app in `target/release/bundle/…` and
    // the user re-launched the stale installed app — silently running
    // pre-update code.
    if (options.installApp && platform() === "darwin") {
      const installExit = await installGuiAppOnMac(repoRoot);
      if (installExit !== 0) {
        // Install failure doesn't undo the successful build — tell
        // the user we're done but the copy step needs attention.
        return installExit;
      }
    }
  }

  console.log("[rly rebuild] done.");
  return 0;
}
