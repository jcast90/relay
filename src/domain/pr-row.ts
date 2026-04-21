import { z } from "zod";

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
  updatedAt: z.string()
});

export type TrackedPrRow = z.infer<typeof TrackedPrRowSchema>;

export const TrackedPrFileSchema = z.object({
  updatedAt: z.string(),
  rows: z.array(TrackedPrRowSchema)
});

export type TrackedPrFile = z.infer<typeof TrackedPrFileSchema>;
