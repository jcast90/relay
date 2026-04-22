/**
 * Pool of per-repo repo-admin sessions (AL-12).
 *
 * Owns the N sessions that correspond to a channel's `repoAssignments` for
 * the duration of one autonomous run. Responsibilities:
 *
 *   - Boot: construct one {@link RepoAdminSession} per allowed assignment,
 *     `start()` them in parallel.
 *   - Restart-on-death: subscribe to each session's event bus; when a
 *     session emits `exited-unexpected` AND the lifecycle hasn't moved to
 *     `winding_down` / `audit` / `done` / `killed`, respawn with
 *     exponential backoff (1s → 2s → 4s → 8s, cap 8s). Cap: 5 restarts
 *     inside a 2-minute window stops the restart loop and emits a
 *     `session-admin-failing` event so the pool continues with healthy
 *     sessions.
 *   - Lifecycle observation: subscribe to {@link SessionLifecycle} via
 *     `onTransition`. On first transition to a terminal state, auto-
 *     invoke {@link stop}.
 *   - Graceful shutdown: iterate all sessions, call `session.stop()`,
 *     await all (bounded by {@link POOL_STOP_TIMEOUT_MS}). Each session
 *     has its own 5s SIGTERM→SIGKILL escalation; `stop()` resolves once
 *     every child process is gone OR the outer cap fires.
 *
 * ## Activation status
 *
 * The pool is **built but not yet wired into production runs**. AL-12
 * ships the lifecycle mechanics (boot / restart-on-death / rapid-restart
 * ceiling / graceful shutdown) and tests them in isolation, but the
 * admin-process handshake protocol — how the autonomous loop actually
 * talks to a running `claude` repo-admin child — lands in AL-13. Without
 * that protocol the default-spawner's child exits in milliseconds
 * (no prompt, stdin closed) and the pool immediately flaps until the
 * rapid-restart ceiling fires.
 *
 * To avoid a production flap-storm, the autonomous-loop driver
 * (`autonomous-loop.ts`) gates pool construction behind the
 * {@link RELAY_REPO_ADMIN_POOL_ENABLED} env var, defaulted **off**. When
 * the flag is unset the pre-AL-12 behaviour is preserved: no pool, the
 * lifecycle transitions to `killed` with reason `"al-13-pending"`, and
 * the CLI exits cleanly. AL-13 flips the default on once the handshake
 * protocol is wired.
 *
 * Scope discipline:
 *   - Ticket routing / dispatch        → AL-13.
 *   - Worker spawning                  → AL-14.
 *   - Memory-shed / session cycling    → AL-15 (implemented on the
 *     session wrapper; the pool only observes + forwards `cycled`
 *     events). Cycles are NOT counted against the rapid-flap ceiling.
 *   - Inter-admin coordination         → AL-16.
 */

import { EventEmitter } from "node:events";
import { join } from "node:path";

import type { Channel, RepoAssignment } from "../domain/channel.js";
import type { SessionLifecycle, LifecycleState } from "../lifecycle/session-lifecycle.js";
import { getRelayDir } from "../cli/paths.js";

import {
  RepoAdminSession,
  type RepoAdminProcessSpawner,
  type RepoAdminSessionEvent,
  type RepoAdminSessionOptions,
} from "./repo-admin-session.js";

/**
 * Env var gating pool activation. Default **off** until AL-13 ships the
 * admin-process handshake protocol. When unset / `"0"` / `"false"` /
 * empty string, the autonomous-loop driver skips pool construction and
 * falls back to the pre-AL-12 "transition to killed with reason
 * al-13-pending" behaviour. See this module's top-of-file docstring.
 */
export const RELAY_REPO_ADMIN_POOL_ENABLED = "RELAY_REPO_ADMIN_POOL_ENABLED";

/**
 * Parse the {@link RELAY_REPO_ADMIN_POOL_ENABLED} env var into a bool.
 * Defaults to `false`. Recognised true-ish values: `"1"`, `"true"`,
 * `"yes"`, `"on"` (case-insensitive). Anything else is treated as off
 * so operators who typo the flag don't silently opt in to the flap loop.
 */
export function isRepoAdminPoolEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[RELAY_REPO_ADMIN_POOL_ENABLED];
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

/**
 * Exponential backoff schedule between restart attempts. Index 0 is the
 * delay BEFORE the 2nd spawn (the 1st restart); values saturate at the
 * last entry for additional attempts in the same rapid-restart window.
 */
export const RESTART_BACKOFF_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000];

/** Max restarts per session within {@link RAPID_RESTART_WINDOW_MS}. */
export const RAPID_RESTART_CEILING = 5;

/** Sliding window over which we count restarts toward {@link RAPID_RESTART_CEILING}. */
export const RAPID_RESTART_WINDOW_MS = 2 * 60 * 1000;

/**
 * Hard ceiling on {@link RepoAdminPool.stop}'s wait for every session to
 * reach `exited-expected`. Per-session SIGTERM→SIGKILL escalation already
 * gives each child 5s; the outer cap guards against a zombie child whose
 * `awaitStopped()` never resolves (NFS hang, SIGKILL ignored by kernel,
 * etc.) wedging the whole pool shutdown. When the cap fires we log a warn
 * naming the stuck aliases and resolve anyway — partial shutdown is
 * strictly better than an indefinite block on CLI exit.
 */
export const POOL_STOP_TIMEOUT_MS = 15_000;

/**
 * States where we keep the pool alive. Any other lifecycle state causes
 * auto-shutdown OR suppresses restarts.
 */
const ACTIVE_LIFECYCLE_STATES: readonly LifecycleState[] = ["planning", "dispatching"];

const TERMINAL_LIFECYCLE_STATES: readonly LifecycleState[] = ["done", "killed"];

const WINDING_DOWN_STATES: readonly LifecycleState[] = ["winding_down", "audit", "done", "killed"];

export type RepoAdminPoolEvent =
  | { kind: "started"; alias: string; sessionId: string }
  | {
      kind: "restarted";
      alias: string;
      previousExitCode: number | null;
      attempt: number;
      sessionId: string;
    }
  | { kind: "stopped"; alias: string; reason: string }
  | {
      kind: "session-admin-failing";
      alias: string;
      reason: "rapid-restart-ceiling";
      restartsInWindow: number;
    }
  | {
      /**
       * AL-15: a repo-admin session completed a memory-shed cycle. The
       * child backing `sessionId_old` was torn down, the child backing
       * `sessionId_new` is now live, and the session's in-flight queue
       * survived the boundary. Observers can surface this in logs /
       * TUI without subscribing to each individual session.
       */
      kind: "cycled";
      alias: string;
      sessionId_old: string;
      sessionId_new: string;
      reason: "budget-60pct" | "manual";
    };

export interface RepoAdminPoolOptions {
  /** The channel whose `repoAssignments` drive spawn shapes. */
  channel: Channel;
  /**
   * If set + non-empty, only spawn sessions for assignments whose alias
   * matches. Mirrors `--allow-repo` from AL-3. Empty array / undefined =
   * spawn for every assignment.
   */
  allowedAliases?: string[];
  /**
   * Full-access opt-in from the channel. Threaded into every spawned
   * session so the Claude CLI gets `--dangerously-skip-permissions`.
   * `channel.fullAccess` is the canonical source; this option exists so
   * callers can override (e.g. tests).
   */
  fullAccess?: boolean;
  /**
   * Parent autonomous-session lifecycle. The pool subscribes via
   * `onTransition` and auto-stops on terminal states.
   */
  lifecycle: SessionLifecycle;
  /**
   * Injected spawner for the child processes. Defaults to the real Claude
   * CLI spawner constructed by {@link RepoAdminSession}. Tests inject a
   * fake so the exit/restart mechanics run without a real binary.
   */
  spawner?: RepoAdminProcessSpawner;
  /** Overridden per-test only — see {@link RepoAdminSessionOptions.buildSessionId}. */
  buildSessionId?: () => string;
  /**
   * Override `~/.relay` so tests don't clutter the real home dir. If
   * unset, the pool resolves via {@link getRelayDir}.
   */
  rootDir?: string;
  /**
   * Timer injection point. Tests pass `vi.useFakeTimers()`-friendly
   * wrappers to drive backoff deterministically. Signature matches
   * `setTimeout` / `clearTimeout` shape.
   */
  setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout | number;
  clearTimer?: (handle: NodeJS.Timeout | number) => void;
  /**
   * Clock injection point for the rapid-restart window accounting.
   * Defaults to `Date.now`; tests inject a controllable clock so a burst
   * of synthesized restarts doesn't depend on wall-clock jitter.
   */
  clock?: () => number;
  /**
   * Override per-session SIGTERM→SIGKILL escalation delay. Only tests set
   * this (so `stop()` doesn't wait 5 real seconds when a fake child
   * ignores SIGTERM).
   */
  sessionStopGraceMs?: number;
}

interface InternalSessionRecord {
  session: RepoAdminSession;
  unsubscribeEvents: () => void;
  restartTimestamps: number[]; // epoch ms; rolled within the rapid-restart window
  giveUp: boolean; // true after rapid-restart ceiling is hit
  restartTimer: NodeJS.Timeout | number | null;
}

/**
 * Coordinates a cohort of {@link RepoAdminSession} instances for one
 * autonomous run. Exposes a tiny event bus so the TUI/CLI + tests can
 * observe boot / restart / stop without coupling to internals.
 *
 * The pool instance is single-use: once `stop()` has been called, a new
 * autonomous session gets a fresh pool.
 */
export class RepoAdminPool {
  private readonly channel: Channel;
  private readonly allowedAliases: ReadonlySet<string> | null;
  private readonly fullAccess: boolean;
  private readonly lifecycle: SessionLifecycle;
  private readonly spawner?: RepoAdminProcessSpawner;
  private readonly buildSessionId?: () => string;
  private readonly rootDir: string;
  private readonly setTimer: (fn: () => void, ms: number) => NodeJS.Timeout | number;
  private readonly clearTimer: (handle: NodeJS.Timeout | number) => void;
  private readonly clock: () => number;
  private readonly sessionStopGraceMs?: number;

  private readonly sessions = new Map<string, InternalSessionRecord>();
  private readonly emitter = new EventEmitter();

  private started = false;
  private stopping = false;
  private stopped = false;
  private stopPromise: Promise<void> | null = null;
  private unsubscribeLifecycle: (() => void) | null = null;

  constructor(options: RepoAdminPoolOptions) {
    this.channel = options.channel;
    const aliases = options.allowedAliases?.filter((a) => a.length > 0) ?? [];
    this.allowedAliases = aliases.length > 0 ? new Set(aliases) : null;
    this.fullAccess = options.fullAccess ?? options.channel.fullAccess ?? false;
    this.lifecycle = options.lifecycle;
    this.spawner = options.spawner;
    this.buildSessionId = options.buildSessionId;
    this.rootDir = options.rootDir ?? getRelayDir();
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
    this.clock = options.clock ?? Date.now;
    this.sessionStopGraceMs = options.sessionStopGraceMs;
  }

  /**
   * Boot one session per allowed assignment. Resolves once every session
   * has been wired up (each `session.start()` returned). Subsequent calls
   * are no-ops.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    // Guard against the edge case where the pool is constructed AFTER the
    // parent lifecycle already ended. We must short-circuit BEFORE wiring
    // `onTransition` — `stop()` early-returns on `stopped`, so any
    // subscription we register here would never be torn down and would
    // leak a listener on the lifecycle emitter for the rest of the
    // process lifetime.
    if (TERMINAL_LIFECYCLE_STATES.includes(this.lifecycle.state)) {
      this.stopped = true;
      return;
    }

    // Hook the parent lifecycle so a mid-boot transition to a terminal
    // state can short-circuit spawning rather than leak a child we're
    // about to kill anyway.
    this.unsubscribeLifecycle = this.lifecycle.onTransition((evt) => {
      if (TERMINAL_LIFECYCLE_STATES.includes(evt.to)) {
        // Fire-and-forget: the pool's own stop() is idempotent and awaits
        // each session. We don't block the lifecycle emitter.
        void this.stop().catch(() => {});
      }
    });

    const assignments = this.selectAssignments();
    await Promise.all(assignments.map((assignment) => this.bootSession(assignment)));
  }

  /**
   * Graceful shutdown. Iterates all sessions, awaits their `stop()`, and
   * tears down the lifecycle subscription. Idempotent — overlapping
   * callers share the same in-flight promise.
   */
  async stop(): Promise<void> {
    if (this.stopped) return;
    if (this.stopping && this.stopPromise) return this.stopPromise;

    this.stopping = true;
    const reason = "pool-shutdown";

    this.stopPromise = (async () => {
      if (this.unsubscribeLifecycle) {
        this.unsubscribeLifecycle();
        this.unsubscribeLifecycle = null;
      }

      const records = Array.from(this.sessions.values());
      for (const record of records) {
        if (record.restartTimer !== null) {
          this.clearTimer(record.restartTimer);
          record.restartTimer = null;
        }
      }

      // Track which sessions have actually stopped so the timeout path
      // can name the stuck ones and skip emit for the others (the in-
      // flight session.stop() may land after we've already given up).
      const settled = new Set<string>();

      const allStops = Promise.all(
        records.map(async (record) => {
          try {
            await record.session.stop(reason);
          } catch (err) {
            // Swallow: a session throwing on shutdown shouldn't wedge the
            // whole pool-shutdown handshake. Log and continue.
            const msg = err instanceof Error ? err.message : String(err);
            // eslint-disable-next-line no-console
            console.warn(`RepoAdminPool: session "${record.session.alias}" threw on stop: ${msg}`);
          }
          settled.add(record.session.alias);
          record.unsubscribeEvents();
          this.emit({ kind: "stopped", alias: record.session.alias, reason });
        })
      ).then(() => "ok" as const);

      // Outer cap. `awaitStopped()` inside a session normally resolves
      // once the child emits `exited-expected` — but if the OS refuses to
      // reap the child, or the fake spawner never emits, we don't want
      // pool.stop() (and by extension the CLI exit path) to hang forever.
      let timeoutHandle: NodeJS.Timeout | number | null = null;
      const timedOut = new Promise<"timeout">((resolve) => {
        timeoutHandle = this.setTimer(() => resolve("timeout"), POOL_STOP_TIMEOUT_MS);
        const t = timeoutHandle as { unref?: () => void };
        if (t && typeof t.unref === "function") t.unref();
      });

      const outcome = await Promise.race([allStops, timedOut]);
      if (timeoutHandle !== null) this.clearTimer(timeoutHandle);

      if (outcome === "timeout") {
        const stuck = records.map((r) => r.session.alias).filter((alias) => !settled.has(alias));
        // eslint-disable-next-line no-console
        console.warn(
          `RepoAdminPool: stop() timed out after ${POOL_STOP_TIMEOUT_MS}ms; ` +
            `sessions did not exit cleanly: ${stuck.join(", ")}`
        );
      }

      this.stopped = true;
      this.stopping = false;
      this.emitter.removeAllListeners();
    })();

    return this.stopPromise;
  }

  /** Look up a session by alias. Returns `null` when the alias has no session. */
  getSession(alias: string): RepoAdminSession | null {
    const record = this.sessions.get(alias);
    return record ? record.session : null;
  }

  /** Snapshot of all currently-tracked sessions. */
  listSessions(): RepoAdminSession[] {
    return Array.from(this.sessions.values()).map((r) => r.session);
  }

  /**
   * Subscribe to pool events (`started`, `restarted`, `stopped`,
   * `session-admin-failing`). Returns an unsubscribe function.
   */
  onSessionEvent(listener: (evt: RepoAdminPoolEvent) => void): () => void {
    this.emitter.on("pool-event", listener);
    return () => {
      this.emitter.off("pool-event", listener);
    };
  }

  // --- internals ----------------------------------------------------------

  private selectAssignments(): RepoAssignment[] {
    const all = this.channel.repoAssignments ?? [];
    if (!this.allowedAliases) return all.slice();
    return all.filter((a) => this.allowedAliases!.has(a.alias));
  }

  private buildLogDir(alias: string): string {
    return join(this.rootDir, "sessions", this.lifecycle.sessionId, "repo-admins", alias);
  }

  private async bootSession(assignment: RepoAssignment): Promise<void> {
    const logDir = this.buildLogDir(assignment.alias);

    const sessionOpts: RepoAdminSessionOptions = {
      assignment,
      fullAccess: this.fullAccess,
      logDir,
      spawner: this.spawner,
      buildSessionId: this.buildSessionId,
      stopGraceMs: this.sessionStopGraceMs,
    };
    const session = new RepoAdminSession(sessionOpts);

    const record: InternalSessionRecord = {
      session,
      unsubscribeEvents: () => {},
      restartTimestamps: [],
      giveUp: false,
      restartTimer: null,
    };
    this.sessions.set(assignment.alias, record);

    record.unsubscribeEvents = session.onEvent((evt) => this.handleSessionEvent(record, evt));

    await session.start();
    this.emit({
      kind: "started",
      alias: assignment.alias,
      sessionId: session.sessionId,
    });
  }

  private handleSessionEvent(record: InternalSessionRecord, evt: RepoAdminSessionEvent): void {
    // AL-15: forward cycle completions to pool observers. Cycles do NOT
    // count toward the rapid-restart ceiling (they're planned, not a
    // crash-and-respawn), and the pending queue survives on the session
    // wrapper — no pool-side bookkeeping needed beyond the emit.
    if (evt.kind === "cycled") {
      this.emit({
        kind: "cycled",
        alias: record.session.alias,
        sessionId_old: evt.previousSessionId,
        sessionId_new: evt.newSessionId,
        reason: evt.reason,
      });
      return;
    }
    if (evt.kind !== "exited-unexpected") return;

    // Whether we restart hinges on the CURRENT lifecycle state. Even if
    // we're stopping, a late-arriving death event shouldn't kick off a
    // respawn because `stop()` already set `stopping=true`.
    if (this.stopping || this.stopped) return;
    if (WINDING_DOWN_STATES.includes(this.lifecycle.state)) return;

    const now = this.clock();
    // Drop timestamps outside the sliding window.
    record.restartTimestamps = record.restartTimestamps.filter(
      (ts) => now - ts <= RAPID_RESTART_WINDOW_MS
    );
    if (record.restartTimestamps.length >= RAPID_RESTART_CEILING) {
      if (!record.giveUp) {
        record.giveUp = true;
        this.emit({
          kind: "session-admin-failing",
          alias: record.session.alias,
          reason: "rapid-restart-ceiling",
          restartsInWindow: record.restartTimestamps.length,
        });
        // Treat the session as finalized so pool shutdown still awaits a
        // stable terminal. No more restarts will be scheduled.
        record.session.markStopped("rapid-restart-ceiling");
      }
      return;
    }

    const attemptIdx = Math.min(record.restartTimestamps.length, RESTART_BACKOFF_MS.length - 1);
    const delay = RESTART_BACKOFF_MS[attemptIdx];

    // Record the attempt timestamp at SCHEDULE time — not at spawn time —
    // so a flapping process can't dodge the ceiling by delaying its next
    // death beyond the window.
    record.restartTimestamps.push(now);

    const previousExitCode = evt.exitCode;
    record.restartTimer = this.setTimer(() => {
      record.restartTimer = null;
      // Guards re-checked at fire time: lifecycle or shutdown may have
      // advanced while we slept, and a simultaneous giveUp / manual stop
      // would have transitioned the session to `stopped`.
      if (this.stopping || this.stopped) return;
      if (WINDING_DOWN_STATES.includes(this.lifecycle.state)) return;
      if (record.giveUp) return;
      if (record.session.state === "stopped") return;
      void this.performRestart(record, previousExitCode).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.warn(`RepoAdminPool: restart of "${record.session.alias}" failed: ${msg}`);
      });
    }, delay);
    const t = record.restartTimer as { unref?: () => void };
    if (t && typeof t.unref === "function") t.unref();
  }

  private async performRestart(
    record: InternalSessionRecord,
    previousExitCode: number | null
  ): Promise<void> {
    await record.session.start();
    this.emit({
      kind: "restarted",
      alias: record.session.alias,
      previousExitCode,
      attempt: record.session.spawnCount,
      sessionId: record.session.sessionId,
    });
  }

  private emit(evt: RepoAdminPoolEvent): void {
    const listeners = this.emitter.listeners("pool-event") as Array<
      (evt: RepoAdminPoolEvent) => void
    >;
    for (const listener of listeners) {
      try {
        listener(evt);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.warn(`RepoAdminPool: pool-event listener threw: ${msg}`);
      }
    }
  }
}

/**
 * Re-export lifecycle state set so a future AL-3/AL-4 wiring layer can
 * reason about the same "when to suppress spawn" semantics without
 * importing the internal array.
 */
export { ACTIVE_LIFECYCLE_STATES, TERMINAL_LIFECYCLE_STATES, WINDING_DOWN_STATES };
