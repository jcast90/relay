/**
 * AL-16: typed inter-repo coordination messages.
 *
 * Repo-admins (AL-11/AL-12) running against different repos need to
 * coordinate cross-repo work — "my ticket can't ship until your ticket
 * merges", "my PR is ready, you can unblock", "here's the merge order
 * that makes sense". Before AL-16 those handoffs went through free-text
 * chat; the consumer admin had to prompt-engineer the shape out of a
 * string. That works in a controlled demo and falls apart the moment an
 * admin rephrases or hallucinates a field.
 *
 * AL-16 narrows the channel to three typed shapes. Every cross-admin
 * message MUST validate against one of the discriminated-union variants
 * below or it gets rejected with a structured error. The schemas are the
 * boundary contract; the {@link Coordinator} (see ./coordinator.ts) is
 * the runtime bus that routes validated messages between admins.
 *
 * ## Scope discipline
 *
 * These shapes are a message bus + audit trail only. They do NOT encode
 * merge-order enforcement, approvals, or scheduler decisions — those
 * belong to AL-5 / AL-7 / AL-8 and intentionally stay out of this layer.
 * A `merge-order-proposal`, for example, is advisory: a repo-admin
 * writes it to record the rationale; the scheduler is free to read it
 * via the decisions board and act or not. Keeping the bus dumb lets us
 * swap the enforcement layer later without rewriting the wire format.
 *
 * ## Why discriminated union on `kind`
 *
 * Zod's `discriminatedUnion` gives us O(1) dispatch + exhaustive checks
 * at compile time. Agents (and tests) pattern-match on `msg.kind` to
 * branch their handler; adding a new shape requires adding both the
 * schema and the TS discriminator, which keeps the MCP tool validation
 * and the consumer code honest.
 */

import { z } from "zod";

/**
 * `requester` (the admin raising the block) cannot proceed on
 * `ticketId` until `blocker` completes `dependsOnTicketId`. The message
 * is informative — the coordinator records it and relays it to the
 * blocker, but it does not pause the requester's own execution. The
 * requester's repo-admin prompt drives the wait via the Coordinator's
 * {@link Coordinator.waitFor} helper (see ./coordinator.ts).
 */
export const BlockedOnRepoSchema = z
  .object({
    kind: z.literal("blocked-on-repo"),
    /** Admin alias raising the block (e.g. `"backend"`). */
    requester: z.string().min(1),
    /** Admin alias the request is addressed to (e.g. `"frontend"`). */
    blocker: z.string().min(1),
    /** Ticket id the requester is trying to unblock. */
    ticketId: z.string().min(1),
    /** Ticket id on the blocker's board that must complete first. */
    dependsOnTicketId: z.string().min(1),
    /** Human-readable rationale. Surfaces on the decisions board + feed. */
    reason: z.string().min(1),
    /** ISO-8601 timestamp (coordinator stamps on send if omitted in source). */
    requestedAt: z.string().min(1),
  })
  .strict();

export type BlockedOnRepo = z.infer<typeof BlockedOnRepoSchema>;

/**
 * A repo-admin announces that a ticket it owns has reached a "ready for
 * the next repo to consume" milestone — either the PR is open or it
 * has merged. Consumers (admins waiting on {@link BlockedOnRepo}) use
 * this to unblock. `mergedAt` being set distinguishes "PR open but not
 * merged yet" from "merged and ready to ship in consumers".
 */
export const RepoReadySchema = z
  .object({
    kind: z.literal("repo-ready"),
    /** Admin alias that owns the ticket. */
    alias: z.string().min(1),
    /** Ticket id the announcement is about. */
    ticketId: z.string().min(1),
    /** PR URL — required so consumers can cross-reference their block. */
    prUrl: z.string().url(),
    /** ISO-8601 merge timestamp. Unset = PR open but not merged. */
    mergedAt: z.string().min(1).optional(),
    /** ISO-8601 announcement timestamp. */
    announcedAt: z.string().min(1),
  })
  .strict();

export type RepoReady = z.infer<typeof RepoReadySchema>;

/**
 * Advisory cross-repo merge ordering. A repo-admin that has visibility
 * across N open PRs can propose a sequence it believes satisfies the
 * dependency graph. The coordinator audits the proposal; enforcement
 * (if any) lives in the scheduler (AL-5 / AL-7). A later proposal does
 * NOT supersede an earlier one — both are recorded so the scheduler
 * has the full history when it makes its own call.
 */
export const MergeOrderProposalSchema = z
  .object({
    kind: z.literal("merge-order-proposal"),
    /** Admin alias putting the proposal on the table. */
    proposer: z.string().min(1),
    /** Ordered list of admin/ticket/PR triples representing the sequence. */
    sequence: z
      .array(
        z
          .object({
            alias: z.string().min(1),
            ticketId: z.string().min(1),
            prUrl: z.string().url(),
          })
          .strict()
      )
      .min(1),
    /** Why this sequence — surfaces on the decisions board for audit. */
    rationale: z.string().min(1),
    /** ISO-8601 proposal timestamp. */
    proposedAt: z.string().min(1),
  })
  .strict();

export type MergeOrderProposal = z.infer<typeof MergeOrderProposalSchema>;

/**
 * Discriminated union of every accepted AL-16 coordination shape. This
 * is the single validation boundary — the MCP tool surface, the
 * coordinator, and the decisions-board auditor all parse against this
 * schema. Adding a new shape is a one-liner here + matching handler
 * code; drive-by additions that skip this union don't type-check.
 */
export const CoordinationMessageSchema = z.discriminatedUnion("kind", [
  BlockedOnRepoSchema,
  RepoReadySchema,
  MergeOrderProposalSchema,
]);

export type CoordinationMessage = z.infer<typeof CoordinationMessageSchema>;

/** Literal set of accepted `kind` values. Handy for MCP tool schemas + tests. */
export const COORDINATION_MESSAGE_KINDS = [
  "blocked-on-repo",
  "repo-ready",
  "merge-order-proposal",
] as const;

export type CoordinationMessageKind = (typeof COORDINATION_MESSAGE_KINDS)[number];

/**
 * Parse a raw payload into a validated {@link CoordinationMessage}.
 * Returns `{ ok: true, message }` on success or `{ ok: false, error }`
 * with a short human-readable reason. Callers should prefer this over
 * `CoordinationMessageSchema.parse(...)` directly so the "malformed →
 * structured error, never silent drop" (AC4) contract stays in one
 * place.
 */
export function parseCoordinationMessage(
  raw: unknown
): { ok: true; message: CoordinationMessage } | { ok: false; error: string; issues: z.ZodIssue[] } {
  const result = CoordinationMessageSchema.safeParse(raw);
  if (result.success) {
    return { ok: true, message: result.data };
  }
  // Short, deterministic error summary: `kind: required` > join with `; `.
  // Full issues list is returned alongside so callers that want structured
  // detail (MCP tool error envelope) can surface it verbatim.
  const error = result.error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
  return { ok: false, error, issues: result.error.issues };
}
