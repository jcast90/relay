/**
 * `rly handoff` — generate a handoff brief from channel artifacts and
 * (optionally) seed a fresh session in the destination provider.
 *
 * Three modes (Phase 2 PR-4 / Wave 4):
 *   - `rly handoff <channelId> --to <value>` — STRICT validation (M2),
 *     dispatches a new session in the resolved destination.
 *   - `rly handoff <channelId> --save` — PERMISSIVE validation (secret-only),
 *     persists `<briefId>.{md,gap.json}` to disk, NO dispatch (D-08).
 *   - `rly handoff <channelId> --resume <briefId|latest> --to <value>` — reads
 *     ONLY the saved gap.json (M7), regenerates the deterministic skeleton
 *     from current channel state, dispatches new session.
 *
 * Provider resolution for `--to <value>` (D-03 / RESEARCH §Q15):
 *   1. `ProviderProfileStore.getProfile(value)` — exact profile id.
 *   2. Adapter shorthand: `claude` / `codex` ⇒ default profile for that adapter.
 *   3. Channel repo alias match — picks up the channel's `providerProfileId`
 *      (or default fallback) for that repo.
 *   4. Else: hard error with the three-place fallback message.
 *
 * Independent of `gui/src-tauri/src/lib.rs:start_chat` (Tauri-side spawn idiom
 * AS OF Phase 2 execution — L7). Any later refactor of `start_chat` does not
 * affect this code path; the two converge only at the `claude -p` / `codex
 * exec` argv level.
 */

import { ChannelStore } from "../channels/channel-store.js";
import type { Channel } from "../domain/channel.js";
import type { GapFillBlock, HandoffBrief } from "../domain/handoff.js";
import type { ProviderProfile, ProviderProfileAdapter } from "../domain/provider-profile.js";
import { buildBrief } from "../orchestrator/handoff/synthesizer.js";
import { renderBrief } from "../orchestrator/handoff/render-markdown.js";
import { validateBrief } from "../orchestrator/handoff/validate.js";
import {
  listBriefIds,
  readGapFillByBriefId,
  readLatestGapFill,
  writeBriefArtifact,
} from "../orchestrator/handoff/persistence.js";
import { ProviderProfileStore } from "../storage/provider-profile-store.js";
import { assertSafeSegment } from "../storage/file-store.js";

export interface HandoffSpawnInput {
  adapter: ProviderProfileAdapter;
  profile: ProviderProfile | null;
  channel: Channel;
  briefMarkdown: string;
  cwd: string;
}

export interface HandoffSpawnResult {
  /** Identifier the destination session uses. May be `null` if not captured. */
  newSessionId: string | null;
  /** Free-text label for the destination — printed back to the user. */
  destinationLabel: string;
  /** Adapter actually invoked. */
  adapter: ProviderProfileAdapter;
}

export type HandoffSpawner = (input: HandoffSpawnInput) => Promise<HandoffSpawnResult>;

/**
 * Narrow writable seam — accepts both `process.stdout` (a `tty.WriteStream`)
 * and the per-test `WriteBuffer` shim. Keeps the surface small enough that
 * tests don't have to mock the full `NodeJS.WritableStream` contract.
 */
export interface HandoffStream {
  write(chunk: string | Uint8Array): boolean;
}

export interface HandoffCommandOptions {
  argv: string[];
  stdout: HandoffStream;
  stderr: HandoffStream;
  env: NodeJS.ProcessEnv;
  channelStore?: ChannelStore;
  providerProfileStore?: ProviderProfileStore;
  /** When unset, defaults to a NodeCommandInvoker-backed spawner. */
  spawner?: HandoffSpawner;
  /** Pure-over-declared-inputs clock seam. Defaults to `() => new Date()`. */
  now?: () => Date;
}

export interface HandoffCommandResult {
  exitCode: number;
}

interface ParsedArgs {
  channelId: string;
  to: string | null;
  save: boolean;
  resume: string | null;
  maxTokens: number | null;
  force: boolean;
  waitGap: number;
  json: boolean;
}

class UsageError extends Error {}

const DEFAULT_WAIT_GAP_MS = 30_000;

/**
 * Top-level dispatch. Returns the exit code; the caller assigns it to
 * `process.exitCode`. Designed to be exhaustively unit-testable: every
 * external collaborator (channel store, provider-profile store, spawner) is
 * dependency-injected with a live default.
 */
export async function handleHandoffCommand(
  options: HandoffCommandOptions
): Promise<HandoffCommandResult> {
  if (options.argv.includes("--help") || options.argv.includes("-h") || options.argv.length === 0) {
    printHandoffHelp(options.stdout);
    return { exitCode: options.argv.length === 0 ? 1 : 0 };
  }

  let parsed: ParsedArgs;
  try {
    parsed = parseHandoffArgs(options.argv);
  } catch (err) {
    if (err instanceof UsageError) {
      writeError(options.stderr, options.stdout, err.message, false);
      return { exitCode: 2 };
    }
    throw err;
  }

  // Defense-in-depth path-traversal guard. ChannelStore guards too, but we
  // run before any disk I/O so the error message is friendlier.
  try {
    assertSafeSegment(parsed.channelId, "channelId");
  } catch (err) {
    writeError(
      options.stderr,
      options.stdout,
      err instanceof Error ? err.message : String(err),
      parsed.json
    );
    return { exitCode: 2 };
  }

  const channelStore = options.channelStore ?? new ChannelStore();
  const providerProfileStore = options.providerProfileStore ?? new ProviderProfileStore();
  const spawner = options.spawner ?? defaultSpawner;
  const now = options.now ?? (() => new Date());

  try {
    const channel = await channelStore.getChannel(parsed.channelId);
    if (!channel) {
      writeError(
        options.stderr,
        options.stdout,
        `Channel not found: ${parsed.channelId}`,
        parsed.json
      );
      return { exitCode: 1 };
    }

    return await runMode(parsed, channel, {
      channelStore,
      providerProfileStore,
      spawner,
      now,
      stdout: options.stdout,
      stderr: options.stderr,
      env: options.env,
    });
  } catch (err) {
    writeError(
      options.stderr,
      options.stdout,
      err instanceof Error ? err.message : String(err),
      parsed.json
    );
    return { exitCode: 1 };
  }
}

// ---------------------------------------------------------------------------
// Argv parsing
// ---------------------------------------------------------------------------

function parseHandoffArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  let to: string | null = null;
  let save = false;
  let resume: string | null = null;
  let maxTokens: number | null = null;
  let force = false;
  let waitGap = DEFAULT_WAIT_GAP_MS;
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--to":
        to = expectValue(argv, ++i, "--to");
        break;
      case "--save":
        save = true;
        break;
      case "--resume":
        resume = expectValue(argv, ++i, "--resume");
        break;
      case "--max-tokens": {
        const raw = expectValue(argv, ++i, "--max-tokens");
        const n = Number(raw);
        if (!Number.isFinite(n) || n <= 0) {
          throw new UsageError(`--max-tokens expects a positive number, got: ${raw}`);
        }
        maxTokens = n;
        break;
      }
      case "--force":
        force = true;
        break;
      case "--wait-gap": {
        const raw = expectValue(argv, ++i, "--wait-gap");
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 0) {
          throw new UsageError(`--wait-gap expects a non-negative number, got: ${raw}`);
        }
        waitGap = n;
        break;
      }
      case "--json":
        json = true;
        break;
      default:
        if (a.startsWith("--")) {
          throw new UsageError(`Unknown flag: ${a}`);
        }
        positionals.push(a);
    }
  }

  if (positionals.length !== 1) {
    throw new UsageError(
      `Usage: rly handoff <channelId> [--to <profile|adapter|alias>] [--save] [--resume <briefId|latest>]`
    );
  }
  if (save && to) {
    throw new UsageError(`--save and --to are mutually exclusive (D-08).`);
  }
  if (!save && !to) {
    throw new UsageError(`Pass --to <profile|adapter|alias> or --save (D-08).`);
  }

  return {
    channelId: positionals[0],
    to,
    save,
    resume,
    maxTokens,
    force,
    waitGap,
    json,
  };
}

function expectValue(argv: string[], i: number, flag: string): string {
  const v = argv[i];
  if (v === undefined || v.startsWith("--")) {
    throw new UsageError(`${flag} requires a value`);
  }
  return v;
}

// ---------------------------------------------------------------------------
// Mode dispatch
// ---------------------------------------------------------------------------

interface RunContext {
  channelStore: ChannelStore;
  providerProfileStore: ProviderProfileStore;
  spawner: HandoffSpawner;
  now: () => Date;
  stdout: HandoffStream;
  stderr: HandoffStream;
  env: NodeJS.ProcessEnv;
}

async function runMode(
  parsed: ParsedArgs,
  channel: Channel,
  ctx: RunContext
): Promise<HandoffCommandResult> {
  const isStrict = parsed.to !== null; // --to ⇒ STRICT, --save ⇒ PERMISSIVE (M2)

  // Resume mode (M7): read ONLY the saved gap.json. The brief.md is a
  // snapshot — never re-fed into buildBrief.
  let resumeContext: { briefId: string; originalGeneratedAt: string } | null = null;
  let preLoadedGapFill: GapFillBlock | null = null;
  if (parsed.resume) {
    let resumeBriefId: string;
    if (parsed.resume === "latest") {
      const ids = await listBriefIds(parsed.channelId);
      if (ids.length === 0) {
        writeError(
          ctx.stderr,
          ctx.stdout,
          `--resume latest: no briefs found in handoffs/`,
          parsed.json
        );
        return { exitCode: 1 };
      }
      resumeBriefId = ids[0];
    } else {
      resumeBriefId = parsed.resume;
    }
    preLoadedGapFill = await readGapFillByBriefId(parsed.channelId, resumeBriefId);
    if (!preLoadedGapFill) {
      writeError(
        ctx.stderr,
        ctx.stdout,
        `--resume ${resumeBriefId}: gap.json missing or invalid (read-only-gap, M7).`,
        parsed.json
      );
      return { exitCode: 1 };
    }
    resumeContext = {
      briefId: resumeBriefId,
      originalGeneratedAt: preLoadedGapFill.capturedAt,
    };
    // Resume is the documented "reanimate after a week" path (D-08). The
    // synthesizer's 1-hour staleness gate would otherwise discard the
    // intentionally-old gap-fill and render the placeholder — the very
    // opposite of what the user wants. Re-tag `capturedAt` to "now" so the
    // staleness gate passes; `resumeContext.originalGeneratedAt` preserves
    // the original timestamp for the rendered `**Resumed from:**` line (M7).
    preLoadedGapFill = { ...preLoadedGapFill, capturedAt: ctx.now().toISOString() };
  } else if (parsed.waitGap > 0) {
    // Best-effort prompt for a fresh gap.json from the running agent. We post
    // a dashboard-visible feed entry (L5: NOT agent-visible), then poll the
    // disk for `<briefId>.gap.json` records freshness-gated by
    // `readLatestGapFill`.
    await postHandoffPromptFeedEntry(ctx.channelStore, parsed.channelId);
    preLoadedGapFill = await waitForFreshGapFill(parsed.channelId, parsed.waitGap, ctx.now);
  }

  // Resolve destination provider (only meaningful for --to).
  const destination = parsed.to
    ? await resolveDestination(parsed.to, channel, ctx.providerProfileStore)
    : null;
  if (parsed.to && !destination) {
    writeError(ctx.stderr, ctx.stdout, buildUnknownDestinationError(parsed.to), parsed.json);
    return { exitCode: 1 };
  }

  // Build the brief.
  const brief = await buildBrief({
    channelId: parsed.channelId,
    now: ctx.now(),
    channelStore: ctx.channelStore,
    gapFill: preLoadedGapFill ?? undefined,
    fromProvider: channel.providerProfileId ?? null,
    toHint: destination?.label ?? (parsed.save ? "(save mode)" : null),
    ...(resumeContext ? { resumedFrom: resumeContext } : {}),
  });

  const validation = validateBrief(brief, {
    mode: isStrict ? "strict" : "permissive",
    ...(parsed.maxTokens !== null ? { maxTokens: parsed.maxTokens } : {}),
  });

  // Secret-pattern errors are HARD in BOTH modes (D-09); --force does NOT
  // bypass them.
  const secretErrors = validation.errors.filter((e) => /secret/i.test(e));
  const nonSecretErrors = validation.errors.filter((e) => !/secret/i.test(e));
  const hasBlockingError = secretErrors.length > 0 || (nonSecretErrors.length > 0 && !parsed.force);
  if (hasBlockingError) {
    emitFailure(ctx.stdout, ctx.stderr, parsed, validation);
    return { exitCode: 1 };
  }

  for (const w of validation.warnings) {
    ctx.stderr.write(`warn: ${w}\n`);
  }

  // Persist the artifacts (BOTH modes — `--to` benefits from the on-disk
  // archive too, RESEARCH §Q16).
  const markdown = renderBrief(brief);
  const gapFill = preLoadedGapFill ?? buildPlaceholderGapFill(brief.briefId, parsed.channelId);
  // Re-tag the gap-fill with the new briefId so the on-disk artifact pair
  // <newBriefId>.{md,gap.json} stays self-consistent (the original gap.json
  // is preserved at <originalBriefId>.gap.json — we don't mutate it).
  const persistedGapFill: GapFillBlock = {
    ...gapFill,
    briefId: brief.briefId,
    channelId: parsed.channelId,
  };
  const writeResult = await writeBriefArtifact({
    channelId: parsed.channelId,
    briefId: brief.briefId,
    markdown,
    gapFill: persistedGapFill,
  });

  // Spawn the destination session for --to mode.
  let spawnResult: HandoffSpawnResult | null = null;
  if (destination) {
    const cwd = pickRepoCwd(channel) ?? process.cwd();
    spawnResult = await ctx.spawner({
      adapter: destination.adapter,
      profile: destination.profile,
      channel,
      briefMarkdown: markdown,
      cwd,
    });
  }

  // Post the dashboard-visible feed entry (L5 — NOT agent-visible).
  await ctx.channelStore.postEntry(parsed.channelId, {
    type: "status_update",
    fromAgentId: null,
    fromDisplayName: "system",
    content: spawnResult
      ? `Handoff: ${parsed.channelId} → ${spawnResult.destinationLabel} (brief ${brief.briefId}, session ${spawnResult.newSessionId ?? "(unknown)"}).`
      : `Handoff brief saved: ${brief.briefId} (mode=${parsed.save ? "save" : "resume"}).`,
    metadata: {
      handoff: true,
      briefId: brief.briefId,
      fromProvider: channel.providerProfileId ?? "unknown",
      ...(spawnResult ? { toProvider: spawnResult.adapter } : {}),
      ...(destination?.profile ? { toProfileId: destination.profile.id } : {}),
      ...(spawnResult ? { toSessionId: spawnResult.newSessionId ?? null } : {}),
      mode: parsed.save ? "save" : parsed.resume ? "resume" : "to",
      ...(resumeContext ? { resumedFrom: resumeContext.briefId } : {}),
    },
  });

  // Best-effort decision record (L4) — failure does NOT fail the handoff.
  try {
    await ctx.channelStore.recordDecision(parsed.channelId, {
      title: `Session handed off${spawnResult ? ` to ${spawnResult.destinationLabel}` : " (saved)"}`,
      description: spawnResult
        ? `Brief ${brief.briefId} dispatched to ${spawnResult.destinationLabel}.`
        : `Brief ${brief.briefId} archived to disk.`,
      rationale: `User invoked rly handoff (mode=${parsed.save ? "save" : parsed.resume ? "resume" : "to"}).`,
      alternatives: [],
      decidedBy: "system",
      decidedByName: "rly handoff",
      runId: null,
      ticketId: null,
      linkedArtifacts: [],
    });
  } catch (err) {
    ctx.stderr.write(
      `warn: recordDecision failed (continuing): ${err instanceof Error ? err.message : String(err)}\n`
    );
  }

  emitSuccess(ctx.stdout, parsed, brief, writeResult, spawnResult);
  return { exitCode: 0 };
}

// ---------------------------------------------------------------------------
// Destination resolution (D-03 / RESEARCH §Q15 — layered fallback)
// ---------------------------------------------------------------------------

export interface ResolvedDestination {
  adapter: ProviderProfileAdapter;
  /** When the resolution went through a profile id, the full profile record. */
  profile: ProviderProfile | null;
  label: string;
}

export async function resolveDestination(
  value: string,
  channel: Channel,
  store: ProviderProfileStore
): Promise<ResolvedDestination | null> {
  // 1. Exact provider profile id.
  const direct = await store.getProfile(value);
  if (direct) {
    return { adapter: direct.adapter, profile: direct, label: direct.displayName };
  }

  // 2. Adapter shorthand: "claude" / "codex" → default profile for that
  //    adapter (if any), else the bare adapter (no profile).
  if (value === "claude" || value === "codex") {
    const profiles = await store.listProfiles();
    const sameAdapter = profiles.filter((p) => p.adapter === value);
    if (sameAdapter.length > 0) {
      const defaultId = await store.getDefaultProfileId();
      const preferred = sameAdapter.find((p) => p.id === defaultId) ?? sameAdapter[0];
      return { adapter: value, profile: preferred, label: preferred.displayName };
    }
    return { adapter: value, profile: null, label: value };
  }

  // 3. Channel repo alias match — pick up the channel's primary provider
  //    (or default fallback).
  const aliasMatch = (channel.repoAssignments ?? []).find((a) => a.alias === value);
  if (aliasMatch) {
    if (channel.providerProfileId) {
      const profile = await store.getProfile(channel.providerProfileId);
      if (profile) {
        return {
          adapter: profile.adapter,
          profile,
          label: `${profile.displayName} (alias ${value})`,
        };
      }
    }
    // Fall back to the system default profile.
    const defaultId = await store.getDefaultProfileId();
    if (defaultId) {
      const profile = await store.getProfile(defaultId);
      if (profile) {
        return {
          adapter: profile.adapter,
          profile,
          label: `${profile.displayName} (alias ${value})`,
        };
      }
    }
    // No profile available; default to claude adapter for an alias-only match.
    return { adapter: "claude", profile: null, label: `claude (alias ${value})` };
  }

  return null;
}

function buildUnknownDestinationError(value: string): string {
  return (
    `Unknown --to value: '${value}'. ` +
    `Pass a provider profile id (see \`rly providers\`), ` +
    `an adapter name (\`claude\` or \`codex\`), ` +
    `or a channel repo alias (see \`rly channel show <channelId>\`).`
  );
}

// ---------------------------------------------------------------------------
// Spawn helpers (Wave 4 — exported for testability per M6 / L7)
// ---------------------------------------------------------------------------

/**
 * Build the argv list for `claude -p` chat-seed. Independent of
 * `gui/src-tauri/src/lib.rs:start_chat` (L7); the two converge only at this
 * argv level.
 */
export function buildClaudeChatArgv(
  profile: ProviderProfile | null,
  briefMarkdown: string,
  systemPrompt: string | null
): string[] {
  const args = ["-p", "--output-format", "stream-json", "--verbose"];
  if (systemPrompt) {
    args.push("--append-system-prompt", systemPrompt);
  }
  if (profile?.defaultModel) {
    args.push("--model", profile.defaultModel);
  }
  args.push(briefMarkdown);
  return args;
}

/**
 * Build the argv list for `codex exec` chat-seed (M6).
 *
 * Deliberately drops the orchestrator-pipeline flags `--output-schema`, `-o`,
 * and `--ask-for-approval` — the chat-seed path has NO JSON contract back to
 * the orchestrator (the new session is interactive, not a one-shot). Sandbox
 * stays `read-only` unless the channel has opted into `fullAccess`.
 */
export function buildCodexChatArgv(
  profile: ProviderProfile | null,
  channel: Channel,
  briefMarkdown: string,
  cwd: string
): string[] {
  const sandbox = channel.fullAccess ? "workspace-write" : "read-only";
  const args = ["exec", "-C", cwd, "--skip-git-repo-check", "--sandbox", sandbox];
  if (profile?.defaultModel) {
    args.push("--model", profile.defaultModel);
  }
  // M6: deliberately omits orchestrator-pipeline flags (--output-schema, -o,
  // --ask-for-approval). Chat-seed path has no JSON contract back to the
  // orchestrator — the new session is interactive, not a one-shot.
  args.push(briefMarkdown);
  return args;
}

/**
 * Default spawner — wires `buildClaudeChatArgv` / `buildCodexChatArgv` into
 * `NodeCommandInvoker`. Tests substitute their own.
 *
 * Independent of `gui/src-tauri/src/lib.rs:start_chat` (L7).
 */
async function defaultSpawner(input: HandoffSpawnInput): Promise<HandoffSpawnResult> {
  // Lazy-import to keep the test seam light: tests inject their own spawner
  // and never need NodeCommandInvoker / launchInteractiveCommand.
  const { NodeCommandInvoker } = await import("../agents/command-invoker.js");
  const invoker = new NodeCommandInvoker();

  if (input.adapter === "codex") {
    const argv = buildCodexChatArgv(input.profile, input.channel, input.briefMarkdown, input.cwd);
    const result = await invoker.exec({
      command: "codex",
      args: argv,
      cwd: input.cwd,
      passEnv: ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_ORG_ID", "CODEX_HOME"],
    });
    return {
      newSessionId: extractCodexSessionId(result.stdout),
      destinationLabel: input.profile?.displayName ?? "codex",
      adapter: "codex",
    };
  }

  // Claude path. We use `launchInteractiveCommand` because the destination
  // session is interactive — a buffered exec would defeat streaming.
  const { launchInteractiveCommand } = await import("./launcher.js");
  const argv = buildClaudeChatArgv(input.profile, input.briefMarkdown, null);
  const exitCode = await launchInteractiveCommand({
    command: "claude",
    args: argv,
    cwd: input.cwd,
    env: {
      // launchInteractiveCommand inherits parent env; the secret-strip
      // contract for live Claude lives in `agent-wrapper` for the orchestrator
      // path. Chat-seed is a foreground UX command, not a sandboxed job.
    },
  });
  void exitCode;
  return {
    newSessionId: null,
    destinationLabel: input.profile?.displayName ?? "claude",
    adapter: "claude",
  };
}

/** Best-effort: try to pull a session id out of the destination's stdout. */
function extractCodexSessionId(stdout: string): string | null {
  const match = /"session(?:_)?id"\s*:\s*"([^"]+)"/.exec(stdout);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pickRepoCwd(channel: Channel): string | null {
  const assignments = channel.repoAssignments ?? [];
  if (assignments.length === 0) return null;
  if (channel.primaryWorkspaceId) {
    const match = assignments.find((a) => a.workspaceId === channel.primaryWorkspaceId);
    if (match) return match.repoPath;
  }
  return assignments[0].repoPath;
}

async function postHandoffPromptFeedEntry(
  channelStore: ChannelStore,
  channelId: string
): Promise<void> {
  // L5: this feed entry is dashboard-visible only; the running agent does
  // NOT receive it through its prompt context. The agent learns about the
  // gap-fill request via (a) a system-prompt instruction added to the
  // destination session's first turn, (b) its own context-exhaustion
  // detection, or (c) the user telling the agent to call
  // `channel_handoff_finalize`. The feed entry is a side channel for the
  // dashboard, not a back-channel to the running agent.
  await channelStore.postEntry(channelId, {
    type: "status_update",
    fromAgentId: null,
    fromDisplayName: "system",
    content:
      "Handoff requested — please call `channel_handoff_finalize` to save your working memory.",
    metadata: { handoffPrompt: true },
  });
}

async function waitForFreshGapFill(
  channelId: string,
  waitGapMs: number,
  now: () => Date
): Promise<GapFillBlock | null> {
  const start = Date.now();
  // We treat the wait window itself as the freshness window: any gap.json
  // captured after the CLI started is fair game.
  while (Date.now() - start < waitGapMs) {
    const result = await readLatestGapFill(channelId, {
      now: now(),
      maxAgeMs: waitGapMs + 60_000,
    });
    if (result) {
      // Only honor records authored after the wait started — older gap.jsons
      // are leftovers from previous handoffs.
      if (Date.parse(result.capturedAt) >= start - 1000) {
        return result;
      }
    }
    await sleep(500);
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildPlaceholderGapFill(briefId: string, channelId: string): GapFillBlock {
  return {
    schemaVersion: 1,
    briefId,
    channelId,
    capturedAt: new Date().toISOString(),
    capturedBySessionId: null,
    currentLineOfAttack: "",
    activeHypothesis: "",
    abandonedApproaches: [],
    openQuestions: [],
  };
}

function emitSuccess(
  stdout: HandoffStream,
  parsed: ParsedArgs,
  brief: HandoffBrief,
  writeResult: { mdPath: string; gapJsonPath: string },
  spawn: HandoffSpawnResult | null
): void {
  if (parsed.json) {
    stdout.write(
      JSON.stringify({
        ok: true,
        channelId: brief.channelId,
        briefId: brief.briefId,
        briefPath: writeResult.mdPath,
        gapJsonPath: writeResult.gapJsonPath,
        fromSessionId: brief.fromSessionId,
        toSessionId: spawn?.newSessionId ?? null,
        toProvider: spawn?.adapter ?? null,
        tokenEstimate: brief.tokenEstimate,
        mode: parsed.save ? "save" : parsed.resume ? "resume" : "to",
      }) + "\n"
    );
    return;
  }
  const lines = [
    `Wrote brief: ${writeResult.mdPath}`,
    `Wrote gap-fill: ${writeResult.gapJsonPath}`,
    `Token estimate: ${brief.tokenEstimate}`,
  ];
  if (spawn) {
    lines.push(`Dispatched: ${spawn.adapter} → ${spawn.destinationLabel}`);
    if (spawn.newSessionId) lines.push(`Session id: ${spawn.newSessionId}`);
  }
  stdout.write(lines.join("\n") + "\n");
}

function emitFailure(
  stdout: HandoffStream,
  stderr: HandoffStream,
  parsed: ParsedArgs,
  validation: { errors: string[]; warnings: string[] }
): void {
  if (parsed.json) {
    stdout.write(
      JSON.stringify({ ok: false, errors: validation.errors, warnings: validation.warnings }) + "\n"
    );
    return;
  }
  for (const e of validation.errors) stderr.write(`error: ${e}\n`);
  for (const w of validation.warnings) stderr.write(`warn: ${w}\n`);
}

function writeError(
  stderr: HandoffStream,
  stdout: HandoffStream,
  message: string,
  json: boolean
): void {
  if (json) {
    stdout.write(JSON.stringify({ ok: false, errors: [message], warnings: [] }) + "\n");
    return;
  }
  stderr.write(`error: ${message}\n`);
}

function printHandoffHelp(stdout: HandoffStream): void {
  stdout.write(
    [
      "Usage: rly handoff <channelId> [--to <profile|adapter|alias>] [--save]",
      "                              [--resume <briefId|latest>] [--max-tokens <n>]",
      "                              [--force] [--wait-gap <ms>] [--json]",
      "",
      "Generate a handoff brief from channel artifacts and (optionally) seed",
      "a fresh session in the destination provider. See docs/cli/rly-handoff.md.",
      "",
      "Modes:",
      "  --to <value>             STRICT validation; dispatches new session.",
      "  --save                   PERMISSIVE validation (secret-only); persists to disk only.",
      "  --resume <briefId|latest>  Reload saved gap.json + regenerate skeleton.",
      "",
      "Resolution order for --to (D-03):",
      "  1. Exact provider profile id (see `rly providers`).",
      "  2. Adapter shorthand: `claude` or `codex`.",
      "  3. Channel repo alias match (see `rly channel show <channelId>`).",
    ].join("\n") + "\n"
  );
}
