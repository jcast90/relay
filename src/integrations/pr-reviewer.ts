/**
 * AL-5: PR reviewer wrapper.
 *
 * When the PR poller registers a PR that was opened by an autonomous ticket
 * (`openedByAutonomous === true` on the `TrackedPr`), this module spawns a
 * short-lived `pr-review-toolkit:code-reviewer` subagent against the PR,
 * parses the BLOCKING / NIT / OK markers out of its stdout, and stashes
 * the structured findings back on the tracked-PR row via
 * `PrPoller.setReviewFindings`. Under supervised trust mode the review
 * status is `ready_for_human_ack`, signalling the TUI / GUI to surface
 * the PR for a human to sign off before merge. Under god mode the code
 * path is stubbed (AL-7 will wire auto-merge) — today it only logs a
 * decision-board entry so the audit trail shows the god-mode path fired.
 *
 * Why a dedicated spawn path rather than reusing {@link WorkerSpawner}?
 * Reviewers are short-lived and read-only — they don't need a per-ticket
 * git worktree, don't push commits, don't own a branch. We `gh pr
 * checkout` into a tmp dir, run the reviewer, and rm -rf on exit. The
 * worker-spawner abstraction would force a worktree lifecycle we don't
 * need.
 *
 * Manual PRs (tracked via `rly pr-watch`) are explicitly skipped: they
 * enter the poller with `openedByAutonomous === false`, and the
 * wrapper's dispatch no-ops. AL-5's acceptance criteria insist on this
 * boundary so a human-driven PR never ends up in the review queue.
 */

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ChannelStore } from "../channels/channel-store.js";
import type { ChannelPrState } from "../domain/channel.js";
import type { PrReviewFindings } from "../domain/pr-row.js";
import { NodeCommandInvoker, type CommandInvoker } from "../agents/command-invoker.js";
import type { SandboxProvider } from "../execution/sandbox.js";
import type { TrackedPr } from "./pr-poller.js";

/**
 * Flag that gates AL-7's god-mode auto-merge behaviour. AL-5 only reads
 * this to log a stubbed audit entry — the actual merge wiring is AL-7's
 * responsibility. Kept as a module-level constant so the env-var name
 * is obvious in tests (the reviewer doesn't accept it as an option
 * because the flag is process-wide, not per-review).
 */
export const RELAY_AL7_GOD_AUTOMERGE = "RELAY_AL7_GOD_AUTOMERGE";

/** Read the AL-7 god-mode flag from env. Defaults to `false`. */
export function isGodAutomergeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[RELAY_AL7_GOD_AUTOMERGE];
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

/** Supervised vs god trust mode — narrower mirror of CLI's `TrustMode`. */
export type ReviewerTrustMode = "supervised" | "god";

/**
 * Env vars a reviewer subprocess is allowed to read from the parent.
 *
 * B2: we deliberately drop `GITHUB_TOKEN` / `GH_TOKEN` from this list.
 * The reviewer is a prompt-constrained LLM session, not a GitHub client —
 * and if the prompt is jailbroken into running shell tools, a live token
 * in env would let it push commits or merge PRs. The `defaultCheckout`
 * helper gets the tokens via its own `passEnv` at `gh repo clone` /
 * `gh pr checkout` time, which happens BEFORE the reviewer is spawned
 * against the checked-out working tree. By the time the reviewer
 * subprocess starts, the tokens are already out of scope.
 *
 * Matches the stripped-env pattern `command-invoker.ts` documents: secrets
 * NOT on this list are unavailable to the child.
 */
const REVIEWER_PASS_ENV: readonly string[] = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_HOME",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
];

/**
 * Tool names the reviewer subprocess is explicitly forbidden to use. The
 * reviewer is supposed to read + report, not mutate — disallowing these
 * means even a prompt-jailbroken session can't Bash its way to a push or
 * an Edit can't rewrite the PR under the operator's feet. Passed on the
 * `claude` CLI as `--disallowedTools Bash,Edit,Write,NotebookEdit`.
 */
const REVIEWER_DISALLOWED_TOOLS: readonly string[] = ["Bash", "Edit", "Write", "NotebookEdit"];

/** Hard timeout for a single reviewer invocation. 3m is generous but finite. */
export const REVIEWER_TIMEOUT_MS = 180_000;

/**
 * Result of a single PR review. `findings` is the structured output suitable
 * for persistence via `PrPoller.setReviewFindings`; `trackedPrStatus`
 * (`ready_for_human_ack`) mirrors the AL-5 acceptance criteria so the
 * TUI / GUI can light up a distinctive badge.
 */
export interface ReviewPullRequestResult {
  findings: PrReviewFindings;
  /**
   * The tag to set on the tracked-pr row's supervised-mode status. Under
   * supervised trust this is always `ready_for_human_ack`; under god mode
   * the AL-5 stub returns `god_merge_pending` to mark the AL-7 hand-off
   * site without actually merging.
   */
  trackedPrStatus: "ready_for_human_ack" | "god_merge_pending";
}

export interface ReviewPullRequestOptions {
  /** Trust mode of the autonomous session that opened the PR. */
  trustMode: ReviewerTrustMode;
  /**
   * AO sandbox provider. Accepted for API parity with `WorkerSpawner`;
   * the reviewer uses a tmp dir under `os.tmpdir()` rather than a git
   * worktree (reviews are read-only and bounded), so the provider is
   * currently unused. Kept in the signature so callers don't have to plumb
   * differently when AL-7 eventually wires a full sandbox.
   */
  sandboxProvider?: SandboxProvider;
  /**
   * Reviewer-agent command. Defaults to `claude` — tests override with a
   * scripted invoker. The command's args are built to invoke the
   * `pr-review-toolkit:code-reviewer` subagent against the checked-out PR.
   */
  command?: string;
  /** Command invoker — test injection seam. Defaults to `NodeCommandInvoker`. */
  invoker?: CommandInvoker;
  /**
   * Override the repo-clone + PR-checkout runner. Tests inject a fake that
   * writes canned files into the tmp dir rather than hitting GitHub.
   * Default runs `gh repo clone <owner>/<name> <cwd>` followed by
   * `gh pr checkout <number>` inside it. See {@link defaultCheckout} for
   * why the two-step dance is necessary — `gh pr checkout` can't clone
   * the repo itself, it assumes the working directory already has a git
   * remote for the PR's base repo.
   *
   * Signature carries the `TrackedPr` (not just a URL string) so fake
   * implementations have access to owner/name/number without parsing the
   * URL themselves.
   */
  checkout?: (entry: TrackedPr, cwd: string) => Promise<void>;
  /** Clock injection for deterministic `reviewedAt` stamps. */
  clock?: () => number;
  /** Optional channel store for posting feed entries. */
  channelStore?: ChannelStore;
  /** Channel to post the review summary to. Required when `channelStore` is set. */
  channelId?: string;
  /**
   * Live GitHub PR state, when the caller knows it. Phase-4 routing uses
   * this to decide whether to mint a PR-review DM: open → mint, merged /
   * closed → skip mint and post to an existing DM if one's there, else
   * fall back to the tracked channel. Defaults to `"open"` — the poller
   * only fires the reviewer on newly-tracked PRs, so "open" is the
   * correct assumption in the current call sites.
   */
  prState?: ChannelPrState;
}

/**
 * Parse the reviewer subagent's prose output into structured findings.
 * Exported so tests can assert on the regex surface without spinning up
 * the full wrapper.
 *
 * Parsing contract, matching the `pr-review-toolkit:code-reviewer`
 * prompt format:
 *   - Each finding is on its own line and starts with one of `BLOCKING:`,
 *     `NIT:`, or `OK:` (case-insensitive, optional leading dash / bullet).
 *   - Files are extracted from `path/to/file.ts` and `path/to/file.ts:NN`
 *     shapes anywhere in the prose. Deduped.
 *   - `summary` is taken from the first `Summary:` or `SUMMARY:` line, or
 *     the first non-empty line if no explicit summary marker is present.
 *
 * Returns `null` when the input has no BLOCKING / NIT / OK markers at all
 * — callers should surface that as an "inconclusive" review rather than
 * silently pretending everything was OK.
 */
export function parseReviewOutput(
  stdout: string
): Omit<PrReviewFindings, "status" | "reviewedAt"> | null {
  const lines = stdout.split(/\r?\n/);
  let blocking = 0;
  let nits = 0;
  let okCount = 0;
  const files = new Set<string>();
  let summary = "";

  // Finding markers: optional bullet/dash prefix, then BLOCKING / NIT / OK
  // followed by a colon. Tolerant of plural NITS and BLOCKINGS for the
  // shapes Claude occasionally produces.
  const markerPattern = /^\s*(?:[-*]\s+)?(BLOCKING|BLOCKINGS|NIT|NITS|OK)\s*:/i;
  // File path: any run of non-whitespace containing a `/` and a `.ext`,
  // tolerant of optional `:lineno` suffix. Backtick / paren delimiters
  // are stripped at the end of the match.
  const filePattern = /([A-Za-z0-9_\-./]+\/[A-Za-z0-9_\-.]+\.[A-Za-z0-9]+)(?::\d+)?/g;

  for (const line of lines) {
    const marker = markerPattern.exec(line);
    if (marker) {
      const tag = marker[1].toUpperCase();
      if (tag === "BLOCKING" || tag === "BLOCKINGS") blocking += 1;
      else if (tag === "NIT" || tag === "NITS") nits += 1;
      else if (tag === "OK") okCount += 1;
    }

    const summaryMatch = /^\s*(?:summary|SUMMARY)\s*:\s*(.+)$/i.exec(line);
    if (summaryMatch && !summary) {
      summary = summaryMatch[1].trim();
    }

    let fileMatch: RegExpExecArray | null;
    while ((fileMatch = filePattern.exec(line)) !== null) {
      files.add(fileMatch[1]);
    }
  }

  if (blocking + nits + okCount === 0) {
    return null;
  }

  if (!summary) {
    // Fall back to the first non-empty non-marker line so every review
    // has a human-readable headline, even when the reviewer forgot to
    // emit an explicit Summary: line.
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (markerPattern.test(trimmed)) continue;
      summary = trimmed;
      break;
    }
  }
  if (!summary) {
    summary = `${blocking} blocking / ${nits} nit finding(s)`;
  }

  return {
    blocking,
    nits,
    files: Array.from(files),
    summary,
  };
}

/**
 * Default clone + checkout runner. B1: `gh pr checkout` is NOT a clone —
 * it walks up the cwd's git history to find a matching remote and fails
 * immediately on a fresh empty directory. The real two-step shape is:
 *
 *   1. `gh repo clone <owner>/<name> <cwd>` — populates the tmp dir with
 *      the base repo's content + remote.
 *   2. `gh pr checkout <number>` — inside that repo, fetches the PR head
 *      and checks it out.
 *
 * Uses the shared command invoker so env sanitization + `passEnv` for
 * `GH_TOKEN` / `GITHUB_TOKEN` is uniform with the rest of the harness.
 * Callers that want to inspect / record the checkout without shelling out
 * inject their own via the options struct.
 */
async function defaultCheckout(
  entry: TrackedPr,
  cwd: string,
  invoker: CommandInvoker
): Promise<void> {
  const slug = `${entry.repo.owner}/${entry.repo.name}`;
  // Step 1: clone the base repo into the tmp dir. `gh repo clone` resolves
  // the target itself; we still pass the tmp's parent as `cwd` so the
  // invoker's env sanitization applies uniformly (and in case of a future
  // `gh` version that reads cwd-relative config).
  const parentCwd = join(cwd, "..");
  await invoker.exec({
    command: "gh",
    args: ["repo", "clone", slug, cwd],
    cwd: parentCwd,
    timeoutMs: 60_000,
    passEnv: ["GH_TOKEN", "GITHUB_TOKEN"],
  });
  // Step 2: check out the PR head inside the fresh clone.
  await invoker.exec({
    command: "gh",
    args: ["pr", "checkout", String(entry.pr.number)],
    cwd,
    timeoutMs: 60_000,
    passEnv: ["GH_TOKEN", "GITHUB_TOKEN"],
  });
}

/**
 * Build the prompt handed to the `claude` CLI for review. Kept out of the
 * main function body so tests can assert on its shape without shelling out.
 * Encodes the BLOCKING / NIT / OK marker contract the parser above
 * enforces — if the prompt drifts, the parser becomes fragile.
 *
 * B3: this is a PROMPT-BASED review, not an actual Task/subagent
 * invocation. The "you are the pr-review-toolkit:code-reviewer subagent"
 * line is roleplay framing for the LLM — we don't spawn a separate
 * subagent process via the Claude Agent SDK's Task API here. That rename
 * would be a bigger AL-5 follow-up; for now we're honest about the shape:
 * a plain `claude -p <prompt>` invocation with capability restrictions
 * (see `REVIEWER_DISALLOWED_TOOLS`) doing all the real defense work.
 */
export function buildReviewerPrompt(prUrl: string, trustMode: ReviewerTrustMode): string {
  return [
    // Roleplay framing. The LLM adopts the reviewer persona; this is NOT
    // a real subagent invocation — see the function docstring.
    `You are acting as a pr-review-toolkit:code-reviewer role running under Relay AL-5.`,
    `Review the pull request at ${prUrl}.`,
    `Trust mode: ${trustMode}.`,
    ``,
    `Output format — STRICT:`,
    `  Summary: <1-2 sentence headline>`,
    `  BLOCKING: <one finding per line; cite file paths>`,
    `  NIT: <one nit per line; cite file paths>`,
    `  OK: <one line per area that looks good>`,
    ``,
    `Do not modify code. Do not push commits. Do not open additional PRs.`,
    `Only read and report. The harness parses BLOCKING / NIT / OK markers`,
    `out of your stdout — stay on-format or findings will be counted as`,
    `inconclusive.`,
  ].join("\n");
}

/**
 * Core entrypoint. Spawns the reviewer, parses its output, and returns
 * structured findings. The caller is responsible for stashing the result
 * onto the tracked-PR row (usually via `PrPoller.setReviewFindings`)
 * and for posting a feed entry.
 *
 * The tmp dir is cleaned up on every exit path — success, parser failure,
 * spawn error. A lingering `/tmp/relay-pr-review-XXX` directory would
 * accumulate one per autonomous PR on a long-lived session and is a pure
 * leak with no recovery value (the reviewer doesn't produce artifacts
 * the operator would want to salvage).
 */
export async function reviewPullRequest(
  entry: TrackedPr,
  options: ReviewPullRequestOptions
): Promise<ReviewPullRequestResult> {
  const clock = options.clock ?? Date.now;
  const invoker = options.invoker ?? new NodeCommandInvoker();
  const command = options.command ?? "claude";
  const checkout = options.checkout ?? ((e, cwd) => defaultCheckout(e, cwd, invoker));
  const reviewedAt = new Date(clock()).toISOString();

  // god-mode path is stubbed per AL-5's acceptance criteria. AL-7 will
  // wire the real auto-merge flow; today we log and short-circuit to
  // the supervised review so findings still show up on the feed.
  const godMergePending = options.trustMode === "god" && isGodAutomergeEnabled();

  // Build a clean tmp dir per review. `os.tmpdir()` lives on a filesystem
  // the current user can write to; `mkdtemp` guarantees no collision with
  // another concurrent reviewer.
  const tmpRoot = await mkdtemp(join(tmpdir(), "relay-pr-review-"));
  // Nested `repo/` subdir path for the clone target. We do NOT pre-create
  // it here: `gh repo clone` expects the destination to not exist (or to
  // be empty), and creating it ahead of time with `mkdir({recursive:true})`
  // still satisfies that. But we avoid the step entirely since `gh repo
  // clone` will create the dir itself, and keeping the code honest about
  // "the tmp dir is created by the clone" makes the B1 fix self-evident.
  const repoDir = join(tmpRoot, "repo");

  let stdout = "";
  let findingsStatus: PrReviewFindings["status"] = "ready_for_human_ack";
  try {
    try {
      await checkout(entry, repoDir);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return buildErrorResult(entry, reviewedAt, `gh pr checkout failed: ${message}`, options);
    }

    const prompt = buildReviewerPrompt(entry.pr.url, options.trustMode);
    try {
      const result = await invoker.exec({
        command,
        // B2: pass `--disallowedTools Bash,Edit,Write,NotebookEdit` so the
        // reviewer is capability-restricted even if its prompt gets
        // jailbroken. Combined with dropping `GITHUB_TOKEN` /`GH_TOKEN`
        // from `passEnv` below, this leaves the subprocess with read-only
        // access to the checked-out working tree.
        args: ["-p", prompt, "--disallowedTools", REVIEWER_DISALLOWED_TOOLS.join(",")],
        cwd: repoDir,
        timeoutMs: REVIEWER_TIMEOUT_MS,
        passEnv: [...REVIEWER_PASS_ENV],
      });
      stdout = result.stdout;
      if (result.exitCode !== 0) {
        // Non-zero exit from the reviewer — surface as an error result so
        // the feed warns the operator. Keep the partial stdout in case
        // the parser can still extract findings from it.
        const parsed = parseReviewOutput(stdout);
        if (parsed) {
          findingsStatus = "inconclusive";
          return finalize(entry, reviewedAt, parsed, findingsStatus, godMergePending, options);
        }
        return buildErrorResult(
          entry,
          reviewedAt,
          `reviewer exited ${result.exitCode}`,
          options,
          stdout
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return buildErrorResult(entry, reviewedAt, `reviewer invocation failed: ${message}`, options);
    }

    const parsed = parseReviewOutput(stdout);
    if (!parsed) {
      findingsStatus = "inconclusive";
      const fallback = {
        blocking: 0,
        nits: 0,
        files: [] as string[],
        summary: "Reviewer output had no BLOCKING / NIT / OK markers — treating as inconclusive.",
      };
      return finalize(entry, reviewedAt, fallback, findingsStatus, godMergePending, options);
    }

    return finalize(entry, reviewedAt, parsed, findingsStatus, godMergePending, options);
  } finally {
    // Best-effort cleanup; a lingering tmp dir is a leak but never a
    // correctness issue. `force: true` absorbs ENOENT if another hand
    // (e.g. an OS tmp reaper) already swept it.
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {
      /* ignore */
    });
  }
}

/**
 * Build the final `ReviewPullRequestResult` + optionally post a feed
 * entry. Shared by the happy-path and the "parser succeeded but exit was
 * non-zero" branches.
 */
async function finalize(
  entry: TrackedPr,
  reviewedAt: string,
  parsed: Omit<PrReviewFindings, "status" | "reviewedAt">,
  status: PrReviewFindings["status"],
  godMergePending: boolean,
  options: ReviewPullRequestOptions
): Promise<ReviewPullRequestResult> {
  const findings: PrReviewFindings = {
    ...parsed,
    status,
    reviewedAt,
  };

  // AL-5 acceptance: under god mode the stub no-ops on merge but still
  // records the findings so AL-7 can trigger on them. The row status
  // surfaces the pending-merge marker so the TUI can differentiate the
  // two cases visually.
  const trackedPrStatus: ReviewPullRequestResult["trackedPrStatus"] = godMergePending
    ? "god_merge_pending"
    : "ready_for_human_ack";

  if (godMergePending) {
    console.info(
      `[pr-reviewer] god-mode auto-merge flag set but AL-7 not yet wired; ` +
        `row ${entry.ticketId} (${entry.pr.url}) left in god_merge_pending state.`
    );
  }

  await postReviewFeedEntry(entry, findings, trackedPrStatus, options).catch((err: unknown) => {
    console.warn(
      `[pr-reviewer] failed to post review feed entry for ${entry.ticketId}:`,
      err instanceof Error ? err.message : String(err)
    );
  });

  return { findings, trackedPrStatus };
}

/**
 * Build the sentinel result for an error path — subagent failed to spawn,
 * `gh pr checkout` failed, etc. Keeps the result shape consistent so
 * callers don't branch on success/failure themselves; the `status: "error"`
 * is what they pattern-match on.
 */
async function buildErrorResult(
  entry: TrackedPr,
  reviewedAt: string,
  summary: string,
  options: ReviewPullRequestOptions,
  stdout?: string
): Promise<ReviewPullRequestResult> {
  const findings: PrReviewFindings = {
    blocking: 0,
    nits: 0,
    files: [],
    summary,
    status: "error",
    reviewedAt,
  };
  // Attempt to capture a file list even from partial stdout — helps
  // post-mortem diagnosis when the reviewer crashed mid-run.
  if (stdout) {
    const partial = parseReviewOutput(stdout);
    if (partial) {
      findings.files = partial.files;
    }
  }
  await postReviewFeedEntry(entry, findings, "ready_for_human_ack", options).catch(() => {});
  return { findings, trackedPrStatus: "ready_for_human_ack" };
}

/**
 * Post a human-readable entry into the channel feed so an operator sees
 * the review result in the TUI / GUI without having to open
 * `tracked-prs.json`. Silent no-op when no channel store was provided
 * (unit tests + library callers that want findings but not the feed).
 */
async function postReviewFeedEntry(
  entry: TrackedPr,
  findings: PrReviewFindings,
  trackedPrStatus: ReviewPullRequestResult["trackedPrStatus"],
  options: ReviewPullRequestOptions
): Promise<void> {
  const store = options.channelStore;
  if (!store) return;

  const label = `${entry.repo.owner}/${entry.repo.name}#${entry.pr.number}`;
  const content =
    findings.status === "error"
      ? `PR review for ${label} errored: ${findings.summary}`
      : findings.status === "inconclusive"
        ? `PR review for ${label} inconclusive — ${findings.summary}`
        : `PR review for ${label}: ${findings.blocking} blocking, ${findings.nits} nit${findings.nits === 1 ? "" : "s"}. ${findings.summary}`;

  // PR-review DM routing (phase 4):
  //   - When the tracked row's `entry.channelId` is already a PR DM (e.g.
  //     the `pr_review_start` MCP flow), findings post directly there —
  //     no mint, no cross-link.
  //   - When the tracked channel is NOT a DM and the PR is live (`open`),
  //     we find-or-mint a PR DM keyed on the PR URL and post the full
  //     findings there, plus a compact `pr_link` cross-link in the parent
  //     so the feature thread still sees "review complete".
  //   - When the tracked channel is NOT a DM and the PR is merged / closed
  //     or the review itself errored, we skip minting a new DM (no sense
  //     standing up a review thread for a PR that's already closed or a
  //     run we couldn't fetch) and fall back to posting directly in the
  //     tracked channel — preserving the pre-phase-4 observability shape
  //     for that edge case.
  //   - Cross-link metadata carries the DM's `pr.state` so the GUI pill
  //     renders with the right open/merged/closed variant without a second
  //     round-trip.
  const trackedChannelId = options.channelId ?? entry.channelId;
  const trackedChannel = trackedChannelId ? await store.getChannel(trackedChannelId) : null;
  const trackedIsDm = trackedChannel?.pr !== undefined;
  const liveState: ChannelPrState = options.prState ?? "open";
  const prHealthy = liveState === "open" && findings.status !== "error";

  let dmChannelId: string | null;
  let dmState: ChannelPrState = liveState;
  if (trackedIsDm && trackedChannelId) {
    dmChannelId = trackedChannelId;
    dmState = trackedChannel?.pr?.state ?? liveState;
  } else if (!prHealthy) {
    // Don't mint a DM for a merged/closed PR or for a review that errored
    // before the subagent even ran. Use an existing DM if one is already
    // there (e.g. from a prior pr_review_start), otherwise fall back to
    // posting in the tracked channel directly.
    const existing = await store.findChannelByPrUrl(entry.pr.url);
    dmChannelId = existing?.channelId ?? null;
    dmState = existing?.pr?.state ?? liveState;
  } else {
    const { channel: dm } = await store.findOrCreatePrDm({
      pr: {
        url: entry.pr.url,
        number: entry.pr.number,
        repo: entry.repo,
        state: liveState,
        parentChannelId: trackedChannelId ?? undefined,
      },
    });
    dmChannelId = dm.channelId;
    dmState = dm.pr?.state ?? liveState;
  }

  const primaryChannelId = dmChannelId ?? trackedChannelId;
  if (!primaryChannelId) return;

  await store.postEntry(primaryChannelId, {
    type: "status_update",
    fromAgentId: null,
    fromDisplayName: "pr-reviewer",
    content,
    metadata: {
      ticketId: entry.ticketId,
      prUrl: entry.pr.url,
      reviewStatus: findings.status,
      blocking: findings.blocking,
      nits: findings.nits,
      trackedPrStatus,
    },
  });

  if (dmChannelId && trackedChannelId && trackedChannelId !== dmChannelId) {
    await store.postEntry(trackedChannelId, {
      type: "pr_link",
      fromAgentId: null,
      fromDisplayName: "pr-reviewer",
      content: `PR review for ${label}: ${findings.summary}`,
      metadata: {
        ticketId: entry.ticketId,
        prUrl: entry.pr.url,
        prState: dmState,
        dmChannelId,
        reviewStatus: findings.status,
        blocking: findings.blocking,
        nits: findings.nits,
      },
    });
  }
}

/**
 * Adapter that bridges the `PrPoller` onTrack event into
 * `reviewPullRequest`. Wires the filter ("only autonomous PRs"),
 * schedules the (long-running) review off the caller's stack so tracking
 * stays synchronous, and stashes the findings back onto the poller when
 * the review resolves.
 *
 * Usage:
 *
 * ```
 * const reviewer = new PrReviewer({ poller, channelStore, trustMode });
 * // `poller` constructed with `{ onTrack: (e) => reviewer.handleTrack(e) }`
 * ```
 */
export interface PrReviewerOptions {
  /**
   * Trust mode — threaded through to every review. Taken once at
   * construction rather than per-call so the reviewer matches the
   * session-wide setting the operator authorised.
   */
  trustMode: ReviewerTrustMode;
  /**
   * Called when a review completes successfully. The wrapper uses this
   * to stash `findings` on the tracked-PR row via
   * `PrPoller.setReviewFindings`. Tests inject a spy.
   */
  onReviewComplete: (ticketId: string, findings: PrReviewFindings) => void;
  /** Channel store for feed entries. Optional — the review itself runs even without it. */
  channelStore?: ChannelStore;
  /**
   * Options for the underlying review. Every field is optional; the wrapper
   * threads `trustMode` from this options bag into each call.
   */
  reviewOptions?: Omit<ReviewPullRequestOptions, "trustMode">;
  /**
   * Test seam: replaces the real `reviewPullRequest`. Production
   * callers leave this unset.
   */
  reviewFn?: typeof reviewPullRequest;
}

export class PrReviewer {
  private readonly trustMode: ReviewerTrustMode;
  private readonly onReviewComplete: (ticketId: string, findings: PrReviewFindings) => void;
  private readonly channelStore?: ChannelStore;
  private readonly reviewOptions: Omit<ReviewPullRequestOptions, "trustMode">;
  private readonly reviewFn: typeof reviewPullRequest;
  /**
   * Tracks review runs currently in-flight, keyed by ticketId. The
   * onTrack event can fire twice for the same ticket if the pr-watcher
   * factory's `autoTracked` set is cleared by a retry — we don't want
   * two concurrent reviews stomping on each other's findings.
   */
  private readonly inFlight = new Set<string>();

  constructor(options: PrReviewerOptions) {
    this.trustMode = options.trustMode;
    this.onReviewComplete = options.onReviewComplete;
    this.channelStore = options.channelStore;
    this.reviewOptions = options.reviewOptions ?? {};
    this.reviewFn = options.reviewFn ?? reviewPullRequest;
  }

  /**
   * Called synchronously from `PrPoller.track()`. Filters on
   * `openedByAutonomous`, deduplicates in-flight reviews, and schedules
   * the subagent off the caller's microtask so tracking itself stays
   * snappy. Errors are caught and logged — a failing review must not
   * poison the poller's track() path.
   */
  handleTrack(entry: TrackedPr): void {
    if (entry.openedByAutonomous !== true) return;
    if (this.inFlight.has(entry.ticketId)) return;
    this.inFlight.add(entry.ticketId);

    queueMicrotask(() => {
      void this.runReview(entry).finally(() => {
        this.inFlight.delete(entry.ticketId);
      });
    });
  }

  private async runReview(entry: TrackedPr): Promise<void> {
    try {
      const result = await this.reviewFn(entry, {
        ...this.reviewOptions,
        trustMode: this.trustMode,
        channelStore: this.channelStore ?? this.reviewOptions.channelStore,
        channelId: entry.channelId,
      });
      this.onReviewComplete(entry.ticketId, result.findings);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[pr-reviewer] review crashed for ticket=${entry.ticketId} url=${entry.pr.url}: ${message}`
      );
      this.onReviewComplete(entry.ticketId, {
        blocking: 0,
        nits: 0,
        files: [],
        summary: `Reviewer crashed: ${message}`,
        status: "error",
        reviewedAt: new Date(Date.now()).toISOString(),
      });
    }
  }
}
