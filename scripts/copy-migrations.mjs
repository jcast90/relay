#!/usr/bin/env node
/**
 * copy-migrations.mjs
 *
 * The SQL files under `src/storage/migrations/NNN_*.sql` are runtime
 * artifacts, not TypeScript — `tsc` won't emit them into `dist/`. This
 * script copies every non-`.ts` file from the source migrations dir into
 * the matching `dist/` path so the published package can locate them at
 * runtime via `fileURLToPath(import.meta.url)`.
 *
 * Invoked from the `build` script in package.json after `tsc`. Kept out of
 * the build script itself because a one-line `cpSync` in package.json is
 * hostile to read and easy to break silently.
 */
import { cpSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const src = join(repoRoot, "src/storage/migrations");
const dst = join(repoRoot, "dist/storage/migrations");

cpSync(src, dst, {
  recursive: true,
  filter: (path) => !path.endsWith(".ts")
});
