/**
 * Per-repo repo-admin session wrapper (AL-12).
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
 *
 * Explicitly out of scope here (each has its own ticket):
 *   - Ticket routing / wire protocol   → AL-13 (`dispatchTicket` throws).
 *   - Worker spawning from repo-admin  → AL-14 (runs inside the process,
 *     not this wrapper).
 *   - Memory-shed / session cycling    → AL-15.
 *
 * The state machine purposely has no edge back from `stopped` — once a
 * session is stopped, a fresh session (new sessionId) is the only way
 * back. Restart reuses the same `RepoAdminSession` instance so the pool's
 * reference stays stable, but mints a NEW session id + fresh child
 * process, preserving the in-flight queue.
 */

import { EventEmitter } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { RepoAssignment } from "../domain/channel.js";
import {
  NodeCommandInvoker,
  type CommandInvoker,
  type SpawnedProcess,
} from "../agents/command-invoker.js";
import { REPO_ADMIN_ROLE } from "../agents/repo-admin.js";
import { getDisallowedBuiltinsForRole } from "../mcp/role-allowlist.js";

/** Hard grace period between SIGTERM and SIGKILL on `stop()`. */
export const STOP_GRACE_MS = 5_000;

/**
 * Window of stderr chunks retained for post-mortem diagnostics on
 * unexpected exit. Kept small so a chatty session doesn't balloon memory.
 */
export const STDERR_DIAGNOSTIC_LINES = 200;

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
 *  - `exited-expected`   — child exited during a deliberate `stop()`.
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
    };

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
   * Scaffolding for AL-13's ticket dispatch. Nothing enqueues here today;
   * the field is shaped + documented so the pool-shutdown / restart paths
   * don't have to change when AL-13 lands. Preserving the queue across
   * restarts is how we honor the "ticket in-flight survives" criterion.
   */
  private readonly pendingDispatches: unknown[] = [];

  private stopRequested = false;
  private stopReason: string | null = null;
  private killTimer: NodeJS.Timeout | null = null;
  private recentStderr: string[] = [];

  constructor(options: RepoAdminSessionOptions) {
    this.alias = options.assignment.alias;
    this.repoPath = options.assignment.repoPath;
    this.logDir = options.logDir;
    this.fullAccess = options.fullAccess;
    this.spawner = options.spawner ?? new ClaudeRepoAdminSpawner();
    this.buildSessionId = options.buildSessionId ?? defaultBuildRepoAdminSessionId;
    this.stopGraceMs = options.stopGraceMs ?? STOP_GRACE_MS;
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
   * Snapshot of pending dispatches. AL-13 will push to this list through
   * `dispatchTicket`; tests for AL-12 inspect it to confirm restart
   * preservation.
   */
  getPendingDispatches(): unknown[] {
    return this.pendingDispatches.slice();
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

    const nextId = this.buildSessionId();
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
      this.emit({
        kind: "exited-expected",
        sessionId: this._currentSessionId,
        reason,
        exitCode: null,
      });
      return;
    }

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

    await this.awaitStopped();
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
    this.emit({
      kind: "exited-expected",
      sessionId: this._currentSessionId,
      reason,
      exitCode: null,
    });
  }

  /**
   * AL-13 placeholder. Signature matches the intended contract so
   * call-sites (and the typecheck) stay stable when AL-13 wires the
   * actual dispatch.
   */
  async dispatchTicket(_ticketDef: unknown): Promise<never> {
    throw new Error("RepoAdminSession.dispatchTicket: ticket dispatch is implemented in AL-13.");
  }

  // --- internals ----------------------------------------------------------

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
      this._state = "stopped";
      this.emit({
        kind: "exited-expected",
        sessionId: previousSessionId,
        reason: this.stopReason ?? "unknown",
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
