import type { ChannelStore } from "../channels/channel-store.js";
import type { TokenTracker } from "./token-tracker.js";

export interface ThresholdFeedOptions {
  /**
   * Subset of `THRESHOLDS` (token-tracker.ts:21) to forward to the channel
   * feed. Defaults to [75, 90, 95] per the Phase-1 brief. Other thresholds
   * still fire on the in-process EventEmitter for in-process subscribers
   * (e.g. RepoAdminSession's 60% memory-shed subscriber); they are simply
   * not posted to the channel feed here.
   */
  postThresholds?: readonly number[];
  /** Optional model name surfaced in metadata for downstream readers. */
  modelName?: string;
}

/**
 * **Phase 1 PR-1:** stub. The bridge implementation lands in PR-2 (Task 5);
 * the shape + signature ship in PR-1 so RED tests compile. See
 * `.planning/phases/01-token-usage-telemetry-context-bar/01-PLAN.md` Task 5
 * for the contract (filter to [75, 90, 95], `metadata.kind ===
 * "context_threshold"`, M7 pct precision, etc.).
 */
export function attachThresholdFeed(
  _tracker: TokenTracker,
  _channelId: string,
  _channelStore: ChannelStore,
  _opts: ThresholdFeedOptions = {}
): () => void {
  throw new Error("attachThresholdFeed: not yet implemented (Phase 1 PR-2 / Task 5)");
}
