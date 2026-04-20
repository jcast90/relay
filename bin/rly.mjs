#!/usr/bin/env node
// rly — Relay CLI launcher.
//
// Default path: run the current TypeScript source via tsx, so the CLI always
// picks up edits without a rebuild. A single child-process hop (~80 ms) keeps
// startup snappy while giving zero-maintenance development.
//
// Fast path: set `RELAY_USE_DIST=1` to run the pre-built `dist/cli.js` in
// the same process. Stale if you haven't `rly rebuild` / `pnpm build` since
// the last source change, but avoids the tsx subprocess.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = fileURLToPath(import.meta.url);
const root = resolve(dirname(here), "..");
const srcEntry = resolve(root, "src/cli.ts");
const distEntry = resolve(root, "dist/cli.js");

if (process.env.RELAY_USE_DIST === "1" && existsSync(distEntry)) {
  await import(pathToFileURL(distEntry).href);
  process.exit(process.exitCode ?? 0);
}

// tsx must be loaded with --import, not the deprecated --loader hook, so we
// run it as a child process. Resolving the binary from node_modules/.bin
// keeps us from depending on the user's PATH.
const tsxBin = resolve(root, "node_modules/.bin/tsx");
if (!existsSync(tsxBin)) {
  console.error(
    "[rly] tsx binary not found at " +
      tsxBin +
      ". Run `pnpm install` in " +
      root +
      " to restore dependencies, or set RELAY_USE_DIST=1 to use the compiled dist."
  );
  process.exit(1);
}

const child = spawn(tsxBin, [srcEntry, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 0);
  }
});

child.on("error", (err) => {
  console.error("[rly] failed to launch tsx: " + err.message);
  process.exit(1);
});
