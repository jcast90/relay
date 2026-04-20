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
import {
  createScm,
  wrapScm,
  type EnrichedPR,
  type HarnessProject,
  type HarnessScm
} from "../integrations/scm.js";
import {
  PrPoller,
  type TrackedPr
} from "../integrations/pr-poller.js";
import { SchedulerFollowUpDispatcher } from "../integrations/scheduler-follow-up-dispatcher.js";
import type {
  PollerFactory,
  PollerHandle
} from "../orchestrator/orchestrator-v2.js";

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
  listTracked(): ReadonlyArray<{
    ticketId: string;
    pr: TrackedPr["pr"];
    repo: TrackedPr["repo"];
    last: EnrichedPR | null;
  }>;
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

/** Access the live watcher. Returns null when no run is wired or token missing. */
export function getActiveWatcher(): ActiveWatcherView | null {
  return activeWatcher?.view ?? null;
}

/** Test helper — force-clear the singleton between test cases. */
export function __resetActiveWatcherForTests(): void {
  activeWatcher = null;
}

/**
 * Default git runner: `git -C <repoRoot> <...args>`. Kept outside the factory
 * so tests can substitute a mock via `opts.execGit`.
 */
const defaultExecGit: ExecGit = (repoRoot, args) =>
  execFileAsync("git", ["-C", repoRoot, ...args]);

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
function branchHintFor(
  ticketId: string,
  run: Parameters<PollerFactory>[0]["run"]
): string | null {
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
      console.info("[pr-watcher] GITHUB_TOKEN not set — PR watching disabled");
      return noopHandle();
    }

    // Lazy repo detection with memoized result. `undefined` means "not tried",
    // `null` means "tried and failed".
    const repoPromise = cachedRepo === undefined
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
            path: opts.repoRoot
          };

          // The no-token overload of createScm is synchronous; the plugin
          // reads GITHUB_TOKEN from env at query time.
          const scm = wrapScm(createScm("github"), project);
          const dispatcher = new SchedulerFollowUpDispatcher({ scheduler, run });
          poller = new PrPoller({
            scm,
            channelStore: opts.channelStore,
            scheduler: dispatcher,
            intervalMs
          });
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
            }
          };
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
              autoTracked
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
            autoTracked
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
      }
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
    }
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
        repo: input.repo
      });
      input.autoTracked.add(entry.ticketId);
    } catch {
      // Transient GitHub failure — next tick will retry. Don't mark tracked.
    }
  }
}
