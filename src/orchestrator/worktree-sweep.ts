/**
 * Worktree sweep — AL-14 follow-up.
 *
 * AL-14 shipped `TicketRunner.handlePrMerged` to destroy a worker's worktree
 * when its PR merges while the autonomous loop is still running. Two
 * orphan-worktree leak paths remained:
 *
 *   1. **Terminal state.** The AL-4 driver exits as soon as every ticket
 *      reaches a terminal state. Tickets that land in `verifying` (worker
 *      exited cleanly + PR open) sit there with their worktree on disk
 *      until the PR merges. If the PR merges AFTER the driver returned,
 *      nothing calls `handlePrMerged`.
 *   2. **Crash recovery.** Any abnormal exit (SIGKILL, crash, reboot)
 *      while a PR was pending leaves a worktree behind.
 *
 * `sweepAbandonedWorktrees` is the shared helper that plugs both holes. It
 * is cross-session safe: it walks `~/.relay/channels/<id>/tickets.json`,
 * finds `verifying` tickets, pairs them with PR URLs from
 * `tracked-prs.json`, and — for PRs GitHub reports as `MERGED` — destroys
 * the worktree and marks the ticket `completed`.
 *
 * The autonomous-loop driver invokes this helper just before its terminal
 * lifecycle transition so the happy-path "worker opens PR, PR merges while
 * driver is still running, next tick cleans up" case is covered. The
 * `rly sweep-worktrees` CLI exposes the same helper for the crash-recovery
 * case ("I saw my desktop restart — clean up any orphaned worktrees").
 *
 * ## Design
 *
 * - **Worktree discovery from disk, not in-memory state.** The helper
 *   reads the on-disk `.relay-state.json` stamp each sandbox writes (see
 *   `src/execution/sandboxes/git-worktree.ts`) to recover the runId /
 *   ticketId / branch mapping without needing an active `TicketRunner`.
 *   This is the key property that makes the crash-recovery CLI work even
 *   when no driver is running.
 * - **PR lookup is injected.** `ghPrView` is an injected probe so tests
 *   don't shell out. Production callers pass the `defaultGhPrView` helper
 *   which delegates to `gh pr view <url> --json state`.
 * - **24h grace window.** A ticket's `updatedAt` must be at least
 *   `olderThanHours` old before we'll sweep it. Default 24h. The ticket
 *   intentionally preserves that grace window so the operator has time to
 *   inspect a freshly-merged PR before the worktree vanishes.
 * - **Dry-run = `json: true`.** When `json` is set, the helper returns
 *   the candidate list (merged + unmerged + errored) without calling
 *   `destroyWorktree` or `upsertChannelTickets`. The CLI prints JSON.
 * - **Never destroy open PRs.** If `gh pr view` reports anything other
 *   than `MERGED`, the worktree is left alone — matches AL-14's
 *   "worktrees kept for 24h inspection" intent.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { getRelayDir } from "../cli/paths.js";
import type { ChannelStore } from "../channels/channel-store.js";
import type { Channel } from "../domain/channel.js";
import type { TrackedPrRow } from "../domain/pr-row.js";
import type { TicketLedgerEntry } from "../domain/ticket.js";
import type { DestroyResult, SandboxProvider, SandboxRef } from "../execution/sandbox.js";
import type { GitWorktreeStateFile } from "../execution/sandboxes/git-worktree.js";
import type { WorkerSpawner } from "./worker-spawner.js";

/** GitHub PR state as surfaced by `gh pr view <url> --json state`. */
export type GhPrState = "OPEN" | "MERGED" | "CLOSED" | "DRAFT" | "UNKNOWN";

/** Result of a `gh pr view` probe. */
export interface GhPrViewResult {
  /** The literal `state` string from the GitHub API. */
  state: GhPrState;
}

/**
 * Injected PR-state probe. Tests pass a fake; production wires in
 * {@link defaultGhPrView}. The helper never shells out directly — all
 * network access goes through this seam so unit tests stay hermetic.
 */
export type GhPrView = (args: { url: string }) => Promise<GhPrViewResult>;

/**
 * Shape of a single candidate surfaced by the sweep — one per
 * verifying-with-PR ticket we could act on. The CLI's `--json` output
 * renders this array verbatim.
 */
export interface WorktreeSweepCandidate {
  ticketId: string;
  channelId: string;
  prUrl: string | null;
  /** `MERGED`, `OPEN`, `CLOSED`, etc. `null` when the probe failed. */
  prState: GhPrState | null;
  /** Absolute worktree path if we located one on disk, else `null`. */
  worktreePath: string | null;
  /**
   * Outcome of this sweep pass for the candidate. Dry-run produces
   * `"skipped"` for everything; real runs produce `"destroyed"` for
   * successfully-cleaned worktrees, `"preserved"` when the sandbox
   * provider refused to delete dirty state, and `"errored"` when the
   * probe or destroy threw.
   */
  action: "destroyed" | "preserved" | "skipped" | "errored";
  /**
   * Free-form explanation for the action. Useful as log output +
   * operator guidance. Intentionally prose-shaped — the CLI prints it
   * verbatim in human-readable mode.
   */
  reason: string;
}

export interface SweepAbandonedWorktreesOptions {
  /** Channel store used to read ticket boards + tracked-prs mirrors. */
  channelStore: ChannelStore;
  /**
   * Worker spawner whose `destroyWorktree(ref)` the helper calls. Passed
   * through so tests can inject a fake without wiring a real sandbox
   * provider. Only `destroyWorktree` is used.
   */
  spawner: Pick<WorkerSpawner, "destroyWorktree">;
  /**
   * Optional channel filter. When `null`/omitted the sweep covers every
   * channel; when set, only that channel is swept. The CLI's
   * `--session <id>` maps to the session's channel — the helper is
   * channel-scoped, not session-scoped, because channels own the ticket
   * board.
   */
  channelId?: string | null;
  /**
   * PR-state probe. Defaults to {@link defaultGhPrView} in production.
   * Tests inject a fake.
   */
  ghPrView?: GhPrView;
  /**
   * Minimum ticket age before the sweep will act on it. Defaults to 24h,
   * matching AL-14's "keep worktree 24h for inspection" contract. Tests
   * pass `0` to disable the grace window.
   */
  olderThanHours?: number;
  /**
   * When `true`, the helper returns candidates without destroying any
   * worktrees or mutating the ticket board. The CLI uses this for its
   * `--json` / dry-run mode.
   */
  dryRun?: boolean;
  /**
   * Clock injected for deterministic age comparisons. Defaults to
   * `Date.now`. Tests pin the clock so `olderThanHours` is exercisable
   * without actual sleeps.
   */
  now?: () => number;
  /**
   * Override for the `~/.relay/` root. Threaded through so tests can
   * point the helper at a tmp-dir-backed state tree.
   */
  rootDir?: string;
  /**
   * Pre-resolved channels list. Production callers omit; tests pass a
   * synthetic list so the helper doesn't need a real `~/.relay/channels/`
   * layout on disk beyond what the channel store already manages.
   */
  channels?: Channel[];
}

/** Summary of the sweep — printed by the CLI + asserted on in tests. */
export interface SweepAbandonedWorktreesResult {
  /** Total verifying-with-PR candidates the helper considered. */
  considered: number;
  /** Candidates the helper actually destroyed. */
  destroyed: number;
  /**
   * Candidates the sandbox provider refused to delete (dirty worktree).
   * Left in place for operator inspection.
   */
  preserved: number;
  /** Candidates skipped (dry-run, unmerged PR, missing worktree, grace-window). */
  skipped: number;
  /** Candidates where the probe or destroy threw. */
  errored: number;
  /** Full per-candidate rendering — safe to log, safe to JSON-stringify. */
  candidates: WorktreeSweepCandidate[];
}

/** Default grace window before a ticket becomes sweepable. */
export const DEFAULT_SWEEP_OLDER_THAN_HOURS = 24;

/**
 * Shape of a worktree stamp recovered from `.relay-state.json`, joined
 * with its container path + owning repo (read from the parent run dir's
 * sibling metadata, when present). Exported for reuse by the CLI.
 */
export interface DiscoveredWorktree {
  runId: string;
  ticketId: string;
  branch: string;
  base: string;
  createdAt: string;
  /** Absolute path to the worktree on disk. */
  worktreePath: string;
  /**
   * Path to the origin repo this worktree was cut from, if we could
   * recover it. Required by `GitWorktreeSandboxProvider.destroy` when
   * the destroying process is not the one that created the sandbox —
   * exactly our case.
   */
  repoRoot: string | null;
}

/**
 * Main entrypoint. Walks every (or the given) channel, pairs verifying
 * tickets with PR URLs, queries GitHub for PR state, and cleans up
 * worktrees for merged PRs. Returns a detailed result for the CLI to
 * print + tests to assert on.
 */
export async function sweepAbandonedWorktrees(
  options: SweepAbandonedWorktreesOptions
): Promise<SweepAbandonedWorktreesResult> {
  const {
    channelStore,
    spawner,
    channelId,
    ghPrView,
    olderThanHours = DEFAULT_SWEEP_OLDER_THAN_HOURS,
    dryRun = false,
    now = () => Date.now(),
    rootDir,
    channels: preResolvedChannels,
  } = options;

  const probe: GhPrView = ghPrView ?? defaultGhPrView;

  let channels: Channel[];
  if (preResolvedChannels) {
    channels = preResolvedChannels;
  } else if (channelId) {
    const single = await channelStore.getChannel(channelId).catch(() => null);
    channels = single ? [single] : [];
  } else {
    channels = await channelStore.listChannels().catch(() => [] as Channel[]);
  }

  const result: SweepAbandonedWorktreesResult = {
    considered: 0,
    destroyed: 0,
    preserved: 0,
    skipped: 0,
    errored: 0,
    candidates: [],
  };

  const discoveredByTicketId = await discoverWorktreesByTicketId(rootDir);

  const cutoffMs = now() - olderThanHours * 60 * 60 * 1000;

  for (const channel of channels) {
    if (channelId && channel.channelId !== channelId) continue;

    let tickets: TicketLedgerEntry[];
    try {
      tickets = await channelStore.readChannelTickets(channel.channelId);
    } catch (err) {
      // Treat a corrupt ticket board as "no tickets here". The sweep
      // is defensive — a read failure should not escalate into an
      // exception the CLI's user sees.
      console.warn(
        `[worktree-sweep] failed to read tickets for channel ${channel.channelId}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      continue;
    }

    const trackedPrs = await channelStore.readTrackedPrs(channel.channelId).catch(() => []);
    const prUrlByTicket = new Map<string, TrackedPrRow>();
    for (const row of trackedPrs) {
      prUrlByTicket.set(row.ticketId, row);
    }

    for (const ticket of tickets) {
      // The ticket status the runner writes when a worker opened a PR is
      // `verifying`. That's what we sweep — `awaiting-merge` is the
      // runner's internal state, never persisted to disk.
      if (ticket.status !== "verifying") continue;
      result.considered += 1;

      const candidate: WorktreeSweepCandidate = {
        ticketId: ticket.ticketId,
        channelId: channel.channelId,
        prUrl: null,
        prState: null,
        worktreePath: null,
        action: "skipped",
        reason: "",
      };

      // Grace-window gate. `ticket.updatedAt` is the last time the
      // runner (or any channel-store write) stamped the ticket — for
      // tickets in `verifying` this is normally the moment the worker's
      // PR URL was recorded.
      const updatedAtMs = Date.parse(ticket.updatedAt);
      if (Number.isFinite(updatedAtMs) && updatedAtMs > cutoffMs) {
        candidate.action = "skipped";
        candidate.reason = `within ${olderThanHours}h grace window; last update ${ticket.updatedAt}`;
        result.skipped += 1;
        result.candidates.push(candidate);
        continue;
      }

      const prRow = prUrlByTicket.get(ticket.ticketId);
      candidate.prUrl = prRow?.url ?? null;

      const discovered = discoveredByTicketId.get(ticket.ticketId) ?? null;
      candidate.worktreePath = discovered?.worktreePath ?? null;

      if (!candidate.prUrl) {
        candidate.action = "skipped";
        candidate.reason = "no tracked PR URL — worker may not have opened a PR";
        result.skipped += 1;
        result.candidates.push(candidate);
        continue;
      }

      let probeResult: GhPrViewResult;
      try {
        probeResult = await probe({ url: candidate.prUrl });
      } catch (err) {
        candidate.action = "errored";
        candidate.reason = `gh pr view failed: ${err instanceof Error ? err.message : String(err)}`;
        candidate.prState = null;
        result.errored += 1;
        result.candidates.push(candidate);
        continue;
      }

      candidate.prState = probeResult.state;
      if (probeResult.state !== "MERGED") {
        candidate.action = "skipped";
        candidate.reason = `PR state is ${probeResult.state}; leaving worktree in place`;
        result.skipped += 1;
        result.candidates.push(candidate);
        continue;
      }

      if (dryRun) {
        candidate.action = "skipped";
        candidate.reason = "dry-run — would destroy worktree + mark ticket completed";
        result.skipped += 1;
        result.candidates.push(candidate);
        continue;
      }

      if (!discovered) {
        // PR is merged but we can't find a worktree to destroy. The
        // likely cause is an earlier sweep already removed it but the
        // ticket board transition didn't happen (e.g. a crash between
        // `destroy` and `upsertChannelTickets`). Advance the ticket
        // to `completed` anyway so the board reflects reality.
        try {
          await markTicketCompleted(channelStore, channel.channelId, ticket, {
            prUrl: candidate.prUrl,
            worktreePath: null,
          });
          candidate.action = "destroyed";
          candidate.reason = "PR merged; no worktree found on disk (likely cleaned already)";
          result.destroyed += 1;
          result.candidates.push(candidate);
        } catch (err) {
          candidate.action = "errored";
          candidate.reason = `failed to transition ticket: ${
            err instanceof Error ? err.message : String(err)
          }`;
          result.errored += 1;
          result.candidates.push(candidate);
        }
        continue;
      }

      // Reconstruct the SandboxRef well enough for
      // `GitWorktreeSandboxProvider.destroy` to tear down the worktree.
      // The provider reads `workdir.path`, `meta.runId`, `meta.ticketId`,
      // and (critically) `meta.repoRoot` when the owning instance isn't
      // available. We stamped all of these into `.relay-state.json` at
      // create time so crash-recovery has everything it needs.
      const ref: SandboxRef = {
        id: `runtime-${discovered.runId}-${discovered.ticketId}`,
        workdir: { kind: "local", path: discovered.worktreePath },
        meta: {
          branch: discovered.branch,
          base: discovered.base,
          runId: discovered.runId,
          ticketId: discovered.ticketId,
          ...(discovered.repoRoot ? { repoRoot: discovered.repoRoot } : {}),
        },
      };

      let destroyResult: DestroyResult | undefined;
      try {
        destroyResult = (await spawner.destroyWorktree(ref)) as DestroyResult | undefined;
      } catch (err) {
        candidate.action = "errored";
        candidate.reason = `destroyWorktree failed: ${err instanceof Error ? err.message : String(err)}`;
        result.errored += 1;
        result.candidates.push(candidate);
        continue;
      }

      // `destroyWorktree` may be a wrapper that doesn't forward the
      // result (the runtime `WorkerSpawner` returns `Promise<void>`).
      // Treat an undefined / void return as success.
      if (destroyResult && destroyResult.kind === "preserved") {
        candidate.action = "preserved";
        candidate.reason = `worktree preserved (dirty): ${destroyResult.stderr.trim()}`;
        result.preserved += 1;
        result.candidates.push(candidate);
        continue;
      }

      try {
        await markTicketCompleted(channelStore, channel.channelId, ticket, {
          prUrl: candidate.prUrl,
          worktreePath: discovered.worktreePath,
        });
      } catch (err) {
        candidate.action = "errored";
        candidate.reason = `worktree destroyed but ticket transition failed: ${
          err instanceof Error ? err.message : String(err)
        }`;
        result.errored += 1;
        result.candidates.push(candidate);
        continue;
      }

      candidate.action = "destroyed";
      candidate.reason =
        destroyResult && destroyResult.kind === "missing"
          ? "PR merged; worktree already absent, ticket marked completed"
          : "PR merged; worktree destroyed and ticket marked completed";
      result.destroyed += 1;
      result.candidates.push(candidate);
    }
  }

  return result;
}

/**
 * Stamp ticket → `completed`. Isolated so both the happy path and the
 * "worktree already gone" path produce identical board + feed writes.
 */
async function markTicketCompleted(
  channelStore: ChannelStore,
  channelId: string,
  ticket: TicketLedgerEntry,
  meta: { prUrl: string | null; worktreePath: string | null }
): Promise<void> {
  const now = new Date().toISOString();
  const updated: TicketLedgerEntry = {
    ...ticket,
    status: "completed",
    completedAt: now,
    updatedAt: now,
  };
  await channelStore.upsertChannelTickets(channelId, [updated]);
  await channelStore
    .postEntry(channelId, {
      type: "status_update",
      fromAgentId: null,
      fromDisplayName: "worktree-sweep",
      content: `Ticket ${ticket.ticketId} PR merged. Worktree cleaned up by sweep.`,
      metadata: {
        ticketId: ticket.ticketId,
        prUrl: meta.prUrl,
        worktreePath: meta.worktreePath,
        source: "worktree-sweep",
      },
    })
    .catch((err) => {
      console.warn(
        `[worktree-sweep] failed to post merge feed entry for ${ticket.ticketId}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    });
}

/**
 * Walk `~/.relay/sandboxes/run-*` directories and collect `.relay-state.json`
 * stamps. Returns a ticketId → worktree map — last write wins for ties
 * (which shouldn't happen since `(runId, ticketId)` is unique).
 *
 * Exported so the CLI can reuse it for dry-run listing, and so tests can
 * exercise the discovery path in isolation.
 */
export async function discoverWorktreesByTicketId(
  rootDir?: string
): Promise<Map<string, DiscoveredWorktree>> {
  const out = new Map<string, DiscoveredWorktree>();
  const sandboxesRoot = join(rootDir ?? getRelayDir(), "sandboxes");

  let runDirs: string[];
  try {
    const entries = await readdir(sandboxesRoot, { withFileTypes: true });
    runDirs = entries
      .filter((e) => e.isDirectory() && e.name.startsWith("run-"))
      .map((e) => join(sandboxesRoot, e.name));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return out;
    throw err;
  }

  for (const runDir of runDirs) {
    let ticketDirs: string[];
    try {
      const entries = await readdir(runDir, { withFileTypes: true });
      ticketDirs = entries.filter((e) => e.isDirectory()).map((e) => join(runDir, e.name));
    } catch {
      continue;
    }

    for (const ticketDir of ticketDirs) {
      const statePath = join(ticketDir, ".relay-state.json");
      let raw: string;
      try {
        raw = await readFile(statePath, "utf8");
      } catch {
        continue;
      }
      let stamp: GitWorktreeStateFile;
      try {
        stamp = JSON.parse(raw) as GitWorktreeStateFile;
      } catch {
        continue;
      }
      // `repoRoot` was added to the stamp for this AL-14 follow-up.
      // Older stamps (written before this PR) don't carry it; the sweep
      // falls back to marking the ticket completed without destroying
      // when no `repoRoot` is available, so pre-existing worktrees from
      // prior runs aren't left orphaned.
      out.set(stamp.ticketId, {
        runId: stamp.runId,
        ticketId: stamp.ticketId,
        branch: stamp.branch,
        base: stamp.base,
        createdAt: stamp.createdAt,
        worktreePath: ticketDir,
        repoRoot: stamp.repoRoot ?? null,
      });
    }
  }

  return out;
}

/**
 * Default `gh pr view` implementation used in production. Shells out to
 * the `gh` CLI with `--json state` and parses the result.
 *
 * Tests override this via the `ghPrView` option so no real network calls
 * happen in the default suite.
 */
export async function defaultGhPrView(args: { url: string }): Promise<GhPrViewResult> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  try {
    const { stdout } = await run("gh", ["pr", "view", args.url, "--json", "state"]);
    const parsed = JSON.parse(stdout) as { state?: string };
    const state = (parsed.state ?? "UNKNOWN").toUpperCase() as GhPrState;
    return { state };
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? "";
    // Surface `gh` failures to the caller verbatim — sweep treats this
    // as an `errored` candidate and leaves the worktree alone.
    throw new Error(`gh pr view failed for ${args.url}: ${stderr || String(err)}`);
  }
}

/**
 * True when the ticket is eligible for a sweep check. Exposed so the
 * steady-state driver's per-tick integration can reuse the same predicate
 * without re-importing the full helper.
 */
export function isSweepCandidate(ticket: TicketLedgerEntry): boolean {
  return ticket.status === "verifying";
}
