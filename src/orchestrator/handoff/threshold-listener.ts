/**
 * Phase 2 PR-3: 90% context-threshold listener.
 *
 * Watches a channel's `feed.jsonl` (via `ChannelStore.readFeed`) for the
 * Phase 1 `context_threshold` contract — `entry.type === "status_update"`,
 * `entry.metadata.kind === "context_threshold"`,
 * `entry.metadata.schemaVersion === "1"`,
 * `entry.metadata.sessionId === <our session>`,
 * `entry.metadata.threshold === "90"` — and enqueues exactly one
 * `ApprovalsQueue` record of `kind: "handoff-prompt"` per (sessionId,
 * threshold) crossing. The user then approves / rejects via the existing
 * AL-7 / AL-8 surfaces (`rly approve <id>` / `rly reject <id>`); rejection
 * is a no-op terminal state and the running session simply continues.
 *
 * Phase 1 → Phase 2 contract surface (inherited verbatim from Phase 1
 * PLAN's `<phase_2_handoff_contract>` block — see Phase 2 PLAN's
 * `<phase_2_handoff_contract_inherited_from_phase_1>`):
 *   - All `metadata` values arrive as STRINGS on the wire. Per M1, this
 *     module is the ONLY place that converts `metadata.threshold` /
 *     `metadata.pct` / `metadata.used` / `metadata.total` to numbers, and
 *     the conversion happens exactly once at the listener boundary.
 *   - Crossings are single-emit per (sessionId, threshold). In-process
 *     dedup uses an in-memory `Set<string>` keyed `<sessionId>::<threshold>`;
 *     restart-idempotency seeds that set from the existing approvals queue
 *     by reading `approvalsQueue.list(sessionId)` and filtering
 *     `kind === "handoff-prompt"` in JS. Per H1, the actual signature is
 *     `list(sessionId)` (positional, no `{ kind, sessionId }` shape).
 *   - The listener does NOT import from `src/budget/`. Phase 2 owns the
 *     handoff UX; Phase 1 owns telemetry. The contract is read via the
 *     channel feed.
 *
 * Self-loop disjointness (L6): if the listener ever posts its own
 * follow-up signaling entries to the same channel feed, those carry
 * `metadata.handoffPrompt: true` (NOT `metadata.kind: "context_threshold"`).
 * The poll predicate filters on `metadata.kind === "context_threshold"`,
 * so the listener cannot match its own posts. The two predicates are
 * disjoint by construction — there is no self-loop, and we can post
 * freely without filtering our own writes.
 */

import type { ApprovalsQueue } from "../../approvals/queue.js";
import type { ChannelStore } from "../../channels/channel-store.js";
import type { ChannelEntry } from "../../domain/channel.js";
import type { HandoffPromptPayload } from "../../domain/handoff.js";
import { HANDOFF_BRIEF_SCHEMA_VERSION } from "../../domain/handoff.js";

/**
 * Default poll interval for the threshold listener (M8).
 *
 * 5s default: context crossings are minutes-scale (token budgets are
 * 100K-1M), not sub-second. Tests pass `pollIntervalMs: 50` to keep
 * wall-clock under 200ms. Tradeoff: a 5s lag between Phase 1 emitting a
 * `context_threshold` entry and the user seeing the prompt is
 * acceptable; reducing this to 1s would 5× the readdir/readFile load on
 * a 5-session orchestrator with no UX benefit.
 */
export const DEFAULT_HANDOFF_THRESHOLD_POLL_MS = 5000;

export interface AttachHandoffThresholdListenerOptions {
  channelStore: ChannelStore;
  approvalsQueue: ApprovalsQueue;
  /** Channel whose feed.jsonl is polled for context_threshold entries. */
  channelId: string;
  /**
   * Session id this listener subscribes to. The poll predicate filters
   * `entry.metadata.sessionId === sessionId` so two listeners on the
   * same channel feed (different sessions) do not cross-fire. Asserted
   * by `threshold-listener.test.ts`'s H2b two-session test.
   */
  sessionId: string;
  /** Default {@link DEFAULT_HANDOFF_THRESHOLD_POLL_MS}. */
  pollIntervalMs?: number;
}

export interface HandoffThresholdSubscription {
  /** Stop polling and release the timer. Idempotent. */
  unsubscribe: () => void;
}

/**
 * Attach a feed-polling listener that converts Phase 1 90%-threshold
 * crossings into AL-7 handoff-prompt approvals.
 *
 * Returns a subscription handle whose `unsubscribe()` clears the poll
 * timer. The timer is `unref()`'d so the listener never holds the
 * process open by itself.
 *
 * Errors during poll are swallowed and logged via `console.warn`
 * (best-effort): a transient `readFeed` failure must not crash the
 * orchestrator's autonomous loop.
 */
export function attachHandoffThresholdListener(
  options: AttachHandoffThresholdListenerOptions
): HandoffThresholdSubscription {
  const { channelStore, approvalsQueue, channelId, sessionId } = options;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_HANDOFF_THRESHOLD_POLL_MS;

  // In-process dedup. Keyed `<sessionId>::<threshold-as-string>`. The
  // outer `<sessionId>` partition is redundant for a single listener
  // (we filter feed entries to our session above) but cheap, and it
  // means a future shared-listener refactor inherits the right key
  // shape without churn. Per H1: the payload contract has NO
  // `entryId` field; restart dedup is by (sessionId, threshold) only.
  const seenCrossings = new Set<string>();
  const crossingKey = (sid: string, thresholdStr: string): string => `${sid}::${thresholdStr}`;

  // Restart-idempotency seed (H1): fetch existing approvals for this
  // session, filter to `kind === "handoff-prompt"` in JS, and seed the
  // in-process Set with each record's `(sessionId, thresholdPct)`. After
  // an orchestrator restart, the process re-attaches the listener, the
  // seed runs once, and any prior 90% crossing for this session is
  // already known — the next poll will not re-enqueue.
  let seededPromise: Promise<void> | null = null;
  const ensureSeeded = (): Promise<void> => {
    if (seededPromise) return seededPromise;
    seededPromise = (async () => {
      try {
        const existing = await approvalsQueue.list(sessionId);
        for (const rec of existing) {
          if (rec.kind !== "handoff-prompt") continue;
          // payload.thresholdPct is a NUMBER (M1); the in-memory key
          // tracks the wire-format STRING form so feed predicates and
          // dedup keys agree byte-for-byte. `"90"` and `90`.toString()
          // are both `"90"` — safe.
          const payload = rec.payload as HandoffPromptPayload;
          seenCrossings.add(crossingKey(rec.sessionId, String(payload.thresholdPct)));
        }
      } catch (err) {
        console.warn(
          `[handoff-threshold-listener] seedThresholds failed: ${(err as Error).message}`
        );
      }
    })();
    return seededPromise;
  };

  let stopped = false;

  const poll = async (): Promise<void> => {
    if (stopped) return;
    await ensureSeeded();
    let entries: ChannelEntry[];
    try {
      entries = await channelStore.readFeed(channelId);
    } catch (err) {
      console.warn(`[handoff-threshold-listener] readFeed failed: ${(err as Error).message}`);
      return;
    }

    for (const entry of entries) {
      if (stopped) return;
      // Phase 1 contract predicate. Five conjuncts kept on separate
      // lines so a future contract-version bump shows a clean diff. Note
      // that this predicate is DISJOINT from the listener's own follow-up
      // posts (which would carry `metadata.handoffPrompt: true`, not
      // `metadata.kind: "context_threshold"`) — see L6 in the module
      // docstring; no self-loop.
      const md = entry.metadata as Record<string, unknown> | undefined;
      if (!md) continue;
      if (entry.type !== "status_update") continue;
      if (md.kind !== "context_threshold") continue;
      if (md.schemaVersion !== "1") continue; // T-02-12: schema-version drift fails closed
      if (md.sessionId !== sessionId) continue;
      if (md.threshold !== "90") continue;

      const thresholdStr = String(md.threshold);
      const key = crossingKey(sessionId, thresholdStr);
      if (seenCrossings.has(key)) continue;
      seenCrossings.add(key);

      // M1: STRING→NUMBER conversion happens HERE, exactly once per
      // crossing. No other code path coerces these wire fields.
      const thresholdPct = Number(md.threshold);
      const used = Number(md.used);
      const total = Number(md.total);
      const pct = Number(md.pct);

      const channelIdMeta = typeof md.channelId === "string" ? md.channelId : channelId;
      const promptText = `Context at ${pct}% — consider running \`rly handoff\` to brief a fresh session before the window fills up.`;

      const payload: HandoffPromptPayload = {
        schemaVersion: HANDOFF_BRIEF_SCHEMA_VERSION,
        channelId: channelIdMeta,
        sessionId,
        thresholdPct,
        used,
        total,
        promptText,
      };

      try {
        await approvalsQueue.enqueue({ sessionId, kind: "handoff-prompt", payload });
      } catch (err) {
        // Roll back the dedup mark so a transient enqueue failure does
        // not silently swallow this crossing — the next poll retries.
        seenCrossings.delete(key);
        console.warn(`[handoff-threshold-listener] enqueue failed: ${(err as Error).message}`);
      }
    }
  };

  // Fire one immediate poll so a feed entry that landed before attach
  // is picked up without waiting a full interval. Errors swallowed
  // (poll handles them internally).
  void poll();

  const handle = setInterval(() => {
    void poll();
  }, pollIntervalMs);
  // Don't keep the event loop alive on the listener's behalf. The
  // owning autonomous loop (or test harness) controls process lifetime.
  if (typeof handle.unref === "function") handle.unref();

  return {
    unsubscribe: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(handle);
    },
  };
}
