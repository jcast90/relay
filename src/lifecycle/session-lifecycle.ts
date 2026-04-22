import { EventEmitter } from "node:events";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { TokenTracker } from "../budget/token-tracker.js";
import { getRelayDir } from "../cli/paths.js";

import {
  DEFAULT_MAX_DURATION_MS,
  LifecycleTransitionError,
  TERMINAL_STATES,
  VALID_TRANSITIONS,
  type LifecycleFile,
  type LifecycleState,
  type PersistedTransition,
  type TransitionEvent,
} from "./types.js";

export { LifecycleTransitionError } from "./types.js";
export type { LifecycleState, TransitionEvent } from "./types.js";

/**
 * Options for constructing a {@link SessionLifecycle}. All fields are
 * optional — the defaults produce a production-ready state machine with an
 * 8h wall-clock budget and no token-budget wiring.
 */
export interface SessionLifecycleOptions {
  /**
   * Optional token tracker to wire budget-driven transitions. When
   * attached, the lifecycle subscribes to its `onThreshold` bus and:
   *
   *   - 85% → `dispatching` transitions to `winding_down`
   *   - 95% → any non-terminal state transitions to `killed`
   *
   * Other thresholds (50 / 100) are ignored. The lifecycle never touches
   * the tracker's own state; re-fire suppression across restarts is
   * {@link TokenTracker}'s responsibility via its own persisted
   * `firedThresholds` set.
   */
  tracker?: TokenTracker;

  /**
   * Wall-clock budget in milliseconds. When the timer elapses the
   * lifecycle transitions to `killed` with reason `"wall-clock-exceeded"`
   * (unless already terminal). Defaults to 8h. Must be > 0.
   */
  maxDurationMs?: number;

  /**
   * Clock injection point. Defaults to `Date.now`. Tests pass a
   * controllable clock so they can assert wall-clock behaviour without
   * wall-clock waits. The clock is only consulted when stamping
   * transition timestamps and the `startedAt` field.
   */
  clock?: () => number;

  /**
   * Override the `~/.relay` base directory. Tests use this with a tmp
   * dir; production callers should leave it undefined.
   */
  rootDir?: string;

  /**
   * Timer factory. Defaults to `setTimeout`/`clearTimeout`. Tests can
   * inject a fake-timer harness to drive the watchdog deterministically.
   * If set, the lifecycle uses these instead of the Node globals.
   */
  setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout | number;
  clearTimer?: (handle: NodeJS.Timeout | number) => void;
}

/**
 * Persisted, one-way state machine for an autonomous Relay session.
 *
 * Responsibilities:
 *
 *   1. Enforce the valid transition graph declared in
 *      {@link VALID_TRANSITIONS}. Invalid transitions throw
 *      {@link LifecycleTransitionError} — never silently no-op.
 *   2. Persist state + the ordered transition log to
 *      `~/.relay/sessions/<sessionId>/lifecycle.json` atomically (tmp +
 *      rename). On construction, the file is replayed so a restart
 *      resumes in whatever state it was in — a crash mid-winding-down
 *      cannot silently re-open dispatching.
 *   3. Fire transitions off the two kill triggers this ticket owns:
 *        - {@link TokenTracker} threshold crossings (85 / 95)
 *        - the wall-clock watchdog (default 8h)
 *   4. Expose an `onTransition` event bus so AL-4's autonomous-loop
 *      driver can react. The bus is a bare `EventEmitter` — same style
 *      as AL-1's token tracker — and the two buses are independent; AL-4
 *      subscribes to both.
 *
 * **Clean-kill semantics.** "kill" in this class means the lifecycle
 * *state* transitions to `killed`. The autonomous loop observes the
 * transition event and stops dispatching new tickets. The currently
 * running ticket finishes on its own — the lifecycle never terminates
 * subprocesses or mutates in-flight work. AL-2 is the signal; something
 * else (AL-4 / the invoker layer) is the actuator.
 */
export class SessionLifecycle {
  readonly sessionId: string;
  readonly startedAt: number;
  readonly maxDurationMs: number;

  private _state: LifecycleState = "planning";
  private readonly transitions: PersistedTransition[] = [];

  private readonly emitter = new EventEmitter();
  private readonly filePath: string;
  private readonly clock: () => number;

  // Write chain so two overlapping transition() calls can't race on the
  // atomic rename. Same pattern as TokenTracker's writeChain.
  private writeChain: Promise<void>;

  private watchdogHandle: NodeJS.Timeout | number | null = null;
  private readonly setTimer: (fn: () => void, ms: number) => NodeJS.Timeout | number;
  private readonly clearTimer: (handle: NodeJS.Timeout | number) => void;

  private unsubscribeTracker: (() => void) | null = null;
  private closed = false;

  constructor(sessionId: string, options: SessionLifecycleOptions = {}) {
    if (!sessionId) {
      throw new Error("SessionLifecycle: sessionId is required");
    }

    const maxDurationMs = options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
    if (!Number.isFinite(maxDurationMs) || maxDurationMs <= 0) {
      throw new Error(
        `SessionLifecycle: maxDurationMs must be a positive finite number (got ${maxDurationMs})`
      );
    }

    this.sessionId = sessionId;
    this.maxDurationMs = maxDurationMs;
    this.clock = options.clock ?? Date.now;
    this.startedAt = this.clock();

    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));

    const root = options.rootDir ?? getRelayDir();
    this.filePath = join(root, "sessions", sessionId, "lifecycle.json");

    // Replay first so any caller that awaits a no-op promise (or our own
    // transition chain) observes the resumed state. Transitions queue
    // behind this.
    this.writeChain = this.replay();

    // Arm the watchdog immediately. If we resume into a terminal state,
    // the arm call is a no-op. We only want the watchdog for sessions
    // that still have work in front of them.
    this.armWatchdog();

    // Subscribe to the token tracker after replay is queued so any
    // threshold crossing that arrives during replay is still handled in
    // order (transitions are serialized on the write chain).
    if (options.tracker) {
      this.unsubscribeTracker = options.tracker.onThreshold((evt) => {
        this.handleThreshold(evt.threshold);
      });
    }
  }

  /** Current lifecycle state. Reflects the last completed transition. */
  get state(): LifecycleState {
    return this._state;
  }

  /** Snapshot of the transition history in insertion order. */
  getTransitions(): PersistedTransition[] {
    return this.transitions.slice();
  }

  /**
   * Attempt a transition to `next`. Throws {@link LifecycleTransitionError}
   * synchronously if the edge isn't in {@link VALID_TRANSITIONS}. Otherwise
   * resolves when the transition has been persisted to disk and emitted on
   * the event bus.
   *
   * Serialized behind the internal write chain — two concurrent callers
   * run in call order without racing on the atomic rename.
   */
  async transition(next: LifecycleState, reason?: string): Promise<void> {
    if (this.closed) {
      throw new Error("SessionLifecycle: cannot transition after close()");
    }

    // Validate synchronously against the *current* public state so
    // callers get a predictable error path. We re-validate inside the
    // chain against the serialized state to catch interleaved transitions
    // that might have changed things while the caller awaited nothing.
    this.assertValidTransition(this._state, next);

    this.writeChain = this.writeChain.then(async () => {
      // Re-check against the live state inside the chain — the previous
      // queued transition may have shifted us.
      this.assertValidTransition(this._state, next);

      const from = this._state;
      const ts = this.clock();
      const at = new Date(ts).toISOString();
      const record: PersistedTransition = reason
        ? { from, to: next, reason, at }
        : { from, to: next, at };

      this._state = next;
      this.transitions.push(record);

      // Clear the watchdog on terminal transitions so a crashed timer
      // can't fire a second transition after `done`.
      if (TERMINAL_STATES.includes(next)) {
        this.disarmWatchdog();
      }

      await this.persist();

      const evt: TransitionEvent = reason ? { from, to: next, reason, ts } : { from, to: next, ts };
      this.safeEmitTransition(evt);
    });

    await this.writeChain;
  }

  /**
   * Subscribe to transition events. Returns an unsubscribe function.
   * Multiple subscribers are supported — each gets the same event.
   * Mirrors {@link TokenTracker.onThreshold} so AL-4 can wire both buses
   * with a single pattern.
   */
  onTransition(listener: (evt: TransitionEvent) => void): () => void {
    this.emitter.on("transition", listener);
    return () => {
      this.emitter.off("transition", listener);
    };
  }

  /**
   * Drain any queued transitions without closing. Useful when a test has
   * triggered a transition via a fire-and-forget path (token-tracker
   * threshold, wall-clock watchdog) and needs to assert on the post-
   * transition state or persisted file.
   */
  async flush(): Promise<void> {
    // The watchdog-kill and threshold-driven transitions extend
    // `writeChain` inside a queued callback, so a single await of the
    // current chain isn't enough — we loop until the chain stabilizes.
    // One extra turn of the microtask queue guarantees the fire-and-
    // forget `transition()` has installed its own chain link.
    for (let i = 0; i < 8; i += 1) {
      const before = this.writeChain;
      await this.writeChain.catch(() => {});
      // Allow any pending `void this.transition(...)` callbacks in
      // handleThreshold / fireWallClockKill to have enqueued.
      await Promise.resolve();
      if (this.writeChain === before) break;
    }
  }

  /**
   * Flush any in-flight transition, clear the wall-clock watchdog, and
   * unsubscribe from the token tracker. Idempotent. After close, further
   * `transition()` calls throw.
   */
  async close(): Promise<void> {
    if (this.closed) {
      await this.writeChain.catch(() => {});
      return;
    }
    this.closed = true;
    this.disarmWatchdog();
    if (this.unsubscribeTracker) {
      this.unsubscribeTracker();
      this.unsubscribeTracker = null;
    }
    await this.writeChain.catch(() => {});
    this.emitter.removeAllListeners();
  }

  // --- internals -----------------------------------------------------------

  private assertValidTransition(from: LifecycleState, to: LifecycleState): void {
    const allowed = VALID_TRANSITIONS[from];
    if (!allowed || !allowed.includes(to)) {
      throw new LifecycleTransitionError(from, to);
    }
  }

  private safeEmitTransition(evt: TransitionEvent): void {
    const listeners = this.emitter.listeners("transition") as Array<(evt: TransitionEvent) => void>;
    for (const listener of listeners) {
      try {
        listener(evt);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`SessionLifecycle: transition ${evt.from}->${evt.to} listener threw: ${msg}`);
      }
    }
  }

  private async replay(): Promise<void> {
    let content: string;
    try {
      content = await readFile(this.filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // Fresh session — stay in `planning`, nothing to replay. We
        // defer the first write until the first transition so a tracker
        // that's constructed and immediately closed leaves no residue.
        return;
      }
      throw err;
    }

    let parsed: LifecycleFile;
    try {
      parsed = JSON.parse(content) as LifecycleFile;
    } catch {
      console.warn(
        `SessionLifecycle: lifecycle.json for session ${this.sessionId} is corrupted; starting fresh`
      );
      return;
    }

    if (!this.looksValid(parsed)) {
      console.warn(
        `SessionLifecycle: lifecycle.json for session ${this.sessionId} has unexpected shape; starting fresh`
      );
      return;
    }

    this._state = parsed.state;
    this.transitions.length = 0;
    for (const t of parsed.transitions) {
      this.transitions.push(t);
    }
  }

  private looksValid(parsed: unknown): parsed is LifecycleFile {
    if (!parsed || typeof parsed !== "object") return false;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.sessionId !== "string") return false;
    if (typeof obj.state !== "string") return false;
    if (!(obj.state in VALID_TRANSITIONS)) return false;
    if (typeof obj.startedAt !== "string") return false;
    if (!Array.isArray(obj.transitions)) return false;
    for (const t of obj.transitions) {
      if (!t || typeof t !== "object") return false;
      const tt = t as Record<string, unknown>;
      if (typeof tt.from !== "string" || !(tt.from in VALID_TRANSITIONS)) return false;
      if (typeof tt.to !== "string" || !(tt.to in VALID_TRANSITIONS)) return false;
      if (typeof tt.at !== "string") return false;
    }
    return true;
  }

  private async persist(): Promise<void> {
    const file: LifecycleFile = {
      sessionId: this.sessionId,
      state: this._state,
      startedAt: new Date(this.startedAt).toISOString(),
      transitions: this.transitions,
      maxDurationMs: this.maxDurationMs,
    };
    const dir = dirname(this.filePath);
    await mkdir(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp.${process.pid}.${Date.now()}`;
    await writeFile(tmp, JSON.stringify(file, null, 2), "utf8");
    try {
      await rename(tmp, this.filePath);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }

  private armWatchdog(): void {
    if (this.watchdogHandle !== null) return;
    if (TERMINAL_STATES.includes(this._state)) return;
    // Fire after the *full* maxDurationMs from the startedAt clock sample.
    // We don't subtract elapsed replay time — the spec treats the
    // watchdog as wall-clock-from-construction.
    this.watchdogHandle = this.setTimer(() => {
      this.watchdogHandle = null;
      this.fireWallClockKill();
    }, this.maxDurationMs);
    // When the host process uses real timers, unref so the watchdog
    // doesn't keep the event loop alive past the session's lifetime.
    const h = this.watchdogHandle as { unref?: () => void };
    if (h && typeof h.unref === "function") {
      h.unref();
    }
  }

  private disarmWatchdog(): void {
    if (this.watchdogHandle === null) return;
    this.clearTimer(this.watchdogHandle);
    this.watchdogHandle = null;
  }

  private fireWallClockKill(): void {
    if (this.closed) return;
    if (TERMINAL_STATES.includes(this._state)) return;
    // Fire-and-forget: kick a killed transition onto the queue. If the
    // current state doesn't allow `killed` (shouldn't happen — every
    // non-terminal state has a `killed` edge) the serialized re-check
    // surfaces the error on the write chain.
    void this.transition("killed", "wall-clock-exceeded").catch((err) => {
      console.warn(
        `SessionLifecycle: wall-clock kill failed for session ${this.sessionId}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    });
  }

  private handleThreshold(threshold: number): void {
    if (this.closed) return;
    if (threshold === 85) {
      // Only wind-down from `dispatching`. If we're already past it
      // (winding_down / audit) we respect the later state. If we're
      // earlier (planning) we also leave it alone — planning hasn't
      // started dispatching work yet, so "wind down" doesn't apply.
      if (this._state === "dispatching") {
        void this.transition("winding_down", "token-budget-85pct").catch(() => {});
      }
      return;
    }
    if (threshold === 95) {
      // Hard stop from any non-terminal state.
      if (!TERMINAL_STATES.includes(this._state)) {
        void this.transition("killed", "token-budget-95pct-hard-stop").catch(() => {});
      }
    }
  }
}
