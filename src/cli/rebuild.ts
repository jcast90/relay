import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * Resolve the Relay repo root from this module's location so `rly rebuild`
 * works from any cwd. Mirrors launch-gui-tui.ts — dist/cli/rebuild.js
 * → ../.. is the repo root.
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

export interface RebuildOptions {
  /** Rebuild the TS dist (tsc). Default true when no target flags are set. */
  dist: boolean;
  /** Rebuild the Rust TUI via cargo. */
  tui: boolean;
  /** Rebuild the Tauri GUI bundle. */
  gui: boolean;
}

export function parseRebuildFlags(args: string[]): RebuildOptions {
  const all = args.includes("--all");
  const explicitTui = args.includes("--tui");
  const explicitGui = args.includes("--gui");
  const explicitDist = args.includes("--dist");
  const anyExplicit = explicitTui || explicitGui || explicitDist;

  const known = new Set(["--all", "--tui", "--gui", "--dist"]);
  for (const arg of args) {
    if (arg.startsWith("--") && !known.has(arg)) {
      console.warn(
        `[rly rebuild] ignoring unknown flag ${arg}. Supported: --all, --dist, --tui, --gui.`
      );
    }
  }

  return {
    dist: all || explicitDist || !anyExplicit,
    tui: all || explicitTui,
    gui: all || explicitGui
  };
}

/**
 * Rebuild one or more Relay artifacts. Called from `rly rebuild` in the
 * main CLI dispatch. Prints progress inline; individual step failures
 * short-circuit the remaining steps so the user sees the actual error.
 */
export async function runRebuild(options: RebuildOptions): Promise<number> {
  const repoRoot = resolveRepoRoot();

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
    const exit = await runTool(
      "cargo",
      ["build", "--release", "-p", "relay-tui"],
      repoRoot
    );
    if (exit !== 0) {
      console.error("[rly rebuild] TUI build failed — stopping.");
      return exit;
    }
  }

  if (options.gui) {
    console.log("[rly rebuild] GUI — pnpm gui:build");
    const exit = await runTool("pnpm", ["gui:build"], repoRoot);
    if (exit !== 0) {
      console.error("[rly rebuild] GUI build failed — stopping.");
      return exit;
    }
  }

  console.log("[rly rebuild] done.");
  return 0;
}
