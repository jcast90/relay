import { z } from "zod";

/**
 * Structured review output produced by AL-5's PR reviewer wrapper. Populated
 * only when the PR was opened by an autonomous ticket (i.e. the
 * `openedByAutonomous` flag on the tracked row is `true`) and the
 * `pr-review-toolkit:code-reviewer` subagent has run against it. Absent on
 * manual `rly pr-watch` rows — those are strictly out of AL-5's scope.
 *
 * Mirrors the shape the reviewer parser returns from the subagent's stdout:
 * `blocking`/`nits` are integer counts of BLOCKING/NIT markers in the
 * review prose, `files` lists every file path the reviewer called out, and
 * `summary` is the 1-3 sentence headline the reviewer wrote. `status` is
 * the review outcome as the reviewer saw it:
 *   - `ready_for_human_ack` — supervised mode, review ran, awaiting a
 *     human to acknowledge before merge.
 *   - `inconclusive` — parser couldn't extract BLOCKING/NIT/OK markers
 *     from the reviewer output; surfaced as a warning on the feed.
 *   - `error` — the subagent spawn itself failed (binary missing, timeout).
 */
export const PrReviewFindingsSchema = z.object({
  blocking: z.number().int().nonnegative(),
  nits: z.number().int().nonnegative(),
  files: z.array(z.string()),
  summary: z.string(),
  status: z.enum(["ready_for_human_ack", "inconclusive", "error"]),
  reviewedAt: z.string(),
});

export type PrReviewFindings = z.infer<typeof PrReviewFindingsSchema>;

/**
 * Persisted snapshot of a tracked PR row — the TUI and GUI read this to
 * mirror what `rly pr-status` prints without needing an IPC channel into
 * the live `PrPoller`. The `PrWatcher` writes these to
 * `~/.relay/channels/<channelId>/tracked-prs.json` (plus a sibling
 * `tracked-prs-all.json` aggregating across all channels) on every poll
 * tick and on track/untrack transitions. Shape stays in sync with the
 * `TrackedPrRow` struct in `crates/harness-data/src/lib.rs`.
 *
 * `ci`, `review`, and `prState` are nullable so a row added but not yet
 * polled still renders rather than being dropped — the CLI already shows
 * "-" for unknown fields and we preserve that semantic.
 *
 * `openedByAutonomous` (AL-5) marks rows that originated from an
 * autonomous ticket's worker so the PR reviewer knows to fire against
 * them; manual `rly pr-watch` rows default to `false` and are skipped by
 * the reviewer. Optional for back-compat with tracked-prs files written
 * before AL-5; readers MUST treat a missing value as `false`.
 *
 * `reviewFindings` (AL-5) carries the structured output of the
 * `pr-review-toolkit:code-reviewer` subagent. Absent until the reviewer
 * has run; `status` inside it is the review outcome (see
 * {@link PrReviewFindingsSchema}).
 */
export const TrackedPrRowSchema = z.object({
  ticketId: z.string(),
  channelId: z.string(),
  owner: z.string(),
  name: z.string(),
  number: z.number(),
  url: z.string(),
  branch: z.string(),
  ci: z.string().nullable(),
  review: z.string().nullable(),
  prState: z.string().nullable(),
  updatedAt: z.string(),
  openedByAutonomous: z.boolean().optional(),
  reviewFindings: PrReviewFindingsSchema.optional(),
});

export type TrackedPrRow = z.infer<typeof TrackedPrRowSchema>;

export const TrackedPrFileSchema = z.object({
  updatedAt: z.string(),
  rows: z.array(TrackedPrRowSchema),
});

export type TrackedPrFile = z.infer<typeof TrackedPrFileSchema>;
