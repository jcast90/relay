import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { TokenTracker } from "./token-tracker.js";
import type { SessionKind } from "../domain/session-budget.js";

/**
 * Resolve the per-process `~/.relay` directory by reading `HOME` directly
 * rather than through {@link getRelayDir}. The pool needs to honor a
 * per-test `process.env.HOME = tmp` override on every `get()` so the M8
 * disk-probe and the constructed {@link TokenTracker} both target the same
 * tmp tree. {@link getRelayDir} caches its first answer for the process
 * lifetime, which would couple unrelated tests via shared state.
 */
function relayRootForCurrentEnv(): string {
  return join(homedir(), ".relay");
}

/**
 * One-tracker-per-chat-session pool. Construction is lazy: the first
 * `get(sessionId, ceiling)` call mints the tracker (which immediately
 * starts replaying any prior `~/.relay/sessions/<sessId>/budget.jsonl`).
 * Subsequent calls return the same instance — same-process records
 * serialize through the tracker's writeChain (token-tracker.ts:75).
 *
 * Per D-02 the pool is keyed by chat sessionId, not channelId — a channel
 * may host multiple sessions over its lifetime; each gets its own tracker
 * + budget file. Per D-03 a Phase-2 handoff creates a new sessionId in the
 * destination provider; that session's tracker starts at 0% (the file is
 * fresh on disk) — see {@link ../../docs/design/context-threshold-events.md}
 * for the cross-phase contract.
 *
 * **M8 soft-warning:** if a brand-new sessionId surfaces a pre-existing
 * `budget.jsonl` with non-zero `cumulativeUsed`, log via `console.warn` —
 * this is most likely a reused id from Phase 2 that violated the 0%-start
 * guarantee, OR a legitimate same-id resumption (in which case the warning
 * is harmless). We prefer false positives over silent failures (Phase 2's
 * planner CI will treat the warning as a contract violation).
 */
export class SessionTrackerPool {
  private readonly trackers = new Map<string, TokenTracker>();

  /**
   * Return the tracker for `sessionId`, constructing it on first call and
   * memoizing for the rest of the process lifetime. `ceiling` is the
   * model's context-window total in tokens (resolved via
   * {@link ../domain/model-context-windows.ts resolveContextWindow}); only
   * the first call's value is honored — subsequent calls get the existing
   * tracker regardless of the passed ceiling.
   *
   * `kind` (default `"admin"`, matching the on-disk back-compat default)
   * is written onto every appended `BudgetLine` so the Rust + TS readers
   * can filter chat / run / admin sessions in dashboards.
   */
  get(sessionId: string, ceiling: number, kind: SessionKind = "admin"): TokenTracker {
    let tracker = this.trackers.get(sessionId);
    if (!tracker) {
      this.maybeWarnReplay(sessionId);
      const rootDir = relayRootForCurrentEnv();
      tracker = new TokenTracker(sessionId, ceiling, { rootDir, kind });
      this.trackers.set(sessionId, tracker);
    }
    return tracker;
  }

  has(sessionId: string): boolean {
    return this.trackers.has(sessionId);
  }

  /**
   * Drain in-flight writes for every tracker and clear the pool. Called
   * from `OrchestratorV2.run()` cleanup so all `budget.jsonl` writes flush
   * to disk before the run resolves (mirrors the existing `pendingWrites`
   * drain pattern). Uses `allSettled` so a single tracker's close failure
   * doesn't short-circuit the drain.
   */
  async closeAll(): Promise<void> {
    const all = [...this.trackers.values()];
    this.trackers.clear();
    await Promise.allSettled(all.map((t) => t.close()));
  }

  /**
   * Probe `~/.relay/sessions/<sessionId>/budget.jsonl` before construction
   * and log the M8 soft-warning if the file already exists with non-zero
   * `cumulativeUsed`. Sync IO — runs once per (pool, sessionId) pair on
   * the first `get()` call. Malformed lines are silently swallowed; the
   * tracker's own replay handles torn-file recovery.
   */
  private maybeWarnReplay(sessionId: string): void {
    const path = join(relayRootForCurrentEnv(), "sessions", sessionId, "budget.jsonl");
    if (!existsSync(path)) return;
    let content: string;
    try {
      content = readFileSync(path, "utf8").trim();
    } catch {
      return;
    }
    if (!content) return;
    const lines = content.split("\n").filter(Boolean);
    const lastLine = lines[lines.length - 1];
    if (!lastLine) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(lastLine);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    const cumulative = (parsed as { cumulativeUsed?: unknown }).cumulativeUsed;
    if (typeof cumulative === "number" && cumulative > 0) {
      console.warn(
        `[budget] tracker for sessionId "${sessionId}" is replaying non-zero state ` +
          `(used=${cumulative}) from disk — if Phase 2 minted this id, the 0% ` +
          `start guarantee may have been violated.`
      );
    }
  }
}
