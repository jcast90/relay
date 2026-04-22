/**
 * AL-15 — Memory-shed session summary builder.
 *
 * When a repo-admin session recycles (context pressure or manual), it
 * writes a one-line summary to the channel's decisions board so the newly-
 * respawned child can reconstruct its working set by reading the board.
 * This module owns the shape of that summary + the pure function that
 * builds it.
 *
 * The summary is designed to round-trip through
 * {@link ChannelStore.recordDecision}:
 *   - `title` is the one-line human-readable sentence.
 *   - `description` carries the same sentence for UIs that render only
 *     one of the two fields.
 *   - `metadata` carries the structured fields the post-cycle repo-admin
 *     (and future scheduler-awareness features) actually consume.
 *
 * Explicitly out of scope here:
 *   - `worktreesInUse` + `openPrs` are stubbed to empty arrays until AL-14
 *     (worker spawning) supplies the data sources. They're present in the
 *     shape so the decisions-board schema doesn't need to change later.
 *   - Writing the decision. That's the session's job.
 */

/** Reason a cycle was triggered. Extended as new triggers are added. */
export type CycleReason =
  /** The session's own token tracker crossed the 60% ceiling. */
  | "budget-60pct"
  /** An operator (or test) called `session.cycle()` directly. */
  | "manual";

/**
 * The structured "working set" snapshot captured at cycle time. Every
 * field is present — empty arrays signal "no X in flight" rather than
 * "data source not yet wired".
 *
 * `worktreesInUse` + `openPrs` are stubbed as empty for AL-15; AL-14 will
 * populate them from the worker-spawning machinery it owns.
 */
export interface CycleSummarySnapshot {
  /** Ticket ids the session had in its pending queue at cycle time. */
  activeTickets: string[];
  /**
   * Worktree identifiers (path or alias) currently checked out by workers
   * this session spawned. Stub: empty until AL-14.
   */
  worktreesInUse: string[];
  /**
   * PR numbers (or `owner/repo#N` identifiers) currently tracked as open
   * by this session. Stub: empty until AL-14.
   */
  openPrs: string[];
  /** Why we cycled. */
  cycleReason: CycleReason;
}

/**
 * The full structured payload written to
 * `Decision.metadata`. Includes both the snapshot + the session-identity
 * fields a downstream reader needs to correlate the cycle to a specific
 * repo-admin.
 */
export interface CycleDecisionMetadata extends CycleSummarySnapshot {
  /** Alias of the repo-admin session that cycled. */
  alias: string;
  /** Session id of the CHILD process that was killed. */
  previousSessionId: string;
  /** Session id of the CHILD process that will respawn. Minted at cycle time. */
  nextSessionId: string;
  /**
   * ISO timestamp of the cycle event. Captured at build-time so a delayed
   * disk flush doesn't skew the board's timeline.
   */
  cycledAt: string;
}

/**
 * The full decision shape the session passes through to
 * {@link ChannelStore.recordDecision}. Shaped as the
 * `Omit<Decision, "decisionId" | "channelId" | "createdAt">` input the
 * store expects, so callers can forward it verbatim.
 */
export interface CycleDecisionInput {
  runId: string | null;
  ticketId: string | null;
  title: string;
  description: string;
  rationale: string;
  alternatives: string[];
  decidedBy: string;
  decidedByName: string;
  linkedArtifacts: string[];
  type: "repo_admin_cycle";
  metadata: CycleDecisionMetadata;
}

/**
 * Arguments to {@link buildCycleDecision}. Kept as a flat record so the
 * caller (the session) can pass what it has without wrapping.
 */
export interface BuildCycleDecisionArgs {
  alias: string;
  previousSessionId: string;
  nextSessionId: string;
  snapshot: CycleSummarySnapshot;
  /**
   * ISO timestamp. Caller supplies so tests can pin it; production passes
   * `new Date().toISOString()`.
   */
  cycledAt: string;
}

/**
 * Build the one-line summary sentence. Shape:
 * `repo-admin[<alias>] cycled (<reason>): <N> active ticket(s), <M>
 * worktree(s) in use, <K> open PR(s). prev=<sid> next=<sid>.`
 *
 * Kept as a single line so the decisions-board list view renders it
 * without wrapping, and so the BE's audit export can grep for cycle
 * events by the `repo-admin[<alias>] cycled` prefix.
 */
export function buildCycleSummaryLine(args: BuildCycleDecisionArgs): string {
  const { alias, previousSessionId, nextSessionId, snapshot } = args;
  const ticketCount = snapshot.activeTickets.length;
  const worktreeCount = snapshot.worktreesInUse.length;
  const prCount = snapshot.openPrs.length;
  return (
    `repo-admin[${alias}] cycled (${snapshot.cycleReason}): ` +
    `${ticketCount} active ticket(s), ${worktreeCount} worktree(s) in use, ` +
    `${prCount} open PR(s). prev=${previousSessionId} next=${nextSessionId}.`
  );
}

/**
 * Build the complete decision payload the session hands to
 * {@link ChannelStore.recordDecision}. Pure — no IO, no side effects.
 */
export function buildCycleDecision(args: BuildCycleDecisionArgs): CycleDecisionInput {
  const line = buildCycleSummaryLine(args);

  // The rationale mirrors the user-facing framing ("repo-admin forgets
  // completed tickets") so operators browsing the decisions board see the
  // WHY, not just the WHAT. Implementation detail (token pressure vs.
  // manual) lives in `metadata.cycleReason` for filtering.
  const rationale =
    args.snapshot.cycleReason === "budget-60pct"
      ? "Repo-admin context crossed the 60% budget ceiling; recycling the child process " +
        "to shed the accumulated context. The newly-respawned admin rebuilds its " +
        "working set by reading this decisions board."
      : "Manual recycle requested. The newly-respawned admin rebuilds its working " +
        "set by reading this decisions board.";

  return {
    runId: null,
    ticketId: null,
    title: line,
    description: line,
    rationale,
    alternatives: [],
    // Attribution: the cycle is a system action, not a human decision.
    // Using `repo-admin:<alias>` mirrors the pattern
    // `src/cli/run-autonomous.ts` uses for autonomous-session decisions
    // (e.g. `invokedBy.user`), so the GUI avatar/name resolver can
    // display it consistently.
    decidedBy: `repo-admin:${args.alias}`,
    decidedByName: `repo-admin[${args.alias}]`,
    linkedArtifacts: [],
    type: "repo_admin_cycle",
    metadata: {
      ...args.snapshot,
      alias: args.alias,
      previousSessionId: args.previousSessionId,
      nextSessionId: args.nextSessionId,
      cycledAt: args.cycledAt,
    },
  };
}
