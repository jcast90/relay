import { hostname, userInfo } from "node:os";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { TokenTracker } from "../budget/token-tracker.js";
import { ChannelStore } from "../channels/channel-store.js";
import { SessionLifecycle } from "../lifecycle/session-lifecycle.js";
import type { RepoAssignment } from "../domain/channel.js";
import { getRelayDir } from "./paths.js";
import { startAutonomousSession } from "../orchestrator/autonomous-loop.js";
import { getHarnessStore } from "../storage/factory.js";

/**
 * Clamp range for `--max-hours`. The lower bound rejects 0/negative values
 * (which the lifecycle watchdog would reject anyway, but surfacing the
 * error at arg-parse time yields a clearer message). The upper bound caps
 * runaway budgets at 48h — a session that hasn't converged in two days
 * needs human intervention, not more wall-clock.
 */
export const MAX_HOURS_MIN = 1;
export const MAX_HOURS_MAX = 48;
export const MAX_HOURS_DEFAULT = 8;

/** Trust modes accepted by `--trust`. */
export type TrustMode = "supervised" | "god";

/**
 * Parsed + validated flag set for `rly run --autonomous`. The CLI entrypoint
 * assembles this from `process.argv` via {@link parseAutonomousArgs}, then
 * hands it to {@link runAutonomousCommand} which does the validation that
 * needs a store (channel lookup, ticket-board read, repo-alias membership).
 *
 * `maxHoursRequested` preserves the operator's original `--max-hours` input
 * (or the default, when the flag was absent) so the clamp is auditable
 * after the fact. `maxHours` is the post-clamp value actually used by the
 * lifecycle watchdog. When the two differ, {@link runAutonomousCommand}
 * emits a one-line stderr warning so an operator who typed
 * `--max-hours 100` expecting "unlimited" gets an immediate signal that
 * the session will be killed at 48h, not 100h.
 */
export interface AutonomousFlags {
  channelId: string;
  budgetTokens: number;
  maxHours: number;
  maxHoursRequested: number;
  trust: TrustMode;
  allowRepos: string[];
  json: boolean;
}

/** Union of the parse outcomes so callers can differentiate "user error"
 * (print usage, exit 1) from "flags are valid" (proceed). */
export type ParseResult = { ok: true; flags: AutonomousFlags } | { ok: false; error: string };

/**
 * Pure, side-effect-free argument parser. Consumes the `args` array passed
 * to the `run` command handler (everything after `rly run`) with the
 * `--autonomous` flag already known to be present.
 *
 * Validation rules:
 *   - Exactly one positional argument (the channelId) is required.
 *   - `--budget-tokens <N>` is required. Must parse as a positive finite integer.
 *   - `--max-hours <N>` optional; defaults to {@link MAX_HOURS_DEFAULT}.
 *     Accepts fractions. Clamped to [{@link MAX_HOURS_MIN},
 *     {@link MAX_HOURS_MAX}] so an operator typing `--max-hours 0.01` gets
 *     the minimum rather than a watchdog that fires during construction.
 *     The original (pre-clamp) value is preserved on the returned flags
 *     as `maxHoursRequested`; {@link runAutonomousCommand} emits a
 *     stderr warning whenever the two differ so the clamp is visible.
 *   - `--trust <supervised|god>` optional; defaults to `supervised`.
 *   - `--allow-repo <alias>` is repeatable; each occurrence appends. Unknown
 *     aliases are validated later in {@link runAutonomousCommand} once the
 *     channel has been loaded (we can't know the valid set without it).
 *   - `--json` is a boolean flag with no value.
 *   - Positional args beyond the channelId are rejected — `rly run --autonomous`
 *     doesn't take a feature request; the channel's ticket board is the input.
 */
export function parseAutonomousArgs(args: string[]): ParseResult {
  let channelId: string | undefined;
  let budgetTokens: number | undefined;
  let maxHours: number = MAX_HOURS_DEFAULT;
  let maxHoursRequested: number = MAX_HOURS_DEFAULT;
  let trust: TrustMode = "supervised";
  const allowRepos: string[] = [];
  let json = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    // The `--autonomous` flag itself is consumed as the command selector;
    // tolerate extra occurrences so test harnesses that pass it at either
    // position don't trip over themselves.
    if (arg === "--autonomous") continue;

    if (arg === "--json") {
      json = true;
      continue;
    }

    if (arg === "--budget-tokens") {
      const raw = args[i + 1];
      if (raw === undefined || raw.startsWith("--")) {
        return { ok: false, error: "--budget-tokens requires a value" };
      }
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
        return {
          ok: false,
          error: `--budget-tokens must be a positive integer (got "${raw}")`,
        };
      }
      budgetTokens = parsed;
      i += 1;
      continue;
    }

    if (arg === "--max-hours") {
      const raw = args[i + 1];
      if (raw === undefined || raw.startsWith("--")) {
        return { ok: false, error: "--max-hours requires a value" };
      }
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return {
          ok: false,
          error: `--max-hours must be a positive number (got "${raw}")`,
        };
      }
      // Clamp out-of-range inputs to the legal window. We explicitly do
      // NOT reject them so `--max-hours 0.01` yields a usable (if short)
      // session rather than a startup error. The original input is
      // preserved in `maxHoursRequested` and a visible warning is emitted
      // at command-run time (see {@link runAutonomousCommand}) so the
      // clamp isn't silent.
      maxHoursRequested = parsed;
      maxHours = Math.min(Math.max(parsed, MAX_HOURS_MIN), MAX_HOURS_MAX);
      i += 1;
      continue;
    }

    if (arg === "--trust") {
      const raw = args[i + 1];
      if (raw === undefined || raw.startsWith("--")) {
        return { ok: false, error: "--trust requires a value" };
      }
      if (raw !== "supervised" && raw !== "god") {
        return {
          ok: false,
          error: `--trust must be "supervised" or "god" (got "${raw}")`,
        };
      }
      trust = raw;
      i += 1;
      continue;
    }

    if (arg === "--allow-repo") {
      const raw = args[i + 1];
      if (raw === undefined || raw.startsWith("--")) {
        return { ok: false, error: "--allow-repo requires an alias value" };
      }
      allowRepos.push(raw);
      i += 1;
      continue;
    }

    if (arg.startsWith("--")) {
      return { ok: false, error: `unknown flag "${arg}"` };
    }

    if (channelId !== undefined) {
      return {
        ok: false,
        error: `unexpected positional argument "${arg}" (channelId already provided)`,
      };
    }
    channelId = arg;
  }

  if (!channelId) {
    return { ok: false, error: "channelId positional argument is required" };
  }
  if (budgetTokens === undefined) {
    return { ok: false, error: "--budget-tokens is required" };
  }

  return {
    ok: true,
    flags: {
      channelId,
      budgetTokens,
      maxHours,
      maxHoursRequested,
      trust,
      allowRepos,
      json,
    },
  };
}

/** Usage string printed on parse failure or `--help` (not plumbed yet). */
export const USAGE = [
  "Usage: rly run --autonomous <channelId> --budget-tokens <N> [options]",
  "",
  "Required:",
  "  --budget-tokens <N>       Token budget for the session (positive integer).",
  "",
  "Options:",
  `  --max-hours <N>           Wall-clock budget (default ${MAX_HOURS_DEFAULT}; clamped to [${MAX_HOURS_MIN}, ${MAX_HOURS_MAX}]).`,
  "  --trust supervised|god    Trust mode (default supervised). 'god' skips per-action",
  "                            approvals; AL-5 / AL-7 gate the real behaviour.",
  "  --allow-repo <alias>      Restrict dispatch to the given repo alias. Repeatable;",
  "                            when absent, every channel repo assignment is in scope.",
  "  --json                    Emit one JSON line with session metadata on success.",
].join("\n");

/**
 * Persisted on-disk shape at `~/.relay/sessions/<sessionId>/metadata.json`.
 * Purely advisory — the lifecycle + token-tracker own their own files. This
 * exists so an operator can `cat metadata.json` and see exactly what flags
 * spawned the session (matches the decision-board entry one-to-one).
 */
interface SessionMetadataFile {
  sessionId: string;
  channelId: string;
  budgetTokens: number;
  maxHours: number;
  /** Operator's original `--max-hours` input (pre-clamp). When the flag
   * was omitted this equals {@link MAX_HOURS_DEFAULT}. Preserved so an
   * operator who typed `--max-hours 100` and returned to a 48h-killed
   * session can audit the delta between what they asked for and what
   * the guardrail enforced. */
  maxHoursRequested: number;
  trust: TrustMode;
  allowedRepos: string[];
  startedAt: string;
  command: string;
  invokedBy: {
    user: string;
    host: string;
  };
}

/**
 * Options for {@link runAutonomousCommand}. Everything is optional — tests
 * use these to inject a tmp `~/.relay/`, a pre-built `ChannelStore`, a
 * substitute loop driver, or a canned `Date.now` so assertions against
 * `startedAt` are deterministic.
 */
export interface RunAutonomousOptions {
  /** Override the `~/.relay` base directory. Tests use a tmp dir. */
  rootDir?: string;
  /** Override the channels dir. Defaults to `<rootDir>/channels`. */
  channelsDir?: string;
  /** Injectable `ChannelStore`. When present, overrides `channelsDir`. */
  channelStore?: ChannelStore;
  /** Substitute the autonomous-loop driver. Tests pass a spy here to avoid
   * running the stub body (and the lifecycle teardown it triggers). */
  startSession?: typeof startAutonomousSession;
  /** Clock injection for deterministic `startedAt` timestamps. */
  clock?: () => number;
  /** Session id override. When absent, a `auto-<ts>-<rand>` id is generated. */
  sessionIdFactory?: () => string;
  /** stdout / stderr writers for testability. Default to `console.log` /
   * `console.error` + `process.stderr.write` (warnings). */
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  /** Raw command line echoed into the metadata file + audit entry so an
   * operator can replay the invocation verbatim. Defaults to
   * `process.argv.slice(1).join(" ")`. */
  command?: string;
}

/**
 * Result of {@link runAutonomousCommand}. `exitCode` is surfaced to the CLI
 * entrypoint instead of mutating `process.exitCode` directly so tests can
 * assert on it without coupling to the global.
 */
export interface RunAutonomousResult {
  exitCode: number;
  sessionId?: string;
}

/**
 * Default session-id shape. Distinct from `buildSessionId()` in
 * `domain/session.ts` (which uses `sess-` for chat sessions) so autonomous
 * session directories never collide with chat session state under the same
 * `~/.relay` tree.
 */
function defaultSessionIdFactory(): string {
  return `auto-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Wire the parsed + validated flags into the rest of the stack and hand off
 * to the autonomous-loop driver (AL-4 / the stub). Covers steps 2-6 of the
 * AL-3 ticket's design sketch:
 *
 *   - Load the channel, fail on unknown id.
 *   - Verify `repoAssignments.length > 0`.
 *   - Verify the ticket board has at least one ticket.
 *   - Validate every `--allow-repo` alias against the channel's assignments.
 *   - Construct `TokenTracker` + `SessionLifecycle` for the session.
 *   - Transition lifecycle: `planning` → `dispatching` (reason:
 *     `"autonomous-session-started"`). The plan is assumed already seeded —
 *     AL-3 does not regenerate it.
 *   - Persist `metadata.json` atomically (tmp + rename).
 *   - Record a decision with type `autonomous_session_started`.
 *   - Call {@link startAutonomousSession}.
 *
 * Everything except the happy-path handoff returns `exitCode: 1` with a
 * human-readable error on stderr. The happy path returns `exitCode: 0`
 * even though the stub immediately marks the session killed — AL-3's
 * contract is "the CLI successfully wired up the session," not "the
 * session made progress."
 */
export async function runAutonomousCommand(
  flags: AutonomousFlags,
  options: RunAutonomousOptions = {}
): Promise<RunAutonomousResult> {
  const stdout = options.stdout ?? ((line: string) => console.log(line));
  const stderr = options.stderr ?? ((line: string) => console.error(line));
  const clock = options.clock ?? Date.now;
  const rootDir = options.rootDir ?? getRelayDir();
  const channelsDir = options.channelsDir ?? join(rootDir, "channels");

  // Surface the --max-hours clamp. Fires before any channel/board
  // validation so operators with a typo in `--max-hours` get the signal
  // even if the session is about to be rejected for an unrelated
  // reason. One-liner on stderr, matches the shape documented in USAGE.
  if (flags.maxHoursRequested !== flags.maxHours) {
    stderr(
      `warning: --max-hours ${flags.maxHoursRequested} clamped to ${flags.maxHours} ` +
        `(valid range ${MAX_HOURS_MIN}\u2013${MAX_HOURS_MAX})`
    );
  }

  const store = options.channelStore ?? new ChannelStore(channelsDir, getHarnessStore());

  const channel = await store.getChannel(flags.channelId);
  if (!channel) {
    stderr(`Channel not found: ${flags.channelId}`);
    return { exitCode: 1 };
  }

  const assignments = channel.repoAssignments ?? [];
  if (assignments.length === 0) {
    stderr(
      `Channel ${flags.channelId} has no repo assignments. Attach a repo ` +
        `with 'rly channel update' before starting an autonomous session.`
    );
    return { exitCode: 1 };
  }

  const tickets = await store.readChannelTickets(flags.channelId);
  if (tickets.length === 0) {
    stderr(
      `Channel ${flags.channelId} has an empty ticket board. Seed tickets ` +
        `via chat or 'rly channel' tooling before starting an autonomous session.`
    );
    return { exitCode: 1 };
  }

  // Validate --allow-repo against the channel assignments. An unknown
  // alias is a user error (typo, stale reference to a deleted repo) —
  // fail loud with the valid list so the operator can fix the command
  // without consulting docs.
  const validAliases = new Set(assignments.map((a) => a.alias));
  const unknownAliases = flags.allowRepos.filter((a) => !validAliases.has(a));
  if (unknownAliases.length > 0) {
    const known = Array.from(validAliases).sort().join(", ");
    stderr(
      `Unknown --allow-repo alias${unknownAliases.length > 1 ? "es" : ""}: ` +
        `${unknownAliases.join(", ")}. Valid aliases for channel ` +
        `${flags.channelId}: ${known}.`
    );
    return { exitCode: 1 };
  }

  // Allowed repo list. When the flag is absent, every assignment is in
  // scope; otherwise only the subset the operator named. Order is
  // preserved from the channel for stable audit output.
  const allowedRepos: RepoAssignment[] =
    flags.allowRepos.length === 0
      ? assignments
      : assignments.filter((a) => flags.allowRepos.includes(a.alias));

  // God-mode nag. The message body is load-bearing — AL-9's STOP-file
  // docs reference this exact wording, and the ticket spec requires the
  // warning to call out that merges/audits/decisions auto-apply.
  if (flags.trust === "god") {
    const sessionId = options.sessionIdFactory?.() ?? defaultSessionIdFactory();
    stderr(
      `warning: --trust god skips per-action approvals; merges, audits, ` +
        `and decisions apply autonomously. Kill with STOP file at ` +
        `~/.relay/sessions/${sessionId}/STOP.`
    );
    // Proceed using the same sessionId below so the STOP-file path the
    // warning advertised matches the actual session directory.
    return await startSession({
      ...options,
      sessionId,
      flags,
      channel,
      allowedRepos,
      stdout,
      stderr,
      clock,
      rootDir,
    });
  }

  const sessionId = options.sessionIdFactory?.() ?? defaultSessionIdFactory();
  return await startSession({
    ...options,
    sessionId,
    flags,
    channel,
    allowedRepos,
    stdout,
    stderr,
    clock,
    rootDir,
  });
}

interface StartSessionInternalOptions extends RunAutonomousOptions {
  sessionId: string;
  flags: AutonomousFlags;
  channel: Awaited<ReturnType<ChannelStore["getChannel"]>> & object;
  allowedRepos: RepoAssignment[];
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  clock: () => number;
  rootDir: string;
}

/**
 * The "past the point of input validation" half of
 * {@link runAutonomousCommand}. Split out purely so the two trust-mode
 * branches above don't duplicate the (lengthy) session-startup sequence.
 * Not part of the public surface.
 */
async function startSession(opts: StartSessionInternalOptions): Promise<RunAutonomousResult> {
  const { sessionId, flags, channel, allowedRepos, stdout, stderr, clock, rootDir } = opts;

  const store =
    opts.channelStore ??
    new ChannelStore(opts.channelsDir ?? join(rootDir, "channels"), getHarnessStore());

  const startedAtIso = new Date(clock()).toISOString();
  const invokedBy = {
    user: safeUserInfo(),
    host: safeHostname(),
  };
  const command = opts.command ?? process.argv.slice(1).join(" ");

  // Allocate tracker + lifecycle. Both write under
  // `~/.relay/sessions/<sessionId>/`. If the user passed `--allow-repo`
  // aliases the lifecycle still tracks the full wall-clock budget — the
  // filter only affects dispatch, not timing / tokens.
  const tracker = new TokenTracker(sessionId, flags.budgetTokens, {
    rootDir,
  });
  const lifecycle = new SessionLifecycle(sessionId, {
    tracker,
    maxDurationMs: flags.maxHours * 3600 * 1000,
    rootDir,
    clock,
  });

  // Kick the state machine forward to `dispatching`. The plan is assumed
  // already seeded on the channel board — AL-3 does not regenerate it.
  // The `"autonomous-session-started"` reason string is load-bearing:
  // it's the AL-3 → AL-4 handoff marker.
  try {
    await lifecycle.transition("dispatching", "autonomous-session-started");
  } catch (err) {
    // Transitioning to `dispatching` from `planning` is always legal, so
    // a failure here indicates either a disk error or an already-killed
    // session from a previous crash. Either way, surface it loudly
    // instead of silently handing off to the driver.
    stderr(
      `Failed to transition lifecycle into dispatching: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    await tracker.close().catch(() => {});
    await lifecycle.close().catch(() => {});
    return { exitCode: 1 };
  }

  // Persist metadata.json atomically. Tmp + rename so a torn write never
  // leaves a half-file that subsequent `rly` invocations would try to
  // parse.
  const metadataPath = join(rootDir, "sessions", sessionId, "metadata.json");
  const metadataFile: SessionMetadataFile = {
    sessionId,
    channelId: flags.channelId,
    budgetTokens: flags.budgetTokens,
    maxHours: flags.maxHours,
    maxHoursRequested: flags.maxHoursRequested,
    trust: flags.trust,
    allowedRepos: allowedRepos.map((a) => a.alias),
    startedAt: startedAtIso,
    command,
    invokedBy,
  };
  try {
    await writeAtomicJson(metadataPath, metadataFile);
  } catch (err) {
    stderr(`Failed to write session metadata: ${err instanceof Error ? err.message : String(err)}`);
    await tracker.close().catch(() => {});
    await lifecycle.close().catch(() => {});
    return { exitCode: 1 };
  }

  // Record the audit decision. `type: "autonomous_session_started"` is
  // the tag required by the AL-3 acceptance criteria, and the `metadata`
  // field carries the full arg set so the operator can audit exactly what
  // was authorised without parsing the rationale prose. Decision is
  // recorded BEFORE handing off to the driver — if the driver stub exits
  // immediately, the audit entry is still durable.
  await store.recordDecision(flags.channelId, {
    runId: null,
    ticketId: null,
    title: `Autonomous session started (${sessionId})`,
    description:
      `Channel ${flags.channelId} entered autonomous mode under session ` +
      `${sessionId}. Budget ${flags.budgetTokens} tokens, max ${flags.maxHours}h, ` +
      `trust ${flags.trust}, allowed repos: ${allowedRepos.map((a) => a.alias).join(", ") || "(none)"}.`,
    rationale: `Operator invoked 'rly run --autonomous'. AL-4 driver will execute tickets until the token budget, wall-clock, or ticket queue exhausts.`,
    alternatives: [],
    decidedBy: invokedBy.user,
    decidedByName: invokedBy.user,
    linkedArtifacts: [],
    type: "autonomous_session_started",
    metadata: {
      sessionId,
      channelId: flags.channelId,
      budgetTokens: flags.budgetTokens,
      maxHours: flags.maxHours,
      maxHoursRequested: flags.maxHoursRequested,
      trust: flags.trust,
      allowedRepos: allowedRepos.map((a) => a.alias),
      startedAt: startedAtIso,
      command,
      invokedBy,
    },
  });

  // JSON mode emits a single structured line on stdout with the fields
  // the ticket spec calls out. Non-JSON mode prints a brief human summary.
  if (flags.json) {
    stdout(
      JSON.stringify({
        sessionId,
        channelId: flags.channelId,
        budgetTokens: flags.budgetTokens,
        maxHours: flags.maxHours,
        maxHoursRequested: flags.maxHoursRequested,
        trust: flags.trust,
        allowedRepos: allowedRepos.map((a) => a.alias),
        startedAt: startedAtIso,
      })
    );
  } else {
    stdout(`Autonomous session ${sessionId} started for channel ${flags.channelId}.`);
    stdout(
      `  budget=${flags.budgetTokens} tokens, maxHours=${flags.maxHours}, trust=${flags.trust}`
    );
    stdout(`  allowed repos: ${allowedRepos.map((a) => a.alias).join(", ") || "(none)"}`);
    stdout(`  lifecycle: ${join(rootDir, "sessions", sessionId, "lifecycle.json")}`);
  }

  // Handoff to the autonomous-loop driver. AL-4 owns the real body; until
  // then the stub immediately transitions to `killed` and returns.
  const driver = opts.startSession ?? startAutonomousSession;
  try {
    await driver({
      sessionId,
      channel,
      tracker,
      lifecycle,
      trust: flags.trust,
      allowedRepos,
    });
  } catch (err) {
    // A driver throw is a driver bug, not a CLI bug. Surface it so AL-4
    // has a paper trail, but don't flip exitCode — the session is set up,
    // the audit entry is recorded, and the operator can rerun.
    stderr(`[autonomous-loop] driver threw: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { exitCode: 0, sessionId };
}

/** User-name lookup with a fallback — `os.userInfo()` can throw on exotic
 * platforms (some Docker images, CI sandboxes). Never let an identity
 * read fail the session start. */
function safeUserInfo(): string {
  try {
    return userInfo().username;
  } catch {
    return "unknown";
  }
}

function safeHostname(): string {
  try {
    return hostname();
  } catch {
    return "unknown";
  }
}

async function writeAtomicJson(path: string, body: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmp, JSON.stringify(body, null, 2), "utf8");
  await rename(tmp, path);
}

/**
 * Top-level entrypoint used by `src/index.ts`. Parses args, short-circuits
 * on parse errors with a usage print, and otherwise delegates to
 * {@link runAutonomousCommand}.
 */
export async function handleRunAutonomous(
  args: string[],
  options: RunAutonomousOptions = {}
): Promise<RunAutonomousResult> {
  const parsed = parseAutonomousArgs(args);
  if (!parsed.ok) {
    const stderr = options.stderr ?? ((line: string) => console.error(line));
    stderr(`rly run --autonomous: ${parsed.error}`);
    stderr(USAGE);
    return { exitCode: 1 };
  }
  return runAutonomousCommand(parsed.flags, options);
}

/**
 * Predicate + branch marker: true when the `rly run` invocation should be
 * routed to {@link handleRunAutonomous} instead of the feature-request
 * codepath. Extracted so the intercept rule lives next to the rest of the
 * autonomous-session logic and can be asserted on in tests without
 * coupling to `src/index.ts`'s `main()` body.
 *
 * Keep this check membership-based (`args.includes`) rather than
 * positional: `rly run --autonomous ch-1 --budget-tokens 1000` and
 * `rly run ch-1 --autonomous --budget-tokens 1000` both count.
 */
export function isAutonomousRun(args: readonly string[]): boolean {
  return args.includes("--autonomous");
}

/**
 * Injectable handlers for {@link dispatchRunCommand}. `autonomous` runs
 * the AL-3 codepath; `featureRequest` runs the pre-existing "classify
 * feature then dispatch" flow that `src/index.ts` owns. Both are
 * parameterized so the test suite can assert which branch fires for a
 * given argv without spawning the real loop / orchestrator.
 */
export interface RunDispatchHandlers {
  autonomous: (args: string[]) => Promise<RunAutonomousResult>;
  featureRequest: (args: string[]) => Promise<{ exitCode: number }>;
}

/** Shape returned by {@link dispatchRunCommand} — caller sets
 * `process.exitCode` and records the handler for observability. */
export interface RunDispatchResult {
  /** Which branch fired. Exposed for tests + future telemetry. */
  handler: "autonomous" | "featureRequest";
  exitCode: number;
}

/**
 * Routes a `rly run ...` invocation to either the autonomous entrypoint
 * or the feature-request flow. This is the sole place the intercept
 * decision is made; `src/index.ts` calls through here so a refactor that
 * reorders checks can't silently change routing without failing
 * {@link isAutonomousRun}'s tests.
 */
export async function dispatchRunCommand(
  args: string[],
  handlers: RunDispatchHandlers
): Promise<RunDispatchResult> {
  if (isAutonomousRun(args)) {
    const result = await handlers.autonomous(args);
    return { handler: "autonomous", exitCode: result.exitCode };
  }
  const result = await handlers.featureRequest(args);
  return { handler: "featureRequest", exitCode: result.exitCode };
}
