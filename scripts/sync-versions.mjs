#!/usr/bin/env node
/**
 * sync-versions.mjs
 *
 * After `pnpm exec changeset version` bumps `package.json`, the rest of the
 * workspace needs to move in lockstep:
 *
 *   - `gui/package.json`          (the Tauri frontend; not published to npm)
 *   - `tui/Cargo.toml`            (relay-tui binary)
 *   - `gui/src-tauri/Cargo.toml`  (relay-gui binary)
 *   - `crates/harness-data/Cargo.toml` (shared Rust crate)
 *
 * Changesets only manages the npm surface. Cargo versions have to be
 * rewritten by hand. This script keeps that from drifting.
 *
 * It is intentionally dependency-free — no `toml` parser, just regex against
 * the `version = "..."` line of each `[package]` table. The Cargo.tomls in
 * this repo all have a single `[package]` table and a top-level `version`
 * field, so this is safe and idempotent.
 *
 * Usage:
 *   node scripts/sync-versions.mjs           # uses package.json version
 *   node scripts/sync-versions.mjs 0.2.0     # pin explicitly
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

const rootPkgPath = join(repoRoot, "package.json");
const rootPkg = JSON.parse(readFileSync(rootPkgPath, "utf8"));

const targetVersion = process.argv[2] ?? rootPkg.version;

if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(targetVersion)) {
  console.error(`[sync-versions] refusing to sync a non-semver version: ${targetVersion}`);
  process.exit(1);
}

function syncJson(relPath) {
  const abs = join(repoRoot, relPath);
  const json = JSON.parse(readFileSync(abs, "utf8"));
  if (json.version === targetVersion) {
    console.log(`[sync-versions] ${relPath} already at ${targetVersion}`);
    return;
  }
  json.version = targetVersion;
  writeFileSync(abs, JSON.stringify(json, null, 2) + "\n");
  console.log(`[sync-versions] ${relPath} -> ${targetVersion}`);
}

function syncCargoToml(relPath) {
  const abs = join(repoRoot, relPath);
  const src = readFileSync(abs, "utf8");
  // Only touch the first `version = "..."` line inside the first [package]
  // table. Cargo.tomls in this repo don't have multiple package tables, but
  // we gate on [package] to avoid ever rewriting a [dependencies] version.
  const pkgHeader = src.indexOf("[package]");
  if (pkgHeader < 0) {
    console.error(`[sync-versions] ${relPath}: no [package] table found`);
    process.exit(1);
  }
  const nextHeader = src.indexOf("\n[", pkgHeader + 1);
  const sliceEnd = nextHeader < 0 ? src.length : nextHeader;
  const head = src.slice(0, pkgHeader);
  const body = src.slice(pkgHeader, sliceEnd);
  const tail = src.slice(sliceEnd);

  const versionLine = /(^|\n)version\s*=\s*"[^"]+"/;
  if (!versionLine.test(body)) {
    console.error(`[sync-versions] ${relPath}: no version line in [package]`);
    process.exit(1);
  }
  const newBody = body.replace(versionLine, `$1version = "${targetVersion}"`);
  if (newBody === body) {
    console.log(`[sync-versions] ${relPath} already at ${targetVersion}`);
    return;
  }
  writeFileSync(abs, head + newBody + tail);
  console.log(`[sync-versions] ${relPath} -> ${targetVersion}`);
}

syncJson("gui/package.json");
syncCargoToml("tui/Cargo.toml");
syncCargoToml("gui/src-tauri/Cargo.toml");
syncCargoToml("crates/harness-data/Cargo.toml");

console.log(`[sync-versions] all workspace versions now at ${targetVersion}`);
