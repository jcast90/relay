import { runInstall, type InstallResult } from "../install/installer.js";
import { getSourceVersion, reportDrift, type Surface, SURFACES } from "../install/manifest.js";

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
  errors: string[];
}

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    surfaces: [],
    check: false,
    force: false,
    json: false,
    help: false,
    errors: [],
  };
  for (const raw of args) {
    if (raw === "--help" || raw === "-h") parsed.help = true;
    else if (raw === "--check") parsed.check = true;
    else if (raw === "--force") parsed.force = true;
    else if (raw === "--json") parsed.json = true;
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

async function runCheck(json: boolean): Promise<number> {
  const drift = await reportDrift();
  if (json) {
    console.log(JSON.stringify(drift, null, 2));
    return drift.behind.length === 0 ? 0 : 1;
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
  console.log("");

  // Three buckets the user cares about: nothing installed yet (fresh),
  // installed but stale (behind), or all good (current). The non-zero
  // exits below let scripts run `rly install --check || rly install`
  // cleanly — exit 1 means "do something."
  if (drift.behind.length === 0 && freshSurfaces.length === 0) {
    console.log("All surfaces match source. Nothing to do.");
    return 0;
  }
  if (drift.behind.length === 0) {
    const list = freshSurfaces.join(" ");
    console.log(
      `Not installed: ${list}. Run \`rly install${freshSurfaces.length === SURFACES.length ? "" : ` ${list}`}\` to set up.`
    );
    return 1;
  }
  const list = drift.behind.join(" ");
  console.log(
    `Run \`rly install ${drift.behind.length === SURFACES.length ? "" : list}\` to update.`
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
    return runCheck(parsed.json);
  }

  // Print what we're about to do up-front so the user sees a single header
  // before pnpm/cargo/tauri start streaming their own output.
  const source = await getSourceVersion();
  const targetLabel = parsed.surfaces.length === 0 ? "all surfaces" : parsed.surfaces.join(", ");
  console.log(
    `[rly install] target: ${targetLabel} — source v${source.version}${source.sourceSha ? ` (${source.sourceSha.slice(0, 7)})` : ""}`
  );
  if (parsed.force) console.log("[rly install] --force — will rebuild even when current");

  const results = await runInstall({ surfaces: parsed.surfaces, force: parsed.force });
  return summarize(results);
}
