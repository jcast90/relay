/**
 * Auto-wires the PR watcher lifecycle for a harness run.
 *
 * Lifecycle (per run):
 *   1. Orchestrator calls the factory once the scheduler exists.
 *   2. We detect the active GitHub repo from `<repoRoot>/.git`.
 *   3. If `GITHUB_TOKEN` is missing, we return a no-op handle (quiet dev mode).
 *   4. Otherwise we build `SCM + wrap + SchedulerFollowUpDispatcher + PrPoller`,
 *      expose it as the active watcher (for the `pr-watch` / `pr-status`
 *      commands to reach into), and start a cheap branch->PR auto-detection
 *      loop that tracks PRs as soon as they appear on tickets the run owns.
 *   5. `stop()` tears down both loops and clears the global singleton.
 *
 * Design notes:
 *   - Kept out of `src/integrations/` on purpose: this module touches CLI
 *     concerns (env, process, console, git shell-out) and needs to import from
 *     both `integrations/` and `orchestrator/`. Leaving `@aoagents/*` imports
 *     exclusively in `src/integrations/` preserves that boundary.
 *   - The `execGit` option keeps the module testable without shelling out.
 *   - The global singleton is intentionally narrow — just enough surface for
 *     `pr-watch` / `pr-status` to manipulate / read the live poller without a
 *     full IPC layer.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { ChannelStore } from "../channels/channel-store.js";
import { createScm, wrapScm, type HarnessProject, type HarnessScm } from "../integrations/scm.js";
import { PrPoller, type TrackedPr, type TrackedPrSnapshot } from "../integrations/pr-poller.js";
import { PrReviewer, type ReviewerTrustMode } from "../integrations/pr-reviewer.js";
import type { TrackedPrRow } from "../domain/pr-row.js";
import { SchedulerFollowUpDispatcher } from "../integrations/scheduler-follow-up-dispatcher.js";
import type { PollerFactory, PollerHandle } from "../orchestrator/orchestrator-v2.js";

// execFile (argv-based) is used deliberately instead of exec (shell string)
// so repo paths can never be shell-interpreted.
const execFileAsync = promisify(execFile);

/** Signature of the injected git executor — matches the shape of a real shell. */
export type ExecGit = (
  repoRoot: string,
  args: string[]
) => Promise<{ stdout: string; stderr: string }>;

export interface CreateFactoryOpts {
  channelStore: ChannelStore;
  repoRoot: string;
  /**
   * Channel to use for follow-ups when a ticket doesn't carry its own
   * channelId. Falls back to the run's channelId if present, otherwise the
   * tracker is skipped (a channel is mandatory for `TrackedPr`).
   */
  defaultChannelId?: string;
  /**
   * Polling interval passed to the underlying `PrPoller` AND to the internal
   * branch-detection loop. `PrPoller` defaults to 30s; for auto-detection 15s
   * feels right, so we reuse `intervalMs` for both and let callers tune.
   */
  intervalMs?: number;
  /**
   * Test-only override for the git shell-out. Accepts a repo root and
   * argv; returns the usual `{ stdout, stderr }`. Default delegates to
   * `child_process.execFile("git", ["-C", repoRoot, ...args])`.
   */
  execGit?: ExecGit;
  /**
   * AL-5: trust mode for the PR reviewer wrapper. When present, a
   * `PrReviewer` is attached to the poller and fires on every
   * `openedByAutonomous` PR that enters `track()`. Absent → no reviewer
   * (the pre-AL-5 default). Production callers pass this through from
   * the autonomous-loop's `--trust` flag; manual `rly run` invocations
   * leave it unset.
   */
  trustMode?: ReviewerTrustMode;
  /**
   * AL-5 test seam: builder for the reviewer. Tests inject a spy so the
   * poller wiring can be verified without shelling out to the subagent.
   * Ignored when `trustMode` is absent.
   */
  reviewerFactory?: (opts: {
    trustMode: ReviewerTrustMode;
    channelStore: ChannelStore;
    poller: PrPoller;
  }) => PrReviewer;
}

/**
 * Shape shared by the two commands that want to peek at the live watcher.
 * Kept separate from `PollerHandle` so callers can see tracked-PR state
 * without reaching through to the full PrPoller surface.
 */
export interface ActiveWatcherView {
  /** Track a PR explicitly (used by `pr-watch`). */
  track(entry: TrackedPr): void;
  /** Snapshot of currently tracked PRs (used by `pr-status`). */
  listTracked(): ReadonlyArray<TrackedPrSnapshot>;
  /** The repo the watcher is scoped to — used to resolve `pr-watch` inputs. */
  repo: { owner: string; name: string };
  /** The underlying SCM facade — needed to resolve PR URLs. */
  scm: HarnessScm;
}

/**
 * A `PollerHandle` with the extra CLI-facing surface attached. The factory
 * returns the base `PollerHandle` but we publish the richer view via the
 * singleton accessor below.
 */
interface ActiveWatcherEntry {
  handle: PollerHandle;
  view: ActiveWatcherView;
}

let activeWatcher: ActiveWatcherEntry | null = null;

/**
 * Tracks which channels have already received the "GITHUB_TOKEN missing"
 * warning entry during this process. The warning is a useful one-shot
 * signal — without this guard, every factory invocation (one per run) would
 * append a fresh warning to the feed and spam the channel.
 *
 * Cleared by `__resetActiveWatcherForTests` so tests can observe the
 * warning on demand.
 */
const missingTokenWarnedChannels = new Set<string>();

/** Access the live watcher. Returns null when no run is wired or token missing. */
export function getActiveWatcher(): ActiveWatcherView | null {
  return activeWatcher?.view ?? null;
}

/** Test helper — force-clear the singleton between test cases. */
export function __resetActiveWatcherForTests(): void {
  activeWatcher = null;
  missingTokenWarnedChannels.clear();
}

/**
 * Default git runner: `git -C <repoRoot> <...args>`. Kept outside the factory
 * so tests can substitute a mock via `opts.execGit`.
 */
const defaultExecGit: ExecGit = (repoRoot, args) => execFileAsync("git", ["-C", repoRoot, ...args]);

/**
 * Parse both HTTPS and SSH GitHub remotes:
 *   https://github.com/owner/name.git  -> { owner, name }
 *   https://github.com/owner/name      -> { owner, name }
 *   git@github.com:owner/name.git      -> { owner, name }
 *   ssh://git@github.com/owner/name.git -> { owner, name }
 * Returns null when the URL isn't a recognizable GitHub remote.
 */
export function parseGithubRemote(url: string): { owner: string; name: string } | null {
  const trimmed = url.trim();
  if (!trimmed) return null;

  // SSH shorthand: git@github.com:owner/name.git
  const sshMatch = trimmed.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (sshMatch) {
    return { owner: sshMatch[1], name: sshMatch[2] };
  }

  // HTTPS / ssh://: github.com/owner/name(.git)?
  const urlMatch = trimmed.match(
    /^(?:https?:\/\/|ssh:\/\/git@|git:\/\/)(?:[^@]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:[/?#].*)?$/
  );
  if (urlMatch) {
    return { owner: urlMatch[1], name: urlMatch[2] };
  }

  return null;
}

/**
 * Resolve the GitHub repo for this checkout. Returns null on any failure —
 * the factory treats "cannot determine repo" as "watcher disabled".
 */
async function detectRepo(
  repoRoot: string,
  execGit: ExecGit
): Promise<{ owner: string; name: string } | null> {
  try {
    const { stdout } = await execGit(repoRoot, ["remote", "get-url", "origin"]);
    return parseGithubRemote(stdout);
  } catch {
    return null;
  }
}

/**
 * Pull a branch hint off a ticket, looking first at the ticket's own metadata
 * and then at the run-level classification's suggestedBranch. Returns null
 * when nothing plausible is found — we'd rather skip a ticket than guess.
 */
function branchHintFor(ticketId: string, run: Parameters<PollerFactory>[0]["run"]): string | null {
  // TicketDefinition doesn't carry branchName today, but the classifier does
  // populate `suggestedBranch` on the run-level ClassificationResult when the
  // request came from an issue URL. That branch applies to the whole run, so
  // we surface it for every ticket lacking a finer hint.
  //
  // If a future TicketDefinition gains a `branchName` / `suggestedBranch`
  // field, read it here first (`ticket.branchName ?? ticket.suggestedBranch`).
  const ticket = run.ticketPlan?.tickets.find((t) => t.id === ticketId);
  if (!ticket) return null;

  // Narrow typing: cast through unknown to read optional branch fields.
  const maybe = ticket as unknown as { branchName?: string; suggestedBranch?: string };
  if (maybe.branchName) return maybe.branchName;
  if (maybe.suggestedBranch) return maybe.suggestedBranch;

  return run.classification?.suggestedBranch ?? null;
}

/**
 * Build the PollerFactory. Token presence is re-checked on every invocation
 * (one factory call per run) so flipping `GITHUB_TOKEN` between runs takes
 * effect immediately without re-instantiating the CLI.
 */
export function createPrWatcherFactory(opts: CreateFactoryOpts): PollerFactory {
  const execGit = opts.execGit ?? defaultExecGit;
  const intervalMs = opts.intervalMs;
  // Cache repo detection across factory invocations — cwd can't change within
  // one CLI process, so shelling out once per run is wasteful.
  let cachedRepo: { owner: string; name: string } | null | undefined;

  return ({ run, scheduler }) => {
    if (!process.env.GITHUB_TOKEN) {
      // Keep the stdout info line for CLI users who don't have the GUI/TUI
      // open — they still need to see this in plain terminal output.
      console.info("[pr-watcher] GITHUB_TOKEN not set — PR watching disabled");
      // Also surface as a channel-level warning so the GUI/TUI show it. Post
      // at most once per (channel, process) to avoid spamming: the factory is
      // invoked once per run and the message is invariant until the operator
      // sets GITHUB_TOKEN and restarts.
      const channelId = run.channelId ?? opts.defaultChannelId;
      if (channelId && !missingTokenWarnedChannels.has(channelId)) {
        missingTokenWarnedChannels.add(channelId);
        opts.channelStore
          .postEntry(channelId, {
            type: "status_update",
            fromAgentId: null,
            fromDisplayName: "PR Watcher",
            content:
              "GITHUB_TOKEN not set — PR watching is disabled. Set the env var and " +
              "restart to enable PR status updates for this channel.",
            metadata: {
              runId: run.id,
              channelId,
              warning: "missing_github_token",
              component: "pr-watcher",
            },
          })
          .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            console.warn(
              `[pr-watcher] failed to post missing-token warning to channel ${channelId}: ${message}`
            );
          });
      }
      return noopHandle();
    }

    // Lazy repo detection with memoized result. `undefined` means "not tried",
    // `null` means "tried and failed".
    const repoPromise =
      cachedRepo === undefined
        ? detectRepo(opts.repoRoot, execGit).then((r) => {
            cachedRepo = r;
            return r;
          })
        : Promise.resolve(cachedRepo);

    // Build the SCM + poller eagerly with a placeholder project; we'll
    // short-circuit `start()` if repo detection failed. This keeps the handle
    // returned synchronous and simple.
    let started = false;
    let poller: PrPoller | null = null;
    let branchLoop: ReturnType<typeof setInterval> | null = null;
    const autoTracked = new Set<string>();

    const handle: PollerHandle = {
      start(): void {
        if (started) return;
        started = true;

        void repoPromise.then((repo) => {
          if (!repo) {
            console.warn(
              `[pr-watcher] could not determine GitHub repo for ${opts.repoRoot} — PR watching disabled`
            );
            return;
          }

          const project: HarnessProject = {
            owner: repo.owner,
            name: repo.name,
            path: opts.repoRoot,
          };

          // The no-token overload of createScm is synchronous; the plugin
          // reads GITHUB_TOKEN from env at query time.
          const scm = wrapScm(createScm("github"), project);
          const dispatcher = new SchedulerFollowUpDispatcher({ scheduler, run });
          // AL-5: reviewer wiring — forward-declared so the poller's
          // `onTrack` hook below can call through to it. Constructed
          // AFTER the poller so `setReviewFindings` has a target; the
          // `trustMode` gate covers the non-autonomous case (manual
          // `rly run` invocations) where no reviewer should exist.
          let reviewer: PrReviewer | null = null;
          poller = new PrPoller({
            scm,
            channelStore: opts.channelStore,
            scheduler: dispatcher,
            intervalMs,
            onSnapshot: (rows) => {
              // Mirror tracked PRs to `channels/<id>/tracked-prs.json` for
              // the TUI and GUI. Group by channelId so each channel sees
              // only its own tickets; fire-and-forget so a slow disk write
              // doesn't back up the poller. The channel dir is created on
              // demand by ChannelStore.writeTrackedPrs.
              void persistSnapshot(opts.channelStore, rows);
            },
            onTrack: (entry) => {
              // Delegate to the reviewer when one was wired. The reviewer
              // filters on `openedByAutonomous` itself so manual
              // `rly pr-watch` rows never hit the subagent.
              reviewer?.handleTrack(entry);
            },
          });
          if (opts.trustMode) {
            reviewer =
              opts.reviewerFactory?.({
                trustMode: opts.trustMode,
                channelStore: opts.channelStore,
                poller,
              }) ??
              new PrReviewer({
                trustMode: opts.trustMode,
                channelStore: opts.channelStore,
                onReviewComplete: (ticketId, findings) => {
                  poller?.setReviewFindings(ticketId, findings);
                },
              });
          }
          poller.start();

          // Publish the live view for `pr-watch` / `pr-status`.
          const view: ActiveWatcherView = {
            repo,
            scm,
            track(entry) {
              poller?.track(entry);
            },
            listTracked() {
              return poller?.listTracked() ?? [];
            },
          };
          if (activeWatcher && activeWatcher.handle !== handle) {
            console.warn(
              "[pr-watcher] replacing previously-active watcher singleton — " +
                "concurrent orchestrator runs in the same process will share a single " +
                "`pr-watch` target. File-based routing will arrive in a follow-up."
            );
          }
          activeWatcher = { handle, view };

          // Branch-detection loop: cheap-ish, uses the same cadence as the
          // poller (or a faster default) and only hits GitHub for tickets
          // that just completed and have a branch hint we haven't tracked.
          const loopIntervalMs = intervalMs ?? 15_000;
          branchLoop = setInterval(() => {
            void scanCompletedTickets({
              run,
              repo,
              scm,
              poller: poller!,
              defaultChannelId: opts.defaultChannelId,
              autoTracked,
            }).catch(() => {
              /* detection must never crash the run */
            });
          }, loopIntervalMs);
          // Kick an immediate scan so fast-finishing tickets don't wait.
          void scanCompletedTickets({
            run,
            repo,
            scm,
            poller: poller!,
            defaultChannelId: opts.defaultChannelId,
            autoTracked,
          }).catch(() => {});
        });
      },
      stop(): void {
        if (branchLoop) {
          clearInterval(branchLoop);
          branchLoop = null;
        }
        poller?.stop();
        poller = null;
        if (activeWatcher?.handle === handle) {
          activeWatcher = null;
        }
      },
    };

    return handle;
  };
}

function noopHandle(): PollerHandle {
  return {
    start(): void {
      /* intentional no-op */
    },
    stop(): void {
      /* intentional no-op */
    },
  };
}

/**
 * For each completed ticket with a branch hint we haven't auto-tracked yet,
 * ask GitHub if a PR exists on that branch and, if so, hand it to the poller.
 */
async function scanCompletedTickets(input: {
  run: Parameters<PollerFactory>[0]["run"];
  repo: { owner: string; name: string };
  scm: HarnessScm;
  poller: PrPoller;
  defaultChannelId?: string;
  autoTracked: Set<string>;
}): Promise<void> {
  const channelId = input.run.channelId ?? input.defaultChannelId;
  if (!channelId) return; // Nowhere to post status updates — skip.

  // Release auto-track entries for tickets that went back to a non-completed
  // status (e.g. a retry). Without this, a ticket that completes, retries, and
  // re-completes would skip re-detection — which matters if the retry pushed to
  // a different branch, or if the initial detectPR returned null and the later
  // retry actually produced the PR.
  for (const ticketId of Array.from(input.autoTracked)) {
    const ledgerEntry = input.run.ticketLedger.find((t) => t.ticketId === ticketId);
    if (!ledgerEntry || ledgerEntry.status !== "completed") {
      input.autoTracked.delete(ticketId);
    }
  }

  for (const entry of input.run.ticketLedger) {
    if (entry.status !== "completed") continue;
    if (input.autoTracked.has(entry.ticketId)) continue;

    const branch = branchHintFor(entry.ticketId, input.run);
    if (!branch) continue;

    try {
      const pr = await input.scm.detectPR(branch, input.repo);
      if (!pr) continue;
      input.poller.track({
        ticketId: entry.ticketId,
        channelId,
        pr,
        repo: input.repo,
        // AL-5: every PR detected via the scheduler's completed-ticket
        // loop originated from an autonomous worker. The reviewer wrapper
        // scopes its subagent runs to rows flagged this way; manual
        // `rly pr-watch` entries leave the flag unset and are ignored.
        openedByAutonomous: true,
      });
      input.autoTracked.add(entry.ticketId);
    } catch {
      // Transient GitHub failure — next tick will retry. Don't mark tracked.
    }
  }
}

/**
 * Flatten a `TrackedPrSnapshot[]` into the persisted `TrackedPrRow` shape
 * and fan it out by `channelId` so each channel gets its own file. We
 * always overwrite — the poller owns the whole view, so a channel that
 * no longer has tracked entries ends up with an empty rows array rather
 * than stale data. Swallow per-channel failures so one flaky disk
 * doesn't poison snapshotting for the others.
 */
async function persistSnapshot(
  channelStore: ChannelStore,
  rows: ReadonlyArray<TrackedPrSnapshot>
): Promise<void> {
  const grouped = new Map<string, TrackedPrRow[]>();
  // Seed with every channel we've seen (even empty) — but we only know
  // the currently tracked ones; a channel dropping to zero rows simply
  // won't be emitted here. That's acceptable: readers should treat "no
  // file" and "empty rows" identically (both map to "no tracked PRs").
  const now = new Date().toISOString();
  for (const row of rows) {
    const list = grouped.get(row.channelId) ?? [];
    list.push({
      ticketId: row.ticketId,
      channelId: row.channelId,
      owner: row.repo.owner,
      name: row.repo.name,
      number: row.pr.number,
      url: row.pr.url,
      branch: row.pr.branch,
      ci: row.last?.ci ?? null,
      review: row.last?.review ?? null,
      prState: row.last?.prState ?? null,
      updatedAt: now,
      // AL-5 plumbing: thread the autonomy flag + structured review
      // findings through the persisted mirror so the TUI / GUI can
      // render "ready for human ack" badges and BLOCKING / NIT counts.
      openedByAutonomous: row.openedByAutonomous,
      ...(row.reviewFindings ? { reviewFindings: row.reviewFindings } : {}),
    });
    grouped.set(row.channelId, list);
  }
  await Promise.all(
    Array.from(grouped.entries()).map(async ([channelId, list]) => {
      try {
        await channelStore.writeTrackedPrs(channelId, list);
      } catch (err) {
        console.warn(`[pr-watcher] failed to persist tracked-prs for ${channelId}:`, err);
      }
    })
  );
}
