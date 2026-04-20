import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { launchInteractiveCommand } from "./launcher.js";

/**
 * Resolve the Relay repo root from this module's dist location.
 *
 *   dist/cli/launch-gui-tui.js  ->  ../..  ->  repo root
 */
function resolveRepoRoot(): string {
  return fileURLToPath(new URL("../..", import.meta.url));
}

async function runTool(
  command: string,
  args: string[],
  cwd: string
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

async function requireCargo(): Promise<void> {
  const exitCode = await new Promise<number>((resolve) => {
    const child = spawn("cargo", ["--version"], { stdio: "ignore" });
    child.on("error", () => resolve(127));
    child.on("close", (code) => resolve(code ?? 1));
  });
  if (exitCode !== 0) {
    throw new Error(
      "cargo not found on PATH. Install via https://rustup.rs (or `brew install rustup` on macOS) and re-run."
    );
  }
}

/**
 * Launch the ratatui TUI. If the release binary isn't built yet, build it
 * first (prints cargo output so the user sees progress). Works from any cwd
 * because the binary path is resolved from this module's location.
 */
export async function launchTui(userCwd: string): Promise<number> {
  const repoRoot = resolveRepoRoot();
  // Cargo workspace puts all member outputs in <root>/target, not
  // <root>/tui/target — even when building via `pnpm tui:build` which cd's
  // into tui/, cargo walks up to the workspace root.
  const tuiBinary = join(repoRoot, "target", "release", "relay-tui");

  if (!existsSync(tuiBinary)) {
    console.log("[rly tui] building release binary (first run — takes ~1 min)…");
    await requireCargo();
    const buildExit = await runTool(
      "cargo",
      ["build", "--release", "-p", "relay-tui"],
      repoRoot
    );
    if (buildExit !== 0) {
      console.error("[rly tui] build failed — aborting launch.");
      return buildExit;
    }
  }

  const claudeBin = process.env.CLAUDE_BIN ?? "claude";
  return launchInteractiveCommand({
    command: tuiBinary,
    args: [],
    cwd: userCwd,
    env: { CLAUDE_BIN: claudeBin }
  });
}

export interface LaunchGuiOptions {
  /** `true` → run `pnpm gui:dev` instead of opening the bundled app. */
  dev?: boolean;
  /** Skip the bundle check and force a rebuild. */
  rebuild?: boolean;
}

/**
 * Launch the Tauri desktop app. In prod mode (default) we build once, then
 * `open` the .app bundle as a detached window so the shell returns
 * immediately. Dev mode keeps `pnpm gui:dev` attached to this terminal with
 * hot reload.
 */
export async function launchGui(options: LaunchGuiOptions = {}): Promise<number> {
  const repoRoot = resolveRepoRoot();

  if (options.dev) {
    return runTool("pnpm", ["gui:dev"], repoRoot);
  }

  if (process.platform !== "darwin") {
    console.error(
      "[rly gui] prod launch is currently implemented for macOS only. " +
        "Run `rly gui --dev` to use the Tauri dev flow, or build manually " +
        `with \`cd ${repoRoot}/gui && pnpm tauri build\` and launch the ` +
        "produced bundle."
    );
    return 1;
  }

  // Cargo workspace target, same as relay-tui — gui/src-tauri is a workspace
  // member, so Tauri's bundle lands under <root>/target, not
  // <root>/gui/src-tauri/target.
  const appPath = join(
    repoRoot,
    "target",
    "release",
    "bundle",
    "macos",
    "Relay.app"
  );

  if (options.rebuild || !existsSync(appPath)) {
    console.log(
      "[rly gui] building release bundle (first run — takes ~2-3 min)…"
    );
    await requireCargo();
    const buildExit = await runTool("pnpm", ["gui:build"], repoRoot);
    if (buildExit !== 0) {
      console.error("[rly gui] build failed — aborting launch.");
      return buildExit;
    }
  }

  if (!existsSync(appPath)) {
    console.error(
      `[rly gui] expected bundle at ${appPath} after build, but it's missing. ` +
        "Check the build output above."
    );
    return 1;
  }

  // `open` launches the .app and returns immediately; no child stays attached.
  return runTool("open", [appPath], dirname(appPath));
}

export function parseGuiFlags(args: string[]): LaunchGuiOptions {
  const known = new Set(["--dev", "--rebuild"]);
  for (const arg of args) {
    if (arg.startsWith("--") && !known.has(arg)) {
      console.warn(
        `[rly gui] ignoring unknown flag ${arg}. Supported: --dev, --rebuild.`
      );
    }
  }
  return {
    dev: args.includes("--dev"),
    rebuild: args.includes("--rebuild")
  };
}
