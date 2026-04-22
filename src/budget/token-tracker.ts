import { EventEmitter } from "node:events";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { getRelayDir } from "../cli/paths.js";

/**
 * Threshold percentages at which the tracker emits a `threshold` event. One
 * emit per upward crossing per tracker instance — re-crossing the same
 * threshold (e.g. after a persistence replay) never re-emits.
 *
 * Exported as a const tuple so callers (AL-3 scheduler, tests) can iterate
 * the canonical list instead of re-declaring it.
 */
export const THRESHOLDS = [50, 85, 95, 100] as const;

export type ThresholdEvent = {
  sessionId: string;
  used: number;
  total: number;
  pct: number;
  threshold: number;
};

export type ThresholdListener = (evt: ThresholdEvent) => void;

/**
 * One line in `budget.jsonl`. Each `record()` call appends exactly one line
 * with the increment and the cumulative total after the increment. Replay
 * on construction sums the increments — `cumulativeUsed` is stored for
 * forensics, not for replay (the sum is the source of truth, so a
 * hand-edited file that got out of sync on cumulativeUsed still replays
 * correctly).
 */
interface BudgetLine {
  ts: string;
  inputTokens: number;
  outputTokens: number;
  cumulativeUsed: number;
}

/**
 * Autonomous-session token budget tracker (AL-1). Wraps the per-session
 * token accounting used by the autonomous loop's scheduler to decide when
 * to wind down. Not wired into the invoker layer yet — AL-3 does that.
 *
 * Persistence: `~/.relay/sessions/<sessionId>/budget.jsonl`, append-only.
 * On construction the file is replayed so a process restart resumes from
 * the existing cumulative total. Writes are queued through a Promise
 * chain so concurrent `record()` calls never interleave partial lines.
 *
 * Event bus: internal `EventEmitter`. Subscribers attach via
 * `onThreshold()`. Only the four canonical thresholds (50/85/95/100) fire,
 * and each fires at most once per tracker lifetime regardless of how many
 * API calls cross it.
 */
export class TokenTracker {
  readonly sessionId: string;

  private readonly _total: number;
  private _used = 0;
  private readonly firedThresholds = new Set<number>();
  private readonly emitter = new EventEmitter();
  private readonly filePath: string;

  // Serialize disk IO (replay on construct, append on record, final flush
  // on close). Every public mutator chains its work onto this tail
  // promise so operations apply in call order and never overlap.
  private writeChain: Promise<void>;
  private closed = false;

  /**
   * @param sessionId  Autonomous session identifier. Used both as the event
   *                   payload key and the directory segment under
   *                   `~/.relay/sessions/`.
   * @param totalTokens The session's budget ceiling in tokens. Must be > 0
   *                   so `pct` is well-defined.
   * @param options.rootDir  Override the `~/.relay` base directory. Tests
   *                   use this with a tmp dir; production callers should
   *                   leave it undefined.
   */
  constructor(sessionId: string, totalTokens: number, options: { rootDir?: string } = {}) {
    if (!sessionId) {
      throw new Error("TokenTracker: sessionId is required");
    }
    if (!Number.isFinite(totalTokens) || totalTokens <= 0) {
      throw new Error(
        `TokenTracker: totalTokens must be a positive finite number (got ${totalTokens})`
      );
    }

    this.sessionId = sessionId;
    this._total = totalTokens;

    const root = options.rootDir ?? getRelayDir();
    this.filePath = join(root, "sessions", sessionId, "budget.jsonl");

    // Kick off replay immediately. Any subsequent `record()` call queues
    // after this, so the first record observes the resumed total.
    this.writeChain = this.replay();
  }

  /**
   * Record the token cost of a single API call. Returns void — the write
   * is queued and flushed asynchronously. Callers that need to know the
   * write hit disk should `await tracker.close()` (or `await flush()`).
   *
   * Zero-token records are a no-op. Negative inputs throw (the Claude
   * stream never reports negative usage; a negative value indicates a
   * parsing bug we want to surface loudly, not silently absorb).
   */
  record(inputTokens: number, outputTokens: number): void {
    if (this.closed) {
      throw new Error("TokenTracker: cannot record after close()");
    }
    if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens)) {
      throw new Error(
        `TokenTracker: token counts must be finite (got ${inputTokens}, ${outputTokens})`
      );
    }
    if (inputTokens < 0 || outputTokens < 0) {
      throw new Error(
        `TokenTracker: token counts must be non-negative (got ${inputTokens}, ${outputTokens})`
      );
    }

    const increment = inputTokens + outputTokens;
    if (increment === 0) return;

    // Compute the new running total synchronously so `used` / `pct` reflect
    // the record immediately (the disk write is queued but the in-memory
    // number is authoritative for subscribers).
    const previous = this._used;
    this._used = previous + increment;
    const crossed = this.findCrossedThresholds(previous, this._used);

    // Queue the append behind any in-flight replay or earlier record.
    this.writeChain = this.writeChain.then(async () => {
      try {
        await this.appendLine({
          ts: new Date().toISOString(),
          inputTokens,
          outputTokens,
          cumulativeUsed: this._used,
        });
      } catch (err) {
        // Disk failure shouldn't take down the autonomous loop — surface
        // via an `error` event and let the scheduler decide. This mirrors
        // EventEmitter conventions: an unhandled `error` would crash the
        // process, so we only emit if someone is listening.
        if (this.emitter.listenerCount("error") > 0) {
          this.emitter.emit("error", err);
        }
      }
    });

    // Fire threshold events synchronously after updating in-memory state
    // so listeners see `used`/`pct` matching the event.
    for (const threshold of crossed) {
      this.firedThresholds.add(threshold);
      const evt: ThresholdEvent = {
        sessionId: this.sessionId,
        used: this._used,
        total: this._total,
        pct: this.pct,
        threshold,
      };
      this.emitter.emit("threshold", evt);
    }
  }

  /** Total tokens consumed so far (sum of all recorded input+output). */
  get used(): number {
    return this._used;
  }

  /** Budget ceiling set at construction. */
  get total(): number {
    return this._total;
  }

  /**
   * Percentage of budget consumed, 0..100+. Not clamped above 100 — a
   * runaway session should show 150% so the operator notices, not silently
   * pin at 100%. The 100 threshold still fires exactly once regardless.
   */
  get pct(): number {
    return (this._used / this._total) * 100;
  }

  /**
   * Subscribe to threshold crossings. Returns an unsubscribe function; call
   * it to detach the listener. Multiple subscribers are fine — each gets
   * the same event.
   */
  onThreshold(listener: ThresholdListener): () => void {
    this.emitter.on("threshold", listener);
    return () => {
      this.emitter.off("threshold", listener);
    };
  }

  /**
   * Subscribe to disk-write errors. Errors are never thrown synchronously
   * from `record()` (which returns void), so this is the only way to
   * observe them. Subscribing is optional — without a listener, errors
   * are dropped after being chained through the write queue.
   */
  onError(listener: (err: unknown) => void): () => void {
    this.emitter.on("error", listener);
    return () => {
      this.emitter.off("error", listener);
    };
  }

  /**
   * Flush any pending writes and close the tracker. After close,
   * subsequent `record()` calls throw. Idempotent — calling twice is
   * safe.
   */
  async close(): Promise<void> {
    this.closed = true;
    await this.writeChain;
    this.emitter.removeAllListeners();
  }

  /**
   * Await all queued disk writes without closing the tracker. Useful for
   * tests that want to assert on file contents after a batch of
   * `record()` calls.
   */
  async flush(): Promise<void> {
    await this.writeChain;
  }

  // --- internals -----------------------------------------------------------

  private async replay(): Promise<void> {
    let content: string;
    try {
      content = await readFile(this.filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // Fresh session — nothing to replay. Defer directory creation to
        // the first append so a tracker that's never written to doesn't
        // leave an empty directory behind.
        return;
      }
      throw err;
    }

    // Sum increments rather than trusting `cumulativeUsed` from the last
    // line: a torn final write or a hand-edited file should still yield
    // the correct resumed total as long as each individual line parses.
    let resumed = 0;
    const lines = content.split("\n");
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      let parsed: BudgetLine;
      try {
        parsed = JSON.parse(line) as BudgetLine;
      } catch {
        // Skip malformed lines. A single partially-flushed last line
        // shouldn't poison the whole replay.
        continue;
      }
      if (
        typeof parsed.inputTokens === "number" &&
        typeof parsed.outputTokens === "number" &&
        Number.isFinite(parsed.inputTokens) &&
        Number.isFinite(parsed.outputTokens)
      ) {
        resumed += parsed.inputTokens + parsed.outputTokens;
      }
    }
    this._used = resumed;

    // Any threshold the resumed state already crosses is considered
    // already-fired — we don't want a restart to re-emit 50%/85%/etc.
    // This matches the "one emit per crossing" guarantee across process
    // lifetimes.
    for (const threshold of THRESHOLDS) {
      if (this.pctAt(resumed) >= threshold) {
        this.firedThresholds.add(threshold);
      }
    }
  }

  private async appendLine(line: BudgetLine): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    // `appendFile` with a single <PIPE_BUF line is atomic on POSIX, so
    // concurrent appenders from the same tracker never interleave bytes.
    // The write-chain mutex above is the stronger guarantee (same-process
    // ordering); this remark is about the OS-level interleave safety.
    await appendFile(this.filePath, JSON.stringify(line) + "\n", "utf8");
  }

  private findCrossedThresholds(previousUsed: number, currentUsed: number): number[] {
    const crossed: number[] = [];
    for (const threshold of THRESHOLDS) {
      if (this.firedThresholds.has(threshold)) continue;
      if (this.pctAt(previousUsed) < threshold && this.pctAt(currentUsed) >= threshold) {
        crossed.push(threshold);
      }
    }
    return crossed;
  }

  private pctAt(used: number): number {
    return (used / this._total) * 100;
  }
}
