/**
 * Autonomous-session lifecycle states (AL-2). See `session-lifecycle.ts` for
 * the state machine that enforces valid transitions, and AL-4 for the
 * autonomous-loop driver that observes these states to decide whether to
 * keep dispatching tickets.
 */
export type LifecycleState =
  | "planning"
  | "dispatching"
  | "winding_down"
  | "audit"
  | "done"
  | "killed";

/**
 * The two lifecycle end-states. Once the machine is in either of these, no
 * further transitions are allowed and the watchdog timer is cleared.
 */
export const TERMINAL_STATES: readonly LifecycleState[] = ["done", "killed"] as const;

/**
 * Valid forward transitions keyed by source state. The state machine is
 * strictly one-way — there is no edge from a later state back to an
 * earlier one, and terminal states have no outgoing edges.
 */
export const VALID_TRANSITIONS: Readonly<Record<LifecycleState, readonly LifecycleState[]>> = {
  planning: ["dispatching", "killed"],
  dispatching: ["winding_down", "killed"],
  winding_down: ["audit", "done", "killed"],
  audit: ["done", "killed"],
  done: [],
  killed: [],
};

/**
 * Emitted on every successful transition. Listeners subscribe via
 * `SessionLifecycle.onTransition()` and receive each transition exactly
 * once in the order they happen.
 */
export interface TransitionEvent {
  from: LifecycleState;
  to: LifecycleState;
  reason?: string;
  /** `Date.now()`-style epoch millis at the moment the transition landed. */
  ts: number;
}

/**
 * Persisted record of a single transition. Same shape as `TransitionEvent`
 * but serializes `ts` as an ISO-8601 string for human-readable
 * `lifecycle.json` files.
 */
export interface PersistedTransition {
  from: LifecycleState;
  to: LifecycleState;
  reason?: string;
  at: string;
}

/**
 * On-disk shape of `~/.relay/sessions/<sessionId>/lifecycle.json`. The
 * machine overwrites this file atomically (tmp + rename) on every
 * transition, so readers always see either the pre- or post-transition
 * snapshot, never a torn intermediate.
 */
export interface LifecycleFile {
  sessionId: string;
  state: LifecycleState;
  startedAt: string;
  transitions: PersistedTransition[];
  maxDurationMs: number;
}

/**
 * Thrown by `SessionLifecycle.transition()` when the attempted target is
 * not reachable from the current state. Includes both the current state
 * and the attempted target so callers can render a useful message.
 */
export class LifecycleTransitionError extends Error {
  readonly from: LifecycleState;
  readonly to: LifecycleState;

  constructor(from: LifecycleState, to: LifecycleState) {
    super(`LifecycleTransitionError: cannot transition from "${from}" to "${to}"`);
    this.name = "LifecycleTransitionError";
    this.from = from;
    this.to = to;
  }
}

/** Default wall-clock budget: 8h. Matches the `--max-hours=8` CLI default. */
export const DEFAULT_MAX_DURATION_MS = 8 * 60 * 60 * 1000;
