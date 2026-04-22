import type { TrustMode } from "../cli/run-autonomous.js";
import type {
  ApprovalRecord,
  ApprovalsQueue,
  CreateTicketPayload,
  MergePrPayload,
} from "./queue.js";

/**
 * Env var gating the god-mode auto-merge / auto-create path. AL-7 requires
 * that god mode's bypass-the-queue behaviour sit behind a separate flag from
 * the `--trust god` CLI switch so an operator who explicitly asked for god
 * mode still has to opt into the destructive side-effects. Until this flag
 * is flipped, god mode falls back to the queue path (same as supervised)
 * and the decision is surfaced for a human ack.
 *
 * This two-level gate — `trust === "god"` AND `RELAY_AL7_GOD_AUTOMERGE=1` —
 * is the minimum viable guard against a stale `god` flag in a session file
 * accidentally merging PRs after the codebase has moved on. Both must be
 * true for auto-execute to fire.
 *
 * Recognised true-ish values: `"1"`, `"true"`, `"yes"`, `"on"`
 * (case-insensitive). Anything else is treated as off.
 */
export const RELAY_AL7_GOD_AUTOMERGE = "RELAY_AL7_GOD_AUTOMERGE";

/**
 * Parse {@link RELAY_AL7_GOD_AUTOMERGE} into a bool. Separate function so
 * tests can inject a stub env without mutating `process.env`.
 */
export function isGodAutomergeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[RELAY_AL7_GOD_AUTOMERGE];
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

/**
 * Discriminated-union shape describing an ack-requiring action. Callers
 * (AL-5's PR-reviewer, AL-6's audit agent) construct one of these and hand
 * it to {@link decide} along with the session's trust mode. The shape
 * deliberately mirrors the `queue.ts` payload variants so the trust gate
 * is a thin wrapper and the queue's schema stays the single source of
 * truth for what each action kind carries.
 */
export type Action =
  | { kind: "merge-pr"; payload: MergePrPayload }
  | { kind: "create-ticket"; payload: CreateTicketPayload };

/**
 * Result of {@link decide}. Two shapes:
 *
 *  - `{kind: "execute", auditRecordId, record}` — caller runs the action
 *    immediately (god mode + `RELAY_AL7_GOD_AUTOMERGE` on). The gate has
 *    already written an auto-approved audit record to the session's queue
 *    with `autoApprovedBy: "god-mode"`, so every god-mode execution
 *    leaves a persistent trail even if the caller never re-reads it.
 *    `auditRecordId` is the id of that record so the caller can correlate
 *    the executed action (merge URL, created ticket id) back to the audit
 *    entry in the feed.
 *  - `{kind: "enqueue", approvalId, record}` — caller must NOT execute.
 *    The gate has already written a pending record to the approvals queue
 *    for `sessionId`; AL-8's CLI surface (or a future human review UI)
 *    will transition it to `approved` / `rejected`. The caller's duty is
 *    to surface the approval id back to the session feed so an operator
 *    can find it.
 */
export type Decision =
  | { kind: "execute"; auditRecordId: string; record: ApprovalRecord }
  | { kind: "enqueue"; approvalId: string; record: ApprovalRecord };

/**
 * Input for {@link decide}. `trust` is threaded explicitly — AL-7 forbids
 * implicit globals so every ack-requiring call site has to pass the mode
 * through. Passing `"god"` is necessary but not sufficient for execute;
 * see {@link RELAY_AL7_GOD_AUTOMERGE}.
 */
export interface DecideInput {
  sessionId: string;
  trust: TrustMode;
  action: Action;
  /** Injected queue. Required — the gate never constructs one itself so
   * the caller owns `~/.relay/` root resolution. */
  queue: ApprovalsQueue;
  /** Injectable env for testing the god flag path. Defaults to
   * `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Trust-mode gate. Given an ack-requiring action and the session's trust
 * mode, returns either "execute now" or "enqueue for human ack."
 *
 * Decision matrix:
 *
 *   | trust mode  | RELAY_AL7_GOD_AUTOMERGE | result                          |
 *   |-------------|-------------------------|---------------------------------|
 *   | supervised  | (any)                   | enqueue (pending)               |
 *   | god         | off                     | enqueue (pending, safety fall-back) |
 *   | god         | on                      | execute (+ auto-approved audit record) |
 *
 * Supervised NEVER auto-merges / auto-tickets under any env setting —
 * that's the whole point of the mode. The env flag only unlocks god mode's
 * fast path; flipping the flag without the `--trust god` CLI switch is a
 * no-op.
 *
 * Side effects:
 *   - enqueue branch: writes one pending record to the session's queue
 *     file via `queue.enqueue`.
 *   - execute branch: writes one auto-approved audit record to the same
 *     queue via `queue.enqueueAutoApproved` (status `"approved"`,
 *     `autoApprovedBy: "god-mode"`, `decidedAt` stamped by the queue's
 *     clock). The caller still owns the actual side effect (merge / ticket
 *     write); the audit record is the durable trail that the side effect
 *     was authorised, so a stale `RELAY_AL7_GOD_AUTOMERGE=1` can never
 *     merge a PR with zero persistent evidence.
 */
export async function decide(input: DecideInput): Promise<Decision> {
  const env = input.env ?? process.env;
  const automergeEnabled = isGodAutomergeEnabled(env);

  if (input.trust === "god" && automergeEnabled) {
    const record = await input.queue.enqueueAutoApproved({
      sessionId: input.sessionId,
      kind: input.action.kind,
      payload: input.action.payload,
      autoApprovedBy: "god-mode",
    });
    return { kind: "execute", auditRecordId: record.id, record };
  }

  // Supervised or god-with-flag-off: enqueue.
  const record = await input.queue.enqueue({
    sessionId: input.sessionId,
    kind: input.action.kind,
    payload: input.action.payload,
  });

  return { kind: "enqueue", approvalId: record.id, record };
}
