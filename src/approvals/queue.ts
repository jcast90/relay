import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { getRelayDir } from "../cli/paths.js";

/**
 * Kinds of ack-requiring actions AL-7 queues under supervised trust mode.
 *
 * The queue is deliberately typed on a small closed set rather than an open
 * string: every new kind requires a corresponding CLI surface in AL-8 and a
 * schema decision here, so adding one should be a visible code change, not a
 * caller-supplied string.
 *
 *  - `merge-pr`: produced by AL-5's PR-review-complete hook. Payload carries
 *    the PR URL + review summary so an operator can approve/reject without
 *    re-running the review.
 *  - `create-ticket`: produced by AL-6's audit-proposal hook. Payload carries
 *    the proposed ticket body that would otherwise be written directly into
 *    the channel ticket board under god mode.
 */
export type ApprovalKind = "merge-pr" | "create-ticket";

/**
 * Approval lifecycle states. Queue records start `pending`; the CLI surface
 * in AL-8 transitions them to `approved` or `rejected`. No other transitions
 * are legal — once a record leaves `pending` it is terminal and the
 * consumer (AL-4 driver / future workers) must treat it as immutable.
 */
export type ApprovalStatus = "pending" | "approved" | "rejected";

/**
 * Payload for a queued PR auto-merge proposal. Shape matches what the AL-5
 * PR-reviewer produces at review-complete time. Optional fields exist so
 * AL-5's integration point can evolve without breaking AL-7 tests — the
 * minimum contract is `prUrl`.
 */
export interface MergePrPayload {
  /** Canonical PR URL (e.g. `https://github.com/foo/bar/pull/42`). */
  prUrl: string;
  /** Optional one-paragraph review summary from the reviewer agent. Rendered
   * as the approval card body in AL-8. */
  reviewSummary?: string;
  /** Optional run id the review came from, for cross-referencing the feed. */
  runId?: string;
}

/**
 * Payload for a queued audit-agent ticket proposal. Mirrors the minimum
 * subset of a ticket board row the audit agent (AL-6) produces when it
 * suggests a new remediation ticket. Approval in AL-8 writes the ticket to
 * the channel board; rejection discards it. Required fields are kept to
 * just `title` + `body` so AL-6's eventual integration point is not
 * pre-constrained.
 */
export interface CreateTicketPayload {
  /** Ticket title — human-readable, one line. */
  title: string;
  /** Ticket body — markdown, free-form. */
  body: string;
  /** Optional channel id the audit agent thinks the ticket belongs on. When
   * absent, AL-8 prompts the operator to choose. */
  channelId?: string;
  /** Optional rationale string from the audit agent. */
  rationale?: string;
}

/** Union of all payload variants, discriminated by the record's `kind`. */
export type ApprovalPayload =
  | { kind: "merge-pr"; payload: MergePrPayload }
  | { kind: "create-ticket"; payload: CreateTicketPayload };

/**
 * On-disk record shape written to `~/.relay/approvals/<sessionId>/queue.jsonl`.
 * One JSON object per line, appended atomically (`appendFile` with a
 * <PIPE_BUF JSON payload is atomic on POSIX).
 *
 * Decision state is mutated by reading the file, filtering to the target id,
 * and writing a follow-up "decision" record — the file is NOT a log of
 * immutable appends, it's a stack of records keyed by id where the newest
 * record for a given id wins. `list()` collapses duplicates to the latest
 * entry per id. This keeps atomicity cheap (every mutation is still a
 * single append) while preserving the linear-history shape the AL-8 CLI
 * will render.
 */
export interface ApprovalRecord {
  /** Stable id. UUID v4. */
  id: string;
  /** Autonomous-session id the record belongs to. Partitions the queue
   * file path — one `queue.jsonl` per session. */
  sessionId: string;
  /** Action kind — see {@link ApprovalKind}. */
  kind: ApprovalKind;
  /** Action payload, discriminated by {@link ApprovalKind}. */
  payload: MergePrPayload | CreateTicketPayload;
  /** ISO-8601 timestamp the record was enqueued. */
  createdAt: string;
  /** Current lifecycle state. */
  status: ApprovalStatus;
  /** ISO-8601 timestamp of the most recent `approve()` / `reject()` call.
   * Absent while `status === "pending"`. */
  decidedAt?: string;
  /** Free-form operator feedback supplied on `reject()`. */
  feedback?: string;
}

/** Input to {@link ApprovalsQueue.enqueue}. The queue owns `id`, `createdAt`,
 * and `status` — callers supply the session + action. */
export interface EnqueueInput {
  sessionId: string;
  kind: ApprovalKind;
  payload: MergePrPayload | CreateTicketPayload;
}

/** Filter options for {@link ApprovalsQueue.list}. */
export interface ListOptions {
  /** When set, return only records with this status. */
  status?: ApprovalStatus;
}

/** Options for {@link ApprovalsQueue}. Tests inject `rootDir` + `clock` +
 * `idFactory` so on-disk state + timestamps + record ids are deterministic. */
export interface ApprovalsQueueOptions {
  /** Override `~/.relay`. Defaults to {@link getRelayDir}. */
  rootDir?: string;
  /** Clock injection. Defaults to `Date.now`. */
  clock?: () => number;
  /** Id factory. Defaults to `crypto.randomUUID`. */
  idFactory?: () => string;
}

/**
 * File-backed approvals queue. One queue file per autonomous session lives
 * at `~/.relay/approvals/<sessionId>/queue.jsonl`.
 *
 * Concurrency model:
 *   - `enqueue` appends one line (atomic on POSIX for a single <PIPE_BUF
 *     write). Multiple `enqueue` calls from the same process never
 *     interleave bytes.
 *   - `approve` / `reject` append a *new* record with the same `id` and
 *     an updated `status` / `decidedAt` / `feedback`. `list` collapses to
 *     the newest entry per id. This makes every mutation a single atomic
 *     append — no read-modify-write races — at the cost of a log that
 *     grows linearly with decision count. For AL-7's scale (human-rate
 *     approvals, tens per session) this is cheap and the simplicity is
 *     worth more than compaction.
 *   - Crashes mid-write leave at worst a truncated trailing line, which
 *     `list` tolerates by skipping unparseable lines with a warning.
 *
 * The queue file is append-only in the file-system sense (no in-place
 * mutation), matching the repo-wide convention from
 * `channel-store.postEntry` / `feed.jsonl`. Callers must NOT rewrite the
 * file; they must go through `enqueue` / `approve` / `reject`.
 */
export class ApprovalsQueue {
  private readonly rootDir: string;
  private readonly clock: () => number;
  private readonly idFactory: () => string;

  constructor(options: ApprovalsQueueOptions = {}) {
    this.rootDir = options.rootDir ?? getRelayDir();
    this.clock = options.clock ?? Date.now;
    this.idFactory = options.idFactory ?? randomUUID;
  }

  /**
   * Compute the queue-file path for a session. Exposed primarily for tests
   * and the AL-8 CLI — internal callers go through the other methods.
   */
  queuePath(sessionId: string): string {
    return join(this.rootDir, "approvals", sessionId, "queue.jsonl");
  }

  /**
   * Append a new pending approval. Returns the full record (id + timestamps
   * + status) so the caller can thread the id into the channel feed / audit
   * decision entry without a second read of the queue file.
   */
  async enqueue(input: EnqueueInput): Promise<ApprovalRecord> {
    const record: ApprovalRecord = {
      id: this.idFactory(),
      sessionId: input.sessionId,
      kind: input.kind,
      payload: input.payload,
      createdAt: new Date(this.clock()).toISOString(),
      status: "pending",
    };

    const path = this.queuePath(input.sessionId);
    await mkdir(join(this.rootDir, "approvals", input.sessionId), { recursive: true });
    // `appendFile` with a single <PIPE_BUF line is atomic on POSIX — no
    // interleave with concurrent appenders from the same process. Matches
    // the pattern from `src/budget/token-tracker.ts` and
    // `src/channels/channel-store.ts`.
    await appendFile(path, JSON.stringify(record) + "\n", "utf8");
    return record;
  }

  /**
   * Return every record for `sessionId`, newest-wins collapse per id,
   * filtered by `options.status` when provided.
   *
   * Missing queue file -> empty array (the session simply has no queued
   * approvals yet). Unparseable trailing lines are skipped — they can
   * only happen if a concurrent writer crashed mid-append, in which case
   * the partial record is indistinguishable from "never written" and
   * swallowing it is safe.
   */
  async list(sessionId: string, options: ListOptions = {}): Promise<ApprovalRecord[]> {
    const path = this.queuePath(sessionId);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
      throw err;
    }

    const byId = new Map<string, ApprovalRecord>();
    const lines = raw.split("\n");
    for (const line of lines) {
      if (!line) continue;
      let parsed: ApprovalRecord;
      try {
        parsed = JSON.parse(line) as ApprovalRecord;
      } catch {
        // Torn write from a crashed concurrent appender. Skip; the record
        // effectively never existed.
        continue;
      }
      // Newest wins: subsequent writes for the same id (approve/reject)
      // replace the earlier pending record in the collapsed view.
      byId.set(parsed.id, parsed);
    }

    const collapsed = Array.from(byId.values());
    // Preserve insertion order from the file, which matches enqueue order
    // (Map retains insertion order in ES2015+). Callers who want a
    // different sort can do it themselves; the queue does not impose one.
    const filtered = options.status
      ? collapsed.filter((r) => r.status === options.status)
      : collapsed;
    return filtered;
  }

  /**
   * Mark a pending record approved. Throws when the id is unknown, matches
   * a different session, or the record is already in a terminal state — an
   * operator approving an already-approved record is almost certainly a
   * bug in the calling UI / double-click, and silently succeeding would
   * mask it.
   */
  async approve(sessionId: string, id: string): Promise<ApprovalRecord> {
    return this.decide(sessionId, id, "approved");
  }

  /**
   * Mark a pending record rejected. `feedback` is optional but recommended —
   * it lets the proposing agent (AL-5 / AL-6) refine its next output.
   * Throws on the same failure modes as {@link approve}.
   */
  async reject(sessionId: string, id: string, feedback?: string): Promise<ApprovalRecord> {
    return this.decide(sessionId, id, "rejected", feedback);
  }

  private async decide(
    sessionId: string,
    id: string,
    status: "approved" | "rejected",
    feedback?: string
  ): Promise<ApprovalRecord> {
    const existing = await this.list(sessionId);
    const current = existing.find((r) => r.id === id);
    if (!current) {
      throw new Error(`approvals queue: no record with id "${id}" on session "${sessionId}"`);
    }
    if (current.sessionId !== sessionId) {
      // Defence-in-depth: list() already filters on the session-scoped file
      // path, so a mismatch here means someone hand-edited the JSONL.
      throw new Error(
        `approvals queue: record "${id}" belongs to session "${current.sessionId}", not "${sessionId}"`
      );
    }
    if (current.status !== "pending") {
      throw new Error(
        `approvals queue: record "${id}" is already ${current.status}; decisions are terminal`
      );
    }

    const updated: ApprovalRecord = {
      ...current,
      status,
      decidedAt: new Date(this.clock()).toISOString(),
      ...(feedback !== undefined ? { feedback } : {}),
    };

    const path = this.queuePath(sessionId);
    await appendFile(path, JSON.stringify(updated) + "\n", "utf8");
    return updated;
  }

  /**
   * Rewrite the queue file in collapsed form — only the newest record per
   * id. Not called by {@link enqueue} / {@link approve} / {@link reject};
   * exposed so operators / AL-8 can compact a long-running session's
   * queue offline without touching live state.
   *
   * Write is atomic (tmp + rename) so a crash mid-compact leaves the
   * original file intact.
   */
  async compact(sessionId: string): Promise<number> {
    const records = await this.list(sessionId);
    const path = this.queuePath(sessionId);
    await mkdir(join(this.rootDir, "approvals", sessionId), { recursive: true });
    const tmp = `${path}.tmp.${process.pid}.${this.clock()}`;
    const body = records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : "");
    await writeFile(tmp, body, "utf8");
    await rename(tmp, path);
    return records.length;
  }
}
