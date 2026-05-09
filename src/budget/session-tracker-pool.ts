import { TokenTracker } from "./token-tracker.js";
import type { SessionKind } from "../domain/session-budget.js";

/**
 * One-tracker-per-chat-session pool. Construction is lazy: the first
 * `get(sessionId, ceiling)` call mints the tracker (which immediately
 * starts replaying any prior `~/.relay/sessions/<sessId>/budget.jsonl`).
 * Subsequent calls return the same instance — same-process records
 * serialize through the tracker's writeChain (token-tracker.ts:75).
 *
 * **Phase 1 PR-1:** stub. The shape lands in PR-1 so tests + typecheck
 * compile against final types; the implementation lands in PR-2 (Task 4).
 * Calls to `get()` / `closeAll()` throw at runtime so RED tests fail
 * loudly. See `.planning/phases/01-token-usage-telemetry-context-bar/01-PLAN.md`
 * Task 4 for the full implementation contract (M8 soft-warning, etc.).
 */
export class SessionTrackerPool {
  get(_sessionId: string, _ceiling: number, _kind?: SessionKind): TokenTracker {
    throw new Error("SessionTrackerPool: not yet implemented (Phase 1 PR-2 / Task 4)");
  }

  has(_sessionId: string): boolean {
    throw new Error("SessionTrackerPool: not yet implemented (Phase 1 PR-2 / Task 4)");
  }

  async closeAll(): Promise<void> {
    throw new Error("SessionTrackerPool: not yet implemented (Phase 1 PR-2 / Task 4)");
  }
}
