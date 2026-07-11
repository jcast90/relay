import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { installSessionStartHooks, runInstall, type InstallResult } from "../install/installer.js";
import {
  getSourceVersion,
  HOOK_TARGETS,
  type HookTarget,
  readManifest,
  reportDrift,
  reportHookDrift,
  type Surface,
  SURFACES,
} from "../install/manifest.js";
import { generateSessionStartHookScripts } from "../crosslink/hook.js";

const HELP = [
  "Usage: rly install [target] [options]",
  "",
  "Build and install Relay surfaces (CLI dist, TUI binary, GUI .app) so the",
  "installed copies match the source you have checked out. With no target,",
  "installs every surface that's behind. Drives the manifest at",
  "~/.relay/installed.json that the startup nudge reads.",
  "",
  "Targets:",
  "  cli                  TS dist (pnpm build)",
  "  tui                  Rust TUI binary → ~/.cargo/bin/relay-tui (or ~/.local/bin)",
  "  gui                  Tauri GUI → /Applications/Relay.app (macOS only)",
  "  all                  All three (default)",
  "",
  "Options:",
  "  --check              Report drift between source and installed; do not build",
  "  --force              Rebuild + reinstall even when manifest is current",
  "  --json               Machine-readable output (only honored with --check)",
  "  --skip-codex         Skip Codex SessionStart hook + config.toml writes",
  "  --help               Show this message",
  "",
  "Env:",
  "  RELAY_TUI_INSTALL_DIR    Override TUI install dir",
  "  RELAY_NO_UPDATE_NUDGE=1  Suppress the startup nudge in other commands",
].join("\n");

interface ParsedArgs {
  surfaces: Surface[];
  check: boolean;
  force: boolean;
  json: boolean;
  help: boolean;
  /** Plan 04-03: skip writing `~/.codex/hooks.json` and `~/.codex/config.toml`. */
  skipCodex: boolean;
  errors: string[];
}

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    surfaces: [],
    check: false,
    force: false,
    json: false,
    help: false,
    skipCodex: false,
    errors: [],
  };
  for (const raw of args) {
    if (raw === "--help" || raw === "-h") parsed.help = true;
    else if (raw === "--check") parsed.check = true;
    else if (raw === "--force") parsed.force = true;
    else if (raw === "--json") parsed.json = true;
    else if (raw === "--skip-codex") parsed.skipCodex = true;
    else if (raw === "all") {
      // explicit "all" is the same as no surface arg — install everything
    } else if (raw === "cli" || raw === "tui" || raw === "gui") {
      if (!parsed.surfaces.includes(raw)) parsed.surfaces.push(raw);
    } else if (raw.startsWith("-")) {
      parsed.errors.push(`unknown flag: ${raw}`);
    } else {
      parsed.errors.push(`unknown target: ${raw}`);
    }
  }
  return parsed;
}

function formatSurfaceLine(
  surface: Surface,
  state: string,
  recordVersion: string | undefined,
  recordSha: string | null | undefined,
  source: { version: string; sourceSha: string | null }
): string {
  const sourceTag = source.sourceSha ? ` (${source.sourceSha.slice(0, 7)})` : "";
  const installed = recordVersion
    ? `${recordVersion}${recordSha ? ` (${recordSha.slice(0, 7)})` : ""}`
    : "—";
  const symbol = state === "current" ? "✓" : state === "behind" ? "↻" : "·";
  return `  ${symbol} ${surface.padEnd(4)} installed: ${installed.padEnd(20)} source: ${source.version}${sourceTag}`;
}

/**
 * Compute the source SHA for the SessionStart hook node-script body.
 * Runs the generator (idempotent — produces byte-identical output for a
 * fixed relayDir) and hashes the generated `session-start.mjs`. The
 * hash is compared against the manifest's stored hook SHA to detect
 * drift on `~/.claude/settings.json` or `~/.codex/hooks.json`.
 */
async function computeHookSourceSha(): Promise<string> {
  const { nodeScriptPath } = await generateSessionStartHookScripts();
  const body = await readFile(nodeScriptPath, "utf8");
  return createHash("sha256").update(body).digest("hex");
}

async function runCheck(json: boolean, skipCodex: boolean): Promise<number> {
  const drift = await reportDrift();
  const hookSourceSha = await computeHookSourceSha();
  const manifest = await readManifest();
  const hookSources: Partial<Record<HookTarget, { sha: string }>> = {
    claude: { sha: hookSourceSha },
  };
  if (!skipCodex) hookSources.codex = { sha: hookSourceSha };
  const hookDrift = reportHookDrift(manifest, hookSources);
  const hooksBehind = hookDrift.filter((h) => h.state === "behind").map((h) => h.target);
  const hooksFresh = hookDrift.filter((h) => h.state === "fresh").map((h) => h.target);

  if (json) {
    console.log(JSON.stringify({ ...drift, hooks: hookDrift, hookSourceSha }, null, 2));
    return drift.behind.length === 0 && hooksBehind.length === 0 ? 0 : 1;
  }
  const freshSurfaces: Surface[] = [];
  console.log(
    `Source: v${drift.source.version}${drift.source.sourceSha ? ` (${drift.source.sourceSha.slice(0, 7)})` : ""}`
  );
  for (const surface of SURFACES) {
    const { record, state } = drift.surfaces[surface];
    if (state === "fresh") freshSurfaces.push(surface);
    console.log(
      formatSurfaceLine(surface, state, record?.version, record?.sourceSha, drift.source)
    );
  }

  // Per-target hook drift — same vocabulary / symbol set as surfaces.
  for (const entry of hookDrift) {
    const symbol = entry.state === "current" ? "✓" : entry.state === "behind" ? "↻" : "·";
    const installedSha = entry.record?.sha ? `${entry.record.sha.slice(0, 7)}` : "—";
    const stateWord = entry.state === "behind" ? "drifted" : entry.state;
    console.log(
      `  ${symbol} hook:${entry.target.padEnd(6)} installed: ${installedSha.padEnd(20)} (${stateWord})`
    );
  }
  console.log("");

  // Three buckets the user cares about: nothing installed yet (fresh),
  // installed but stale (behind), or all good (current). The non-zero
  // exits below let scripts run `rly install --check || rly install`
  // cleanly — exit 1 means "do something."
  const anyFresh = freshSurfaces.length > 0 || hooksFresh.length > 0;
  const anyBehind = drift.behind.length > 0 || hooksBehind.length > 0;

  if (!anyFresh && !anyBehind) {
    console.log("All surfaces and hooks match source. Nothing to do.");
    return 0;
  }
  if (!anyBehind) {
    const surfaceList = freshSurfaces.join(" ");
    const hookList = hooksFresh.length > 0 ? ` (hooks: ${hooksFresh.join(", ")})` : "";
    console.log(
      `Not installed: ${surfaceList || "(none)"}${hookList}. Run \`rly install${freshSurfaces.length === SURFACES.length ? "" : ` ${surfaceList}`}\` to set up.`
    );
    return 1;
  }
  const list = drift.behind.join(" ");
  const hookSuffix = hooksBehind.length > 0 ? ` (hooks drifted: ${hooksBehind.join(", ")})` : "";
  console.log(
    `Run \`rly install ${drift.behind.length === SURFACES.length ? "" : list}\` to update.${hookSuffix}`
  );
  return 1;
}

function summarize(results: InstallResult[]): number {
  console.log("");
  let failed = 0;
  for (const r of results) {
    const symbol = r.status === "installed" ? "✓" : r.status === "skipped" ? "·" : "✗";
    console.log(`${symbol} ${r.surface}: ${r.status} — ${r.detail}`);
    if (r.status === "failed") failed += 1;
  }
  return failed === 0 ? 0 : 1;
}

export async function handleInstallCommand(args: string[]): Promise<number> {
  const parsed = parseArgs(args);
  if (parsed.help) {
    console.log(HELP);
    return 0;
  }
  if (parsed.errors.length > 0) {
    for (const err of parsed.errors) console.error(`[rly install] ${err}`);
    console.error("");
    console.error(HELP);
    return 2;
  }
  if (parsed.json && !parsed.check) {
    console.error("[rly install] --json is only supported with --check");
    return 2;
  }

  if (parsed.check) {
    return runCheck(parsed.json, parsed.skipCodex);
  }

  // Print what we're about to do up-front so the user sees a single header
  // before pnpm/cargo/tauri start streaming their own output.
  const source = await getSourceVersion();
  const targetLabel = parsed.surfaces.length === 0 ? "all surfaces" : parsed.surfaces.join(", ");
  console.log(
    `[rly install] target: ${targetLabel} — source v${source.version}${source.sourceSha ? ` (${source.sourceSha.slice(0, 7)})` : ""}`
  );
  if (parsed.force) console.log("[rly install] --force — will rebuild even when current");
  if (parsed.skipCodex)
    console.log("[rly install] --skip-codex — Codex hook configs will be skipped");

  const results = await runInstall({ surfaces: parsed.surfaces, force: parsed.force });
  const summarizeExit = summarize(results);

  // Wire SessionStart hooks AFTER the surface install. If a surface install
  // failed, skip the hook step — the user will see the failure summary and
  // re-run after fixing the build. Hook install is cheap and idempotent,
  // so a future retry costs nothing.
  if (summarizeExit === 0) {
    try {
      const hookResult = await installSessionStartHooks({ skipCodex: parsed.skipCodex });
      console.log(
        `[rly install] hooks: claude=installed${hookResult.codex ? ", codex=installed" : ", codex=skipped"}`
      );
    } catch (err) {
      // Best-effort: log the failure but don't fail the whole install. The
      // user can re-run; surface artifacts are already in place.
      console.error(
        `[rly install] hook install failed: ${err instanceof Error ? err.message : String(err)}`
      );
      return 1;
    }
  }
  // HOOK_TARGETS is imported for use by callers that re-import it from
  // this module path (some CLI consumers do this); silence the
  // "unused import" lint by referencing it once here.
  void HOOK_TARGETS;
  return summarizeExit;
}
