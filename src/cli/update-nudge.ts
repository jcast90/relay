import { reportDrift } from "../install/manifest.js";

/**
 * Commands that should never get an update nudge: the nudge can't tell
 * the user anything they don't already know (or are about to fix), and
 * for `--version`/help paths a stderr line is just noise.
 *
 * `install` is special — the user is already updating, so reminding them
 * to update would be circular.
 */
const SUPPRESS_COMMANDS = new Set([
  "install",
  "version",
  "--version",
  "-v",
  "help",
  "--help",
  "-h",
]);

/**
 * One-time per-process check: did we already print the nudge for this
 * invocation? Some entrypoints (e.g. `rly chat` running multiple sub-
 * commands) could otherwise emit it twice.
 */
let printed = false;

interface NudgeOptions {
  command: string | undefined;
  argv: readonly string[];
}

/**
 * Print a one-line stderr nudge when any installed surface is behind the
 * source on disk. The nudge is best-effort — manifest errors, missing
 * git, or a never-installed Relay all silently no-op rather than risk
 * spamming the user during a routine command.
 *
 * Suppression layers, in order:
 *  - `RELAY_NO_UPDATE_NUDGE=1` env var (user opt-out, persistent).
 *  - Commands listed in `SUPPRESS_COMMANDS` (would be circular or noisy).
 *  - `--json`/`--quiet` flags anywhere in argv (don't pollute structured output).
 *  - stderr not a TTY (don't pollute pipes / CI logs).
 *  - Already printed this process.
 *
 * Caller-supplied command is required so we can suppress on `install`
 * before reading the manifest at all — the I/O cost matters when the
 * user is in a tight loop running `rly status` etc.
 */
export async function maybePrintUpdateNudge(options: NudgeOptions): Promise<void> {
  if (printed) return;
  if (process.env.RELAY_NO_UPDATE_NUDGE === "1") return;
  if (options.command && SUPPRESS_COMMANDS.has(options.command)) return;
  if (options.argv.includes("--json") || options.argv.includes("--quiet")) return;
  if (!process.stderr.isTTY) return;

  let drift: Awaited<ReturnType<typeof reportDrift>>;
  try {
    drift = await reportDrift();
  } catch {
    // Manifest read or git probe failed — skip silently. Better to miss
    // a nudge than to crash a user's workflow with an install-system bug.
    return;
  }
  if (drift.behind.length === 0) return;

  printed = true;
  const list = drift.behind.join(" ");
  // Single line, dim style (ANSI 2 = faint) so it's visible but doesn't
  // compete with the actual command output. Reset at end so the next
  // line of stderr from the command itself isn't dimmed.
  const dim = "[2m";
  const reset = "[0m";
  process.stderr.write(
    `${dim}↻ ${drift.behind.length === 1 ? `${list} is` : `${list} are`} behind source — run \`rly install ${list}\` to update.${reset}\n`
  );
}

/** Test helper — reset the once-per-process printed flag. */
export function __resetUpdateNudgePrintedForTests(): void {
  printed = false;
}
