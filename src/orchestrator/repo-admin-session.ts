/**
 * Per-repo repo-admin session wrapper (AL-12, extended by AL-15).
 *
 * One instance of this class owns exactly one long-lived `claude` child
 * process running the repo-admin role (AL-11). The pool (see
 * `repo-admin-pool.ts`) owns N of these — one per entry in the channel's
 * `repoAssignments`. The process is kept ALIVE for the duration of the
 * autonomous session; AL-13 is where tickets get dispatched to it.
 *
 * Responsibilities owned here (and only here):
 *   - Spawn the child via an injected {@link RepoAdminProcessSpawner}. The
 *     default spawner is the real one (Claude CLI); tests inject a fake so
 *     the lifecycle is deterministic.
 *   - Track its state machine: `booting` → `ready` → (optionally) `dead` →
 *     `ready` (after restart) → … → `stopped` on graceful shutdown.
 *   - React to unexpected exit: emit a `restart-needed` signal to the pool
 *     with the exit code + captured stderr tail. The pool decides whether
 *     to respawn (lifecycle may have moved to `winding_down`/terminal).
 *   - Graceful `stop(reason)`: send SIGTERM, wait {@link STOP_GRACE_MS},
 *     then SIGKILL. Idempotent.
 *   - Scaffold an in-memory ticket queue so AL-13 can add dispatches
 *     through this class without changing its shape. AL-12 never enqueues;
 *     it just carries the list so a restart doesn't drop in-flight work.
 *   - **AL-15**: own a per-session {@link TokenTracker} and the
 *     memory-shed cycle trigger. When the tracker crosses 60%, the session
 *     writes a one-line summary to the channel's decisions board, kills
 *     its own child, and respawns fresh. A cycle is NOT a restart —
 *     cycles do not count toward the pool's rapid-flap ceiling.
 *
 * Explicitly out of scope here (each has its own ticket):
 *   - Worker spawning from repo-admin  → AL-14 (runs inside the process,
 *     not this wrapper). AL-14 will also populate
 *     `worktreesInUse`/`openPrs` on the cycle snapshot; AL-15 stubs them
 *     as empty arrays.
 *   - Inter-admin coordination         → AL-16.
 *
 * The state machine purposely has no edge back from `stopped` — once a
 * session is stopped, a fresh session (new sessionId) is the only way
 * back. Restart AND cycle both reuse the same `RepoAdminSession` instance
 * so the pool's reference (and the in-flight queue) stay stable, while
 * minting a NEW session id + fresh child process underneath.
 */

import { EventEmitter } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { RepoAssignment } from "../domain/channel.js";
import type { TicketLedgerEntry } from "../domain/ticket.js";
import {
  NodeCommandInvoker,
  type CommandInvoker,
  type SpawnedProcess,
} from "../agents/command-invoker.js";
import { REPO_ADMIN_ROLE } from "../agents/repo-admin.js";
import { getDisallowedBuiltinsForRole } from "../mcp/role-allowlist.js";
import { TokenTracker, type ThresholdEvent } from "../budget/token-tracker.js";
import {
  buildCycleDecision,
  type CycleDecisionInput,
  type CycleReason,
  type CycleSummarySnapshot,
} from "./session-summary.js";

/** Hard grace period between SIGTERM and SIGKILL on `stop()`. */
export const STOP_GRACE_MS = 5_000;

/**
 * Window of stderr chunks retained for post-mortem diagnostics on
 * unexpected exit. Kept small so a chatty session doesn't balloon memory.
 */
export const STDERR_DIAGNOSTIC_LINES = 200;

/**
 * AL-15: default per-session token ceiling. 150k tokens matches the
 * Claude CLI's "roomy" long-session context, leaving headroom under a
 * 200k-token API window. Overridable per-session via
 * {@link RepoAdminSessionOptions.adminTokenCeiling}.
 */
export const DEFAULT_ADMIN_TOKEN_CEILING = 150_000;

/**
 * AL-15: the threshold (percent) at which a memory-shed cycle fires. The
 * {@link TokenTracker} THRESHOLDS list includes 60 for this purpose.
 * Exported so the pool's test + any future tuning lives in one place.
 */
export const CYCLE_THRESHOLD_PCT = 60;

export type RepoAdminSessionState = "booting" | "ready" | "dead" | "stopped";

/**
 * Abstraction over "start the repo-admin child process". The default
 * implementation shells out to the Claude CLI; tests inject a fake so the
 * exit/restart/shutdown mechanics can run without a real binary.
 */
export interface RepoAdminProcessSpawner {
  spawn(args: RepoAdminSpawnArgs): SpawnedProcess;
}

export interface RepoAdminSpawnArgs {
  /** Absolute path to the repo this session is foremanning. */
  repoPath: string;
  /** Alias of the `RepoAssignment` (e.g. `"frontend"`). */
  alias: string;
  /**
   * Per-session id minted on every (re)start. Distinct from the parent
   * autonomous-session id — lets observers correlate logs to one life of
   * the process across restarts.
   */
  sessionId: string;
  /**
   * `true` when the containing channel is opted into full-access mode
   * (AL-0). Passed through to `--dangerously-skip-permissions`.
   */
  fullAccess: boolean;
}

/**
 * Event payloads the session emits. The pool subscribes to these.
 *
 *  - `booted`            — child is spawned and ready for dispatch.
 *  - `exited-unexpected` — child exited while state was `ready` (or
 *    `booting`, which we treat as a boot crash). Pool decides whether to
 *    restart; includes the exit code + stderr tail for diagnostics.
 *  - `exited-expected`   — child exited during a deliberate `stop()` or
 *    a cycle tear-down. Use `reason` to distinguish (cycles pass
 *    `"cycle:<reason>"`).
 *  - `cycled`            — AL-15: a memory-shed cycle completed. The old
 *    child is gone, the new child is live under `newSessionId`. The pool
 *    mirrors this to its own `cycled` event so observers can reason at
 *    the pool level without subscribing to each session.
 */
export type RepoAdminSessionEvent =
  | { kind: "booted"; sessionId: string }
  | {
      kind: "exited-unexpected";
      previousSessionId: string;
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      stderrTail: string;
    }
  | {
      kind: "exited-expected";
      sessionId: string;
      reason: string;
      exitCode: number | null;
    }
  | {
      /**
       * AL-13: emitted when {@link RepoAdminSession.dispatchTicket} enqueues
       * a new ticket on the in-memory queue. The session only records
       * *intent* here — worker spawning + execution is AL-14's scope. The
       * event exists so observers (TUI, tests, later the autonomous-loop
       * driver) can confirm a routing decision landed without polling the
       * queue.
       */
      kind: "ticket-received";
      sessionId: string;
      ticketId: string;
    }
  | {
      kind: "cycled";
      previousSessionId: string;
      newSessionId: string;
      reason: CycleReason;
    };

/**
 * AL-15: minimal write-only view of {@link ChannelStore} the session
 * needs. Typed as the exact method shape so a fake in tests doesn't have
 * to stub the entire ChannelStore surface.
 */
export interface SessionDecisionWriter {
  recordDecision(channelId: string, input: CycleDecisionInput): Promise<unknown>;
}

/**
 * AL-15: wiring the session needs to write cycle summaries to the
 * decisions board. `channelId` is required for the ChannelStore API.
 * When unset, the session still cycles (process tear-down + respawn) but
 * logs a warning and skips the decision write — useful for tests and
 * for non-channel-backed sessions that might appear in future.
 */
export interface SessionCycleConfig {
  /** Channel on whose board the cycle summary is recorded. */
  channelId: string;
  /** Decision store. Accepts `ChannelStore` in production. */
  decisions: SessionDecisionWriter;
}

export interface RepoAdminSessionOptions {
  assignment: RepoAssignment;
  /** Inherited from the channel; toggles `--dangerously-skip-permissions`. */
  fullAccess: boolean;
  /**
   * Absolute directory where logs + metadata for this session land.
   * `repo-admin-pool.ts` computes this as
   * `~/.relay/sessions/<autonomous-sessionId>/repo-admins/<alias>/`.
   */
  logDir: string;
  /** Injected process spawner. Tests supply a fake; prod gets the default. */
  spawner?: RepoAdminProcessSpawner;
  /** Optional sessionId factory — tests can inject deterministic ids. */
  buildSessionId?: () => string;
  /**
   * Hard cap on SIGTERM→SIGKILL escalation delay. Overridable only for
   * tests — production always uses {@link STOP_GRACE_MS}.
   */
  stopGraceMs?: number;
  /**
   * AL-15: declared ceiling for this admin session's own token tracker.
   * Defaults to {@link DEFAULT_ADMIN_TOKEN_CEILING}. The tracker's 60%
   * crossing fires a memory-shed cycle.
   */
  adminTokenCeiling?: number;
  /**
   * AL-15: inject an alternative tracker (tests). The session's default
   * is a fresh {@link TokenTracker} keyed off the session id + log dir.
   * A caller can pass their own tracker here to share budget across
   * multiple sessions or to drive the cycle deterministically in tests.
   */
  tokenTracker?: TokenTracker;
  /**
   * AL-15: channel + decision-store wiring for the cycle summary entry.
   * When omitted, the session still cycles (process tear-down + respawn)
   * but skips the decision write.
   */
  cycle?: SessionCycleConfig;
  /**
   * AL-15: ISO-clock injection for the cycle event's `cycledAt` field.
   * Defaults to `() => new Date().toISOString()`.
   */
  cycleClock?: () => string;
}

/**
 * Thin helper to mint a unique session id per (re)start. Default format
 * embeds epoch ms + a short random suffix so two restarts a millisecond
 * apart still diverge.
 */
export function defaultBuildRepoAdminSessionId(): string {
  return `admin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Default spawner — shells out to the real Claude CLI via the node invoker. */
export class ClaudeRepoAdminSpawner implements RepoAdminProcessSpawner {
  constructor(private readonly invoker: CommandInvoker = new NodeCommandInvoker()) {
    if (typeof this.invoker.spawn !== "function") {
      throw new Error(
        "ClaudeRepoAdminSpawner: injected invoker does not expose spawn(); " +
          "repo-admin sessions require a streaming-capable invoker."
      );
    }
  }

  spawn(args: RepoAdminSpawnArgs): SpawnedProcess {
    // We keep the session IDLE: no `-p <prompt>`. The process sits waiting
    // for AL-13 to write structured dispatch messages through stdin. The
    // `--permission-mode` / `--dangerously-skip-permissions` split mirrors
    // `src/agents/cli-agents.ts` so both code paths agree on what
    // full-access means.
    const cliArgs: string[] = ["--permission-mode", "default"];
    if (args.fullAccess) {
      // Replace the default-permission pair with the unattended flag.
      cliArgs.splice(0, cliArgs.length, "--dangerously-skip-permissions");
    }
    // AL-11: enforce built-in lockdown via the Claude CLI flag. Without
    // this, repo-admin could call Edit/Write/Bash directly (those tools
    // don't round-trip through MCP).
    const disallowed = getDisallowedBuiltinsForRole(REPO_ADMIN_ROLE);
    if (disallowed.length > 0) {
      cliArgs.push("--disallowed-tools", disallowed.join(","));
    }

    // `spawn` is typed as optional on the invoker interface, but the
    // constructor above has already asserted it exists. Non-null assertion
    // is safe.
    return this.invoker.spawn!({
      command: "claude",
      args: cliArgs,
      cwd: args.repoPath,
      // No explicit timeout: repo-admin runs for the life of the
      // autonomous session. The pool owns termination, not a wall clock.
      timeoutMs: 0,
      // AL-11: activates the MCP per-role allowlist inside the spawned
      // session. RELAY_* flows through the default sanitizer whitelist,
      // so no `passEnv` gymnastics needed.
      env: { RELAY_AGENT_ROLE: REPO_ADMIN_ROLE },
      // Claude CLI still needs its auth creds; mirror the pass-list used
      // by the short-lived adapter in `src/agents/cli-agents.ts`.
      passEnv: [
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_MODEL",
        "CLAUDE_CONFIG_DIR",
        "CLAUDE_HOME",
      ],
    });
  }
}

export class RepoAdminSession {
  readonly alias: string;
  readonly repoPath: string;
  readonly logDir: string;
  private readonly fullAccess: boolean;
  private readonly spawner: RepoAdminProcessSpawner;
  private readonly buildSessionId: () => string;
  private readonly stopGraceMs: number;

  private readonly emitter = new EventEmitter();

  /**
   * Monotonically increasing counter of spawn attempts for THIS session.
   * The pool uses it in conjunction with its own rapid-restart book-
   * keeping to decide when to give up.
   */
  private _spawnCount = 0;
  private _currentSessionId: string = "";
  private _state: RepoAdminSessionState = "booting";
  private child: SpawnedProcess | null = null;

  /**
   * In-memory queue of tickets routed to this admin. AL-13 writes here via
   * {@link dispatchTicket}; AL-14 will drain it by spawning worker child
   * processes. The queue is preserved across restarts — we deliberately do
   * NOT clear it in `handleExit` so an unexpected death followed by the
   * pool's respawn leaves in-flight work intact.
   *
   * The contents are `TicketLedgerEntry`s (the same shape the channel's
   * ticket board stores) rather than `TicketDefinition`s because the
   * router's input is the ledger entry: it already carries the
   * `assignedAlias` routing decision and the `status` the router will
   * flip once the admin actually picks it up (AL-14).
   */
  private readonly pendingDispatches: TicketLedgerEntry[] = [];

  private stopRequested = false;
  private stopReason: string | null = null;
  private killTimer: NodeJS.Timeout | null = null;
  private recentStderr: string[] = [];

  /**
   * AL-15: monotonic count of memory-shed cycles for this session. Used
   * by tests + observability; the pool does NOT count cycles against its
   * rapid-flap ceiling (that counter lives on `RepoAdminPool`).
   */
  private _cycleCount = 0;

  /**
   * AL-15: true while the session is in the middle of a cycle. Guards
   * the `onExit` handler so the child's SIGTERM-driven exit is classified
   * as expected (not a crash), and prevents overlapping cycles.
   */
  private cyclingReason: CycleReason | null = null;
  private cyclePromise: Promise<void> | null = null;
  private readonly tokenTracker: TokenTracker;
  private readonly ownsTokenTracker: boolean;
  private readonly unsubscribeTokenTracker: () => void;
  private readonly cycleConfig: SessionCycleConfig | null;
  private readonly cycleClock: () => string;

  constructor(options: RepoAdminSessionOptions) {
    this.alias = options.assignment.alias;
    this.repoPath = options.assignment.repoPath;
    this.logDir = options.logDir;
    this.fullAccess = options.fullAccess;
    this.spawner = options.spawner ?? new ClaudeRepoAdminSpawner();
    this.buildSessionId = options.buildSessionId ?? defaultBuildRepoAdminSessionId;
    this.stopGraceMs = options.stopGraceMs ?? STOP_GRACE_MS;
    this.cycleConfig = options.cycle ?? null;
    this.cycleClock = options.cycleClock ?? (() => new Date().toISOString());

    // AL-15: the session's own token tracker. A caller that supplies one
    // (tests, or a future aggregator) owns its lifetime; otherwise we
    // mint a tracker keyed off the admin alias + logDir so disk writes
    // land alongside the session's other metadata.
    if (options.tokenTracker) {
      this.tokenTracker = options.tokenTracker;
      this.ownsTokenTracker = false;
    } else {
      const ceiling = options.adminTokenCeiling ?? DEFAULT_ADMIN_TOKEN_CEILING;
      // Tracker sessionId is `admin-<alias>` (not the per-spawn CHILD id)
      // so a replay across process-restarts recovers the admin's
      // accumulated budget. The tracker persists under the log dir's
      // parent (the admin dir), NOT the parent autonomous session's
      // `sessions/` directory, so each admin's budget file sits next to
      // its own logs.
      this.tokenTracker = new TokenTracker(`admin-${this.alias}`, ceiling, {
        rootDir: dirname(this.logDir),
      });
      this.ownsTokenTracker = true;
    }

    // Subscribe to threshold crossings. We only care about the 60 tier
    // (AL-15's memory-shed signal); everything else is other subsystems'
    // business. The unsubscribe function is stashed so `stop()` can
    // detach cleanly — otherwise a shared tracker (test-injected) would
    // keep this session alive through the listener reference.
    this.unsubscribeTokenTracker = this.tokenTracker.onThreshold((evt) =>
      this.handleThresholdEvent(evt)
    );
  }

  /** Current lifecycle state. Use for assertions; drives no logic itself. */
  get state(): RepoAdminSessionState {
    return this._state;
  }

  /**
   * The session id of the CURRENTLY running child process. Changes on
   * every restart. Empty string before the first `start()` resolves.
   */
  get sessionId(): string {
    return this._currentSessionId;
  }

  /** Total number of times the child has been spawned in this session's life. */
  get spawnCount(): number {
    return this._spawnCount;
  }

  /**
   * AL-15: number of memory-shed cycles the session has completed. Does
   * NOT include unexpected restarts. Tests assert on this to distinguish
   * cycles from restarts.
   */
  get cycleCount(): number {
    return this._cycleCount;
  }

  /**
   * AL-15: the tracker driving this session's cycle trigger. Exposed
   * read-only so callers (pool, dispatch code, tests) can `record()`
   * token usage on the session's own budget. The pool does NOT own this
   * — each admin has its own tracker so one chatty admin doesn't starve
   * its peers.
   */
  get tracker(): TokenTracker {
    return this.tokenTracker;
  }

  /**
   * Snapshot of pending dispatches. AL-13 pushes via `dispatchTicket`;
   * AL-14 will drain into worker processes. The array returned is a copy
   * — callers mutating it must not expect the session to see their
   * changes.
   *
   * Kept as `unknown[]` on the public surface for historical reasons (the
   * AL-12 scaffolding typed it that way to avoid pulling in ticket shapes
   * before they were needed). New code should prefer {@link pendingTickets}.
   */
  getPendingDispatches(): unknown[] {
    return this.pendingDispatches.slice();
  }

  /**
   * AL-13 + AL-14 consumer API. Returns the current pending queue, typed.
   * Same copy semantics as {@link getPendingDispatches}.
   */
  pendingTickets(): TicketLedgerEntry[] {
    return this.pendingDispatches.slice();
  }

  /**
   * AL-14 consumer API: pop the head of the pending queue FIFO-style.
   * Returns `null` when the queue is empty. Called by the ticket runner's
   * drain loop once per iteration; the returned ticket is NOT re-enqueued
   * on failure — the runner owns marking it `failed` on the channel board
   * (AC4), and a retry requires a fresh route through AL-13.
   *
   * Throws when the session is `stopped` so a stale reference can't drain
   * a dead admin. Mirrors the guard on {@link dispatchTicket}.
   */
  takeNextPendingTicket(): TicketLedgerEntry | null {
    if (this._state === "stopped") {
      throw new Error(
        `RepoAdminSession(${this.alias}): cannot takeNextPendingTicket after stop(); ` +
          `route through a fresh session.`
      );
    }
    return this.pendingDispatches.shift() ?? null;
  }

  /**
   * Subscribe to session events. Returns an unsubscribe function. The pool
   * always subscribes; other callers may (e.g. the TUI for live liveness
   * readouts).
   */
  onEvent(listener: (evt: RepoAdminSessionEvent) => void): () => void {
    this.emitter.on("event", listener);
    return () => {
      this.emitter.off("event", listener);
    };
  }

  /**
   * Spawn the child process. Writes metadata.json up front so a crashed
   * host can still inspect which alias / repoPath / sessionId the log
   * directory belongs to. Resolves once the child is wired up — NOT once
   * the agent is "ready" in the semantic sense (that is AL-13's
   * handshake).
   */
  async start(): Promise<void> {
    if (this._state === "stopped") {
      throw new Error(
        `RepoAdminSession(${this.alias}): cannot start() after stop(); ` +
          `create a new instance or let the pool handle respawns.`
      );
    }
    if (this.child) {
      // Already running — no-op. Avoids double-spawn from overlapping
      // restart triggers.
      return;
    }

    // AL-15: a cycle pre-mints the next session id so the decision entry
    // can reference it. Consume that stash if present; otherwise fall
    // back to the factory (normal start / restart path).
    const nextId = this.pendingNextSessionId ?? this.buildSessionId();
    this.pendingNextSessionId = null;
    this._currentSessionId = nextId;
    this._spawnCount += 1;
    this._state = "booting";
    this.recentStderr = [];

    await mkdir(this.logDir, { recursive: true });
    const metadataPath = join(this.logDir, "metadata.json");
    await writeFile(
      metadataPath,
      JSON.stringify(
        {
          alias: this.alias,
          repoPath: this.repoPath,
          currentSessionId: nextId,
          spawnCount: this._spawnCount,
          updatedAt: new Date().toISOString(),
        },
        null,
        2
      ),
      "utf8"
    );

    const child = this.spawner.spawn({
      repoPath: this.repoPath,
      alias: this.alias,
      sessionId: nextId,
      fullAccess: this.fullAccess,
    });
    this.child = child;

    child.onStdout(() => {
      // AL-12 does not parse stdout. AL-13 owns the wire protocol; this
      // hook exists so the pipe stays drained (Node's default buffers are
      // bounded, and a wedged subprocess WILL backpressure if nobody
      // reads).
    });
    child.onStderr((chunk) => {
      // Retain the tail for exit diagnostics. Split on newlines so a
      // multi-line stderr burst contributes proportionally; cap to the
      // last N lines so we don't grow unbounded.
      for (const line of chunk.split("\n")) {
        if (!line) continue;
        this.recentStderr.push(line);
        if (this.recentStderr.length > STDERR_DIAGNOSTIC_LINES) {
          this.recentStderr.splice(0, this.recentStderr.length - STDERR_DIAGNOSTIC_LINES);
        }
      }
    });
    child.onError((err) => {
      // Spawn error (e.g. ENOENT): treat same as unexpected exit so the
      // pool's restart policy kicks in. We don't have an exit code, so
      // surface the message in stderrTail.
      this.recentStderr.push(`[spawn-error] ${err.message}`);
      this.handleExit(null, null, /* expected */ false);
    });
    child.onExit((code, signal) => {
      this.handleExit(code ?? null, signal ?? null, /* expected */ this.stopRequested);
    });

    // Once the child is wired, mark ready. The "did it successfully boot"
    // question is semantic (AL-13 will ping the agent); mechanically, the
    // process is live as soon as spawn returns.
    this._state = "ready";
    this.emit({ kind: "booted", sessionId: nextId });
  }

  /**
   * Graceful shutdown. Idempotent — a second call resolves immediately
   * once the first has completed. SIGTERM → wait grace → SIGKILL. The
   * state transitions to `stopped` only after the child's `onExit` fires,
   * so callers awaiting `stop()` are guaranteed the process is truly
   * gone.
   */
  async stop(reason: string): Promise<void> {
    if (this._state === "stopped") return;
    if (this.stopRequested) {
      // A second caller overlapping the first: wait for it rather than
      // double-signalling.
      await this.awaitStopped();
      return;
    }

    this.stopRequested = true;
    this.stopReason = reason;

    if (!this.child) {
      // Not running (e.g. booting failed synchronously). Transition
      // directly to stopped so callers observe terminality.
      this._state = "stopped";
      this.detachTokenTracker();
      this.emit({
        kind: "exited-expected",
        sessionId: this._currentSessionId,
        reason,
        exitCode: null,
      });
      return;
    }

    // Subscribe to the exit event BEFORE sending SIGTERM. A spawner (or
    // an already-dead child) that fires `onExit` synchronously from
    // inside `kill()` would emit before any post-kill subscription could
    // hear it, leaving `awaitStopped()` waiting on a never-emitted
    // event. Ordering the subscribe first closes that race.
    const stopped = this.awaitStopped();

    try {
      this.child.kill("SIGTERM");
    } catch {
      // Already exited between the state check and the signal — the
      // onExit handler will finish the transition.
    }

    // Arm the SIGKILL fallback. onExit clears the timer when the child
    // goes down cleanly.
    this.killTimer = setTimeout(() => {
      this.killTimer = null;
      if (this._state !== "stopped" && this.child) {
        try {
          this.child.kill("SIGKILL");
        } catch {
          // Same as above — already gone.
        }
      }
    }, this.stopGraceMs);
    // Don't hold the event loop open waiting for an already-dead process.
    const t = this.killTimer as { unref?: () => void };
    if (t && typeof t.unref === "function") t.unref();

    await stopped;
  }

  /**
   * Mark the next unexpected exit as "expected" without SIGTERM'ing — the
   * pool uses this when it wants to wind down a session whose child has
   * already exited (e.g. detected crash during a lifecycle transition).
   * Idempotent. After this call, `stop()` still runs cleanup logic but
   * won't try to signal a non-existent process.
   */
  markStopped(reason: string): void {
    if (this._state === "stopped") return;
    this.stopRequested = true;
    this.stopReason = reason;
    this._state = "stopped";
    this.child = null;
    this.clearKillTimer();
    this.detachTokenTracker();
    this.emit({
      kind: "exited-expected",
      sessionId: this._currentSessionId,
      reason,
      exitCode: null,
    });
  }

  /**
   * AL-13: record a routing decision on this admin. The ticket is pushed
   * onto {@link pendingDispatches} and a `ticket-received` event fires so
   * observers can confirm the handoff landed. Worker spawning and actual
   * execution are AL-14's scope — this method only marks intent.
   *
   * Idempotent: dispatching the same `ticketId` twice is a no-op on the
   * second call (the event still fires so observers can track re-routes
   * without duplicating work). This matches how the router is likely to
   * behave in practice: a channel ticket board re-read that happens to
   * cover tickets already routed in the previous scan shouldn't grow the
   * queue unboundedly.
   *
   * Throws if the session has been stopped — dispatching into a dead
   * admin is a programming error the router should catch via
   * `pool.getSession(alias)`.
   */
  async dispatchTicket(ticket: TicketLedgerEntry): Promise<void> {
    if (this._state === "stopped") {
      throw new Error(
        `RepoAdminSession(${this.alias}): cannot dispatchTicket after stop(); ` +
          `route through a fresh session.`
      );
    }
    const existing = this.pendingDispatches.find((t) => t.ticketId === ticket.ticketId);
    if (!existing) {
      this.pendingDispatches.push(ticket);
    }
    this.emit({
      kind: "ticket-received",
      sessionId: this._currentSessionId,
      ticketId: ticket.ticketId,
    });
  }

  /**
   * AL-15: memory-shed cycle. Planned recycle of the child process.
   * Unlike `stop()` (graceful shutdown, terminal) and unlike the pool's
   * restart-on-death (unexpected exit, counted toward rapid-flap), a
   * cycle:
   *
   *   1. Captures a working-set snapshot (active tickets, worktrees,
   *      open PRs — the latter two stubbed until AL-14).
   *   2. Writes a one-line decision to the channel board via the
   *      configured {@link SessionCycleConfig.decisions} store.
   *   3. SIGTERM's the current child. The exit is CLASSIFIED as expected
   *      (reason: `cycle:<reason>`) so the pool doesn't try to restart
   *      and doesn't count it against its rapid-flap ceiling.
   *   4. Spawns a fresh child with a NEW session id. The pending queue
   *      is preserved across the boundary (it lives on the session
   *      wrapper, not in child-process memory).
   *   5. Emits a `cycled` event so observers (pool, TUI) can log the
   *      transition.
   *
   * Idempotent with respect to overlap: a second caller during an
   * in-flight cycle gets the same promise. Rejects if the session is
   * already `stopped` — a cycle is a mid-life operation, not a
   * resurrection.
   */
  async cycle(reason: CycleReason): Promise<void> {
    if (this._state === "stopped") {
      throw new Error(
        `RepoAdminSession(${this.alias}): cannot cycle() after stop(); ` +
          `cycle is a mid-life operation.`
      );
    }
    if (this.cyclePromise) {
      // Overlapping cycle request — return the in-flight one.
      return this.cyclePromise;
    }

    this.cyclingReason = reason;
    this.cyclePromise = this.performCycle(reason).finally(() => {
      this.cyclingReason = null;
      this.cyclePromise = null;
    });
    return this.cyclePromise;
  }

  // --- internals ----------------------------------------------------------

  /**
   * AL-15: core of the cycle flow. Separated from {@link cycle} so the
   * promise-memo logic is isolated from the actual work.
   */
  private async performCycle(reason: CycleReason): Promise<void> {
    const previousSessionId = this._currentSessionId;
    // Mint the next session id NOW so the decision entry can reference it.
    // The `start()` call below reuses this id by passing it through the
    // session-id factory — see the `pendingNextSessionId` stash.
    const nextSessionId = this.buildSessionId();
    this.pendingNextSessionId = nextSessionId;

    // 1) Build + write the decision. Snapshot the working set first so a
    //    failure in the write path doesn't leave the queue in a weird
    //    state. AL-14 populates worktreesInUse + openPrs; for AL-15 they
    //    are stubs.
    const snapshot: CycleSummarySnapshot = {
      activeTickets: this.snapshotActiveTicketIds(),
      worktreesInUse: [], // AL-14 will populate.
      openPrs: [], // AL-14 will populate.
      cycleReason: reason,
    };

    if (this.cycleConfig) {
      const decision = buildCycleDecision({
        alias: this.alias,
        previousSessionId,
        nextSessionId,
        snapshot,
        cycledAt: this.cycleClock(),
      });
      try {
        await this.cycleConfig.decisions.recordDecision(this.cycleConfig.channelId, decision);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // A decision-write failure is loud but non-fatal: the cycle
        // still proceeds so the session doesn't wedge at 60%+ context.
        // The post-cycle admin will see a gap in the board and rebuild
        // from the adjacent entries.
        console.warn(
          `RepoAdminSession(${this.alias}): cycle decision write failed (${reason}): ${msg}`
        );
      }
    }

    // 2) Tear down the current child. `stopChild` classifies the exit as
    //    expected with a `cycle:<reason>` marker so `handleExit` doesn't
    //    emit `exited-unexpected` (which would trip the pool's
    //    restart-on-death path and count this toward rapid-flap).
    await this.stopChildForCycle(reason);

    // 3) Spawn a fresh child. The `pendingNextSessionId` is consumed
    //    inside `start()` so the session id in the decision entry
    //    matches the spawned child's id exactly.
    await this.start();

    // 4) Reset the tracker. The cycle is a process boundary: the new
    //    child has no context window residue from the old one, so its
    //    token budget starts fresh. Without this, `firedThresholds` still
    //    contains 60 from the triggering crossing and `_used` keeps
    //    accumulating pre-cycle counts — only ONE auto-cycle could ever
    //    fire per session lifetime. `reset()` rotates the JSONL on disk
    //    so the pre-cycle data is preserved for audit.
    try {
      await this.tokenTracker.reset();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // A reset failure is loud but not cycle-fatal. The session is
      // already mid-cycle; aborting here would leave the new child up
      // with a stale tracker — which is no worse than the pre-fix
      // behavior. Surface it and move on.
      console.warn(
        `RepoAdminSession(${this.alias}): cycle tracker reset failed (${reason}): ${msg}`
      );
    }

    // 5) Bookkeeping + observer event.
    this._cycleCount += 1;
    this.emit({
      kind: "cycled",
      previousSessionId,
      newSessionId: this._currentSessionId,
      reason,
    });
  }

  /**
   * AL-15: snapshot the pending-dispatch queue as ticket ids. AL-13 will
   * populate the queue with real dispatch records; here we accept either
   * a raw ticket id string, an object with `ticketId`, or fall back to
   * `String(entry)`. The test for AL-15 stuffs the queue with bare
   * ticket-id strings (the AL-13 wire shape isn't landed yet).
   */
  private snapshotActiveTicketIds(): string[] {
    const out: string[] = [];
    for (const entry of this.pendingDispatches) {
      if (typeof entry === "string") {
        out.push(entry);
      } else if (entry && typeof entry === "object" && "ticketId" in entry) {
        const v = (entry as { ticketId: unknown }).ticketId;
        if (typeof v === "string") out.push(v);
      }
    }
    return out;
  }

  /**
   * AL-15: tear-down path for the cycle. Mirrors `stop()`'s SIGTERM →
   * SIGKILL escalation but does NOT transition the session to `stopped`
   * — the state machine stays mid-life so the subsequent `start()` is
   * legal. The exit event emitted is `exited-expected` with a
   * `cycle:<reason>` string, distinguishable from the graceful-shutdown
   * reason by prefix.
   */
  private async stopChildForCycle(reason: CycleReason): Promise<void> {
    if (!this.child) return;

    const cycleReasonTag = `cycle:${reason}`;
    this.stopReason = cycleReasonTag;
    // Mark the exit as expected so handleExit classifies it as
    // `exited-expected` with the cycle reason. We reuse the same flag
    // that `stop()` uses so the existing classification path handles
    // this without a separate code branch in `handleExit`.
    this.stopRequested = true;

    // Subscribe to the exit event BEFORE sending SIGTERM. Some spawners
    // (and some crashed children) surface `onExit` synchronously from
    // within `kill()`, which would emit before any listener wired up
    // AFTER `kill()` could hear it — and this promise would never
    // resolve. Ordering the subscribe first closes that race.
    const exited = new Promise<void>((resolve) => {
      const off = this.onEvent((evt) => {
        if (evt.kind === "exited-expected" && evt.reason === cycleReasonTag) {
          off();
          resolve();
        }
      });
    });

    try {
      this.child.kill("SIGTERM");
    } catch {
      // Already exited between the state check and the signal.
    }

    this.killTimer = setTimeout(() => {
      this.killTimer = null;
      if (this.child) {
        try {
          this.child.kill("SIGKILL");
        } catch {
          // Same as above.
        }
      }
    }, this.stopGraceMs);
    const t = this.killTimer as { unref?: () => void };
    if (t && typeof t.unref === "function") t.unref();

    // Wait for the child to actually exit. Unlike `stop()`'s
    // `awaitStopped`, we don't transition to `stopped` — the session
    // reverts to an internal "between cycles" state which `start()`
    // promotes back to `booting`/`ready` on respawn.
    await exited;

    // Reset the flags so the subsequent `start()` + eventual `stop()`
    // aren't confused by the cycle's bookkeeping.
    this.stopRequested = false;
    this.stopReason = null;
    this.clearKillTimer();
  }

  /**
   * AL-15: stash used by `performCycle` to thread the next session id
   * through `start()`. Normal (non-cycle) starts leave this null and the
   * default factory is used.
   */
  private pendingNextSessionId: string | null = null;

  /**
   * AL-15: threshold-event handler for the per-session token tracker.
   * Fires a cycle when the 60% tier crosses; other tiers are ignored
   * (other subsystems subscribe separately if they care).
   */
  private handleThresholdEvent(evt: ThresholdEvent): void {
    if (evt.threshold !== CYCLE_THRESHOLD_PCT) return;
    if (this._state === "stopped") return;
    if (this.cyclePromise) return;
    void this.cycle("budget-60pct").catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `RepoAdminSession(${this.alias}): auto-cycle on ${CYCLE_THRESHOLD_PCT}% failed: ${msg}`
      );
    });
  }

  private handleExit(
    exitCode: number | null,
    signal: NodeJS.Signals | null,
    expected: boolean
  ): void {
    this.clearKillTimer();
    const previousSessionId = this._currentSessionId;
    const previousState = this._state;
    this.child = null;

    if (expected) {
      const reason = this.stopReason ?? "unknown";
      // AL-15: a cycle's exit is "expected" but does NOT terminate the
      // session — it's a mid-life tear-down before respawn. We detect
      // that by the `cycle:` prefix left in `stopReason` by
      // `stopChildForCycle`. In that case, stay out of the terminal
      // state; `performCycle` will call `start()` next.
      if (reason.startsWith("cycle:")) {
        this.emit({
          kind: "exited-expected",
          sessionId: previousSessionId,
          reason,
          exitCode,
        });
        return;
      }
      this._state = "stopped";
      this.detachTokenTracker();
      this.emit({
        kind: "exited-expected",
        sessionId: previousSessionId,
        reason,
        exitCode,
      });
      return;
    }

    // Unexpected exit — pool decides whether to restart. We transition to
    // `dead` so an observer can distinguish "process running" from
    // "process gone, waiting on restart decision".
    if (previousState === "stopped") return; // already terminal
    this._state = "dead";
    this.emit({
      kind: "exited-unexpected",
      previousSessionId,
      exitCode,
      signal,
      stderrTail: this.recentStderr.join("\n"),
    });
  }

  /**
   * AL-15: detach the token-tracker subscription + close the tracker if
   * we own it. Safe to call multiple times; the unsubscribe wrapper is
   * a no-op after the first call, and `TokenTracker.close()` is
   * idempotent.
   */
  private detachTokenTracker(): void {
    this.unsubscribeTokenTracker();
    if (this.ownsTokenTracker) {
      // Fire-and-forget: close() flushes pending writes. A caller
      // waiting on `stop()` has already observed `exited-expected`, so
      // we don't need to block them on disk IO.
      void this.tokenTracker.close().catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`RepoAdminSession(${this.alias}): tracker close failed: ${msg}`);
      });
    }
  }

  private clearKillTimer(): void {
    if (this.killTimer !== null) {
      clearTimeout(this.killTimer);
      this.killTimer = null;
    }
  }

  private async awaitStopped(): Promise<void> {
    if (this._state === "stopped") return;
    await new Promise<void>((resolve) => {
      const off = this.onEvent((evt) => {
        if (evt.kind === "exited-expected") {
          off();
          resolve();
        }
      });
    });
  }

  private emit(evt: RepoAdminSessionEvent): void {
    // Mirror SessionLifecycle.safeEmitTransition: a listener throwing
    // should not take down the session's own event loop.
    const listeners = this.emitter.listeners("event") as Array<
      (evt: RepoAdminSessionEvent) => void
    >;
    for (const listener of listeners) {
      try {
        listener(evt);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.warn(`RepoAdminSession(${this.alias}): listener threw on ${evt.kind}: ${msg}`);
      }
    }
  }
}

/**
 * Ensure `dirname` exists. Exported so the pool module doesn't need to
 * import `node:fs/promises` separately — keeps the "repo-admin session
 * mounts its own log dir" story contained here.
 */
export async function ensureRepoAdminLogParent(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
}
