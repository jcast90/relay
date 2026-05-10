import type { ChannelStore } from "../channels/channel-store.js";
import type { ThresholdEvent, TokenTracker } from "./token-tracker.js";

/**
 * Default subset of the canonical {@link ../budget/token-tracker.js THRESHOLDS}
 * that this bridge forwards to the channel feed. Other thresholds still fire
 * on the in-process EventEmitter for in-process subscribers (e.g.
 * `RepoAdminSession`'s 60% memory-shed cycle in
 * `src/orchestrator/repo-admin-session.ts`); they are simply not posted to
 * the channel feed here.
 *
 * Phase 2's handoff planner subscribes to `entry.metadata.threshold === "90"`
 * — see `docs/design/context-threshold-events.md` for the cross-phase
 * contract.
 */
const DEFAULT_POST_THRESHOLDS = [75, 90, 95] as const;

export interface ThresholdFeedOptions {
  /**
   * Subset of `THRESHOLDS` (token-tracker.ts:21) to forward to the channel
   * feed. Defaults to {@link DEFAULT_POST_THRESHOLDS}. Other thresholds
   * still fire on the in-process EventEmitter for in-process subscribers
   * (e.g. RepoAdminSession's 60% memory-shed subscriber); they are simply
   * not posted to the channel feed here.
   */
  postThresholds?: readonly number[];
  /**
   * Optional model name surfaced as `metadata.model` for downstream
   * readers. The GUI's worst-session chip displays it so the operator
   * knows which session crossed.
   */
  modelName?: string;
}

/**
 * Subscribe a {@link TokenTracker} to the channel feed: every threshold
 * crossing in {@link ThresholdFeedOptions.postThresholds} (default 75/90/95)
 * triggers one `status_update` `ChannelEntry` with
 * `metadata.kind === "context_threshold"`. Returns an unsubscribe handle —
 * the caller (typically `OrchestratorV2.waitForPendingWrites`) must invoke
 * it before tearing down the channel store.
 *
 * **Stable metadata contract** (Phase 2 handoff subscriber relies on this —
 * see `docs/design/context-threshold-events.md`):
 *
 *   - `kind`: always `"context_threshold"` (the discriminator).
 *   - `schemaVersion`: `"1"` (string). Bumping requires a coordinated update
 *     across Phase 1 and Phase 2 codepaths.
 *   - `threshold`: integer-as-string (`"75"` | `"90"` | `"95"`).
 *   - `pct`: fixed-2-decimal string matching `/^\d+\.\d{2}$/` (M7 — pinned by
 *     `test/budget/threshold-feed-bridge.test.ts`).
 *   - `used` / `total`: token counts, integer-as-string.
 *   - `sessionId`: the chat sessionId. After a Phase-2 handoff, the
 *     destination provider gets a NEW sessionId — Phase 2 owns the
 *     uniqueness invariant (D-03 + M8 sharpening).
 *   - `model?`: optional, only set when {@link ThresholdFeedOptions.modelName}
 *     is supplied.
 *
 * Best-effort: a channel-post failure logs `[threshold-feed] post failed`
 * via `console.warn` but never throws — the listener stays attached so a
 * single transient write failure doesn't break subsequent crossings.
 */
export function attachThresholdFeed(
  tracker: TokenTracker,
  channelId: string,
  channelStore: ChannelStore,
  opts: ThresholdFeedOptions = {}
): () => void {
  const post = new Set<number>(opts.postThresholds ?? DEFAULT_POST_THRESHOLDS);
  return tracker.onThreshold(async (evt: ThresholdEvent) => {
    if (!post.has(evt.threshold)) return;
    const metadata: Record<string, string> = {
      kind: "context_threshold",
      schemaVersion: "1",
      threshold: String(evt.threshold),
      pct: evt.pct.toFixed(2),
      used: String(evt.used),
      total: String(evt.total),
      sessionId: evt.sessionId,
    };
    if (opts.modelName) metadata.model = opts.modelName;

    try {
      await channelStore.postEntry(channelId, {
        type: "status_update",
        fromAgentId: null,
        fromDisplayName: "Relay",
        content: `Context window at ${Math.round(evt.pct)}% (${evt.threshold}% threshold).`,
        metadata,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[threshold-feed] post failed (sessionId=${evt.sessionId}): ${message}`);
    }
  });
}
