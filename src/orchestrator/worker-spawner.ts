/**
 * Worker spawning for AL-14.
 *
 * When a repo-admin receives a ticket (AL-13), this module creates a
 * dedicated git worktree for that ticket, then spawns the matching worker
 * agent (atlas / pixel / forge / probe / lens / …) scoped to that worktree.
 * The caller ({@link TicketRunner}) monitors the worker via {@link
 * WorkerHandle}, and tears down the worktree when the PR merges.
 *
 * Design principles:
 *
 *   - **Reuse existing infra.** The worktree is created through
 *     {@link SandboxProvider} (`GitWorktreeSandboxProvider`). The child
 *     process is spawned through the same `CommandInvoker` path Claude/Codex
 *     adapters use — we don't resurrect our own subprocess plumbing.
 *   - **Full-access inheritance.** `channel.fullAccess` is threaded through
 *     to the child so `--dangerously-skip-permissions` is set when (and only
 *     when) the channel opted in. Parity with `createLiveAgents` (AL-0).
 *   - **Observable.** The handle exposes a state getter and `onExit` hook so
 *     the ticket runner can detect exit, stderr tail, and the spawned
 *     sessionId without polling.
 *   - **Idempotent cleanup.** `stop(reason)` + sandbox `destroy` are both
 *     idempotent; repeated calls never throw.
 *
 * Scope discipline:
 *   - PR-merge cleanup lives here (via `destroyWorktree`) but the decision
 *     of *when* to call it is the ticket runner's (AL-14).
 *   - PR-review integration is AL-5's scope — this module only spawns the
 *     worker and hands back a handle.
 *   - Inter-admin coordination is AL-16; we serialize at the ticket runner
 *     layer (see top-of-file doc in `ticket-runner.ts`).
 */

import { EventEmitter } from "node:events";

import type { Channel, RepoAssignment } from "../domain/channel.js";
import type { AgentSpecialty } from "../domain/specialty.js";
import type { TicketLedgerEntry } from "../domain/ticket.js";

import {
  NodeCommandInvoker,
  type CommandInvoker,
  type SpawnedProcess,
} from "../agents/command-invoker.js";
import { GitWorktreeSandboxProvider } from "../execution/sandboxes/git-worktree.js";
import type { SandboxProvider, SandboxRef } from "../execution/sandbox.js";

/**
 * Stream retention per worker. Workers are long-running; a wedged tail-log
 * could balloon unbounded without a cap. 200 lines mirrors the repo-admin
 * session's stderr tail (STDERR_DIAGNOSTIC_LINES).
 */
export const WORKER_STDOUT_TAIL_LINES = 200;
export const WORKER_STDERR_TAIL_LINES = 200;

/**
 * Env vars a worker's Claude/Codex subprocess is allowed to read from the
 * parent. Mirrors `CLAUDE_PASS_ENV` from `cli-agents.ts` so a worker spawned
 * by AL-14 can auth the same way as one spawned by `createLiveAgents`.
 */
const WORKER_PASS_ENV: readonly string[] = [
  // Claude auth
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_HOME",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  // AWS (Bedrock)
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_PROFILE",
  // Google (Vertex)
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GCLOUD_PROJECT",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_QUOTA_PROJECT",
  "CLOUDSDK_CORE_PROJECT",
  // Workers use `gh pr create`; keep the token forwarded so the flow works
  // inside the sanitized subprocess env.
  "GITHUB_TOKEN",
  "GH_TOKEN",
];

export type WorkerState = "running" | "completed" | "failed" | "stopped";

export interface WorkerExitEvent {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  reason: string;
  /** Last {@link WORKER_STDOUT_TAIL_LINES} lines of stdout for diagnostics. */
  stdoutTail: string;
  /** Last {@link WORKER_STDERR_TAIL_LINES} lines of stderr for diagnostics. */
  stderrTail: string;
  /** PR URL detected in stdout, if any. Used by the ticket runner for AC3. */
  detectedPrUrl: string | null;
}

export interface WorkerHandle {
  readonly ticketId: string;
  /**
   * Per-child identifier minted at spawn time. Distinct from the repo-admin
   * session id that spawned it, so observers can correlate logs to one
   * worker's life.
   */
  readonly sessionId: string;
  readonly specialty: AgentSpecialty;
  readonly state: WorkerState;
  /**
   * PR URL scraped from the worker's stdout as it ran, updated live. `null`
   * until the worker prints (or the parent module detects via fallback) a
   * `github.com/<owner>/<repo>/pull/<n>` URL. Read by the ticket runner on
   * `onExit` — if still null after the worker exits, the runner triggers a
   * `gh pr list` fallback probe (see top-of-file doc).
   */
  readonly detectedPrUrl: string | null;
  /**
   * Absolute path of the worktree this worker is scoped to. Exposed so the
   * caller can destroy it on PR merge without holding the full `SandboxRef`.
   */
  readonly worktreePath: string;
  /**
   * Opaque sandbox reference. Kept on the handle so callers that prefer to
   * use the provider's destroy API (rather than a raw path) have a stable
   * pointer. Not intended for external mutation.
   */
  readonly sandboxRef: SandboxRef;

  /** Graceful stop: SIGTERM → 5s grace → SIGKILL. Idempotent. */
  stop(reason: string): Promise<void>;
  /**
   * Subscribe to the single exit event. Returns an unsubscribe function so
   * multiple observers can watch without fighting over a shared callback.
   * If the worker has already exited, the listener is invoked on next tick
   * with the final event — consumers don't have to race.
   */
  onExit(listener: (evt: WorkerExitEvent) => void): () => void;
}

export interface WorkerSpawnResult {
  handle: WorkerHandle;
  worktreePath: string;
  /** Sandbox reference needed to destroy the worktree later. */
  sandboxRef: SandboxRef;
}

export interface WorkerSpawnOptions {
  ticket: TicketLedgerEntry;
  repoAssignment: RepoAssignment;
  /**
   * Channel the ticket belongs to. AL-0: `channel.fullAccess` is threaded
   * through so the worker inherits the same "skip permission prompts"
   * posture the rest of the channel's agents use.
   */
  channel: Channel;
  /**
   * Base branch to worktree from. Defaults to `"main"` — matches what
   * `createWorktree` does across the repo. Callers may override for
   * topic-branch work.
   */
  base?: string;
}

export interface WorkerSpawnerOptions {
  /**
   * Sandbox provider. Defaults to `GitWorktreeSandboxProvider`; tests inject
   * a fake so the worktree path is deterministic without a real git repo.
   */
  sandboxProvider?: SandboxProvider;
  /**
   * Command invoker for spawning the worker child process. Defaults to
   * `NodeCommandInvoker`; tests inject a fake so stdout/exit is scripted.
   */
  invoker?: CommandInvoker;
  /** Session-id factory. Tests inject a deterministic one. */
  buildSessionId?: () => string;
  /** Clock for short-timestamp branch suffixes. Tests inject a fixed value. */
  clock?: () => number;
  /**
   * SIGTERM→SIGKILL grace period. Only tests override; production always
   * uses {@link WORKER_STOP_GRACE_MS}.
   */
  stopGraceMs?: number;
}

/** Hard grace period between SIGTERM and SIGKILL on `stop()`. */
export const WORKER_STOP_GRACE_MS = 5_000;

/**
 * Regex matching a GitHub PR URL in worker stdout. Deliberately permissive
 * on host (supports enterprise github.example.com) and tolerant of a
 * trailing slash / query string. Matches the shape `gh pr create` prints.
 */
const PR_URL_PATTERN = /https:\/\/[A-Za-z0-9.-]+\/[^/\s]+\/[^/\s]+\/pull\/\d+/;

/**
 * Map an `AgentSpecialty` to the canonical agent id spawned for that
 * specialty. Mirrors the `AGENT_SPECS` registry in `factory.ts`; keeping
 * this mapping local avoids importing the full spec array just to pluck
 * an id. Default fallback is `"atlas"` per the AL-14 ticket spec.
 */
export function specialtyToAgentId(specialty: AgentSpecialty | undefined): string {
  switch (specialty) {
    case "ui":
      return "pixel";
    case "business_logic":
    case "api_crud":
      return "forge";
    case "testing":
      return "probe";
    case "devops":
      return "forge";
    case "general":
    case "repo_admin":
    case undefined:
    default:
      return "atlas";
  }
}

/**
 * Module-local monotonic counter used to disambiguate runIds minted in the
 * same millisecond. Replaces the previous `Math.random().slice(2,6)`
 * suffix which had a non-trivial collision rate at high spawn rates —
 * two workers spawned in the same ms (which happens in tests, and may
 * happen in production once parallel drains land in AL-16) could collide
 * on worktree path. A counter can't collide inside one process.
 */
let runIdCounter = 0;

/**
 * Short time-stamp suffix used inside `runId` so two concurrent worker
 * spawns for the same ticket generate distinct worktree paths. The
 * counter suffix is monotonic; the leading `clock()` stamp keeps the id
 * roughly sortable for a human reader.
 */
function shortTimestamp(clock: () => number): string {
  const seq = (++runIdCounter).toString(36);
  return `${clock().toString(36)}-${seq}`;
}

/**
 * Default session-id factory for workers. Format embeds `worker-` prefix +
 * epoch ms + random suffix so logs unambiguously point at this module.
 */
function defaultBuildWorkerSessionId(): string {
  return `worker-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * WorkerSpawner — given a ticket + repo assignment + channel, produce a
 * live worker scoped to its own git worktree. One call == one worker;
 * callers own the returned handle's lifecycle.
 */
export class WorkerSpawner {
  private readonly sandboxProvider: SandboxProvider;
  private readonly invoker: CommandInvoker;
  private readonly buildSessionId: () => string;
  private readonly clock: () => number;
  private readonly stopGraceMs: number;

  constructor(options: WorkerSpawnerOptions = {}) {
    this.sandboxProvider = options.sandboxProvider ?? new GitWorktreeSandboxProvider();
    this.invoker = options.invoker ?? new NodeCommandInvoker();
    this.buildSessionId = options.buildSessionId ?? defaultBuildWorkerSessionId;
    this.clock = options.clock ?? Date.now;
    this.stopGraceMs = options.stopGraceMs ?? WORKER_STOP_GRACE_MS;
  }

  async spawn(options: WorkerSpawnOptions): Promise<WorkerSpawnResult> {
    if (typeof this.invoker.spawn !== "function") {
      throw new Error(
        "WorkerSpawner: injected invoker does not expose spawn(); workers require a streaming-capable invoker."
      );
    }

    const { ticket, repoAssignment, channel, base = "main" } = options;

    // Unique per-spawn runId so two tickets (same repo) or the same ticket
    // retried twice in a row never collide on worktree path or branch name.
    // The sandbox provider uses `sandbox/<runId>/<ticketId>` — `runId` is the
    // dial we turn to disambiguate.
    const runId = `work-${shortTimestamp(this.clock)}`;
    // The base SandboxProvider interface types create as `(repo, base)` —
    // the git-worktree impl widens it with an optional `{ runId, ticketId }`
    // bag so `git worktree list` traces back to the owning ticket. Same
    // cast shape used by `LocalChildProcessExecutor.start`; providers that
    // ignore the extra arg (NoopSandboxProvider) stay structurally compat.
    const provider = this.sandboxProvider as SandboxProvider & {
      create(
        repo: { root: string },
        base: string,
        options?: { runId: string; ticketId: string }
      ): Promise<SandboxRef>;
    };
    const sandboxRef = await provider.create({ root: repoAssignment.repoPath }, base, {
      runId,
      ticketId: ticket.ticketId,
    });

    if (sandboxRef.workdir.kind !== "local") {
      // Remote sandboxes are out of AL-14 scope — the worker needs a real
      // on-disk cwd to run a Claude child. Destroy the sandbox so we don't
      // leak, then fail loudly.
      await this.sandboxProvider.destroy(sandboxRef).catch(() => {});
      throw new Error(
        `WorkerSpawner: sandbox provider returned a remote workdir (${sandboxRef.workdir.kind}); worker cannot run without a local path.`
      );
    }

    const worktreePath = sandboxRef.workdir.path;
    const sessionId = this.buildSessionId();
    const specialty = (ticket.specialty ?? "general") as AgentSpecialty;

    // Wire the child process. `claude` is launched with `-p <prompt>` so
    // the worker runs until it finishes the task, rather than idling for
    // stdin like a repo-admin session. The worker's own agent role governs
    // *what* it does; AL-14's scope is the spawn + monitoring, not the
    // prompt content.
    const prompt = buildWorkerPrompt(ticket, repoAssignment, specialty);
    const fullAccess = channel.fullAccess === true;

    const args: string[] = ["-p"];
    if (fullAccess) {
      // AC2 — inherit the channel's full-access flag.
      args.push("--dangerously-skip-permissions");
    } else {
      args.push("--permission-mode", "default");
    }
    args.push(prompt);

    // Keep `this` bound to the invoker — tests use class-based fakes whose
    // spawn() relies on `this`; an unbound call would turn `this.spawned`
    // into `undefined`. `NodeCommandInvoker.spawn` is written as an arrow-
    // like stateless method so binding is a no-op there.
    const child = this.invoker.spawn!.call(this.invoker, {
      command: "claude",
      args,
      cwd: worktreePath,
      // Workers are long-lived; the outer ticket runner owns termination.
      timeoutMs: 0,
      env: {
        RELAY_WORKER_SESSION_ID: sessionId,
        RELAY_WORKER_TICKET_ID: ticket.ticketId,
        RELAY_WORKER_AGENT_ID: specialtyToAgentId(specialty),
      },
      passEnv: [...WORKER_PASS_ENV],
    });

    const handle = new LiveWorkerHandle({
      ticketId: ticket.ticketId,
      sessionId,
      specialty,
      worktreePath,
      sandboxRef,
      child,
      stopGraceMs: this.stopGraceMs,
    });

    return { handle, worktreePath, sandboxRef };
  }

  /**
   * Destroy a worktree. Idempotent via the underlying sandbox provider. On
   * the dirty case, preserves state for operator inspection (mirrors the
   * git-worktree provider's semantic). Called by the ticket runner on PR
   * merge; callers must NOT use this to paper over a worker failure —
   * failed workers keep their worktree for AC4.
   */
  async destroyWorktree(sandboxRef: SandboxRef): Promise<void> {
    await this.sandboxProvider.destroy(sandboxRef);
  }
}

interface LiveWorkerHandleOptions {
  ticketId: string;
  sessionId: string;
  specialty: AgentSpecialty;
  worktreePath: string;
  sandboxRef: SandboxRef;
  child: SpawnedProcess;
  stopGraceMs: number;
}

/**
 * Concrete {@link WorkerHandle}. Keeps its internals private so callers
 * don't reach into the child process directly — all interaction goes
 * through `state`, `onExit`, `stop`.
 */
class LiveWorkerHandle implements WorkerHandle {
  readonly ticketId: string;
  readonly sessionId: string;
  readonly specialty: AgentSpecialty;
  readonly worktreePath: string;
  readonly sandboxRef: SandboxRef;

  private _state: WorkerState = "running";
  private readonly emitter = new EventEmitter();
  private readonly child: SpawnedProcess;
  private readonly stopGraceMs: number;

  private stdoutBuf = "";
  private stderrBuf = "";
  private stdoutLines: string[] = [];
  private stderrLines: string[] = [];
  private _detectedPrUrl: string | null = null;
  private finalEvent: WorkerExitEvent | null = null;

  private stopRequested = false;
  private stopReason: string | null = null;
  private killTimer: NodeJS.Timeout | null = null;

  constructor(options: LiveWorkerHandleOptions) {
    this.ticketId = options.ticketId;
    this.sessionId = options.sessionId;
    this.specialty = options.specialty;
    this.worktreePath = options.worktreePath;
    this.sandboxRef = options.sandboxRef;
    this.child = options.child;
    this.stopGraceMs = options.stopGraceMs;

    this.wireChild();
  }

  get state(): WorkerState {
    return this._state;
  }

  get detectedPrUrl(): string | null {
    return this._detectedPrUrl;
  }

  onExit(listener: (evt: WorkerExitEvent) => void): () => void {
    // If the worker already exited, replay the final event on the next
    // microtask so subscribers don't have to race. Keeps the callback
    // contract "exactly once, regardless of subscription timing".
    if (this.finalEvent) {
      const evt = this.finalEvent;
      queueMicrotask(() => {
        try {
          listener(evt);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn(
            `WorkerHandle(${this.ticketId}): onExit listener threw: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      });
      return () => {};
    }
    this.emitter.on("exit", listener);
    return () => {
      this.emitter.off("exit", listener);
    };
  }

  async stop(reason: string): Promise<void> {
    if (this._state !== "running") {
      // Terminal already — second caller still awaits until the final
      // event has landed so the contract "stop() resolves only when the
      // child is truly gone" holds.
      await this.awaitExit();
      return;
    }
    if (this.stopRequested) {
      await this.awaitExit();
      return;
    }

    this.stopRequested = true;
    this.stopReason = reason;

    try {
      this.child.kill("SIGTERM");
    } catch {
      // Already exited — onExit will finish the transition.
    }

    this.killTimer = setTimeout(() => {
      this.killTimer = null;
      if (this._state === "running") {
        try {
          this.child.kill("SIGKILL");
        } catch {
          // Same as above.
        }
      }
    }, this.stopGraceMs);
    const t = this.killTimer as { unref?: () => void };
    if (t && typeof t.unref === "function") t.unref();

    await this.awaitExit();
  }

  private wireChild(): void {
    this.child.onStdout((chunk) => {
      this.stdoutBuf += chunk;
      let idx: number;
      while ((idx = this.stdoutBuf.indexOf("\n")) >= 0) {
        const line = this.stdoutBuf.slice(0, idx);
        this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
        this.pushStdoutLine(line);
      }
    });
    this.child.onStderr((chunk) => {
      this.stderrBuf += chunk;
      let idx: number;
      while ((idx = this.stderrBuf.indexOf("\n")) >= 0) {
        const line = this.stderrBuf.slice(0, idx);
        this.stderrBuf = this.stderrBuf.slice(idx + 1);
        this.pushStderrLine(line);
      }
    });
    this.child.onError((err) => {
      // Spawn-level error (e.g. ENOENT) — treat as failure.
      this.stderrLines.push(`[spawn-error] ${err.message}`);
      this.finish(null, null);
    });
    this.child.onExit((code, signal) => {
      // Flush any leftover partial lines before we stamp the tail.
      if (this.stdoutBuf) {
        this.pushStdoutLine(this.stdoutBuf);
        this.stdoutBuf = "";
      }
      if (this.stderrBuf) {
        this.pushStderrLine(this.stderrBuf);
        this.stderrBuf = "";
      }
      this.finish(code ?? null, signal ?? null);
    });
  }

  private pushStdoutLine(line: string): void {
    if (!line) return;
    this.stdoutLines.push(line);
    if (this.stdoutLines.length > WORKER_STDOUT_TAIL_LINES) {
      this.stdoutLines.splice(0, this.stdoutLines.length - WORKER_STDOUT_TAIL_LINES);
    }
    if (!this._detectedPrUrl) {
      const match = line.match(PR_URL_PATTERN);
      if (match) this._detectedPrUrl = match[0];
    }
  }

  private pushStderrLine(line: string): void {
    if (!line) return;
    this.stderrLines.push(line);
    if (this.stderrLines.length > WORKER_STDERR_TAIL_LINES) {
      this.stderrLines.splice(0, this.stderrLines.length - WORKER_STDERR_TAIL_LINES);
    }
  }

  private finish(exitCode: number | null, signal: NodeJS.Signals | null): void {
    if (this._state !== "running") return;
    if (this.killTimer) {
      clearTimeout(this.killTimer);
      this.killTimer = null;
    }

    let state: WorkerState;
    let reason: string;
    if (this.stopRequested) {
      state = "stopped";
      reason = this.stopReason ?? "stopped";
    } else if (exitCode === 0) {
      state = "completed";
      reason = "completed";
    } else {
      state = "failed";
      reason = `exit ${exitCode ?? "null"}${signal ? ` (signal ${signal})` : ""}`;
    }
    this._state = state;

    const evt: WorkerExitEvent = {
      exitCode,
      signal,
      reason,
      stdoutTail: this.stdoutLines.join("\n"),
      stderrTail: this.stderrLines.join("\n"),
      detectedPrUrl: this._detectedPrUrl,
    };
    this.finalEvent = evt;

    const listeners = this.emitter.listeners("exit") as Array<(e: WorkerExitEvent) => void>;
    for (const listener of listeners) {
      try {
        listener(evt);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `WorkerHandle(${this.ticketId}): onExit listener threw: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }
    this.emitter.removeAllListeners("exit");
  }

  private async awaitExit(): Promise<void> {
    if (this.finalEvent) return;
    await new Promise<void>((resolve) => {
      const off = this.onExit(() => {
        off();
        resolve();
      });
    });
  }
}

/**
 * Build the prompt handed to the Claude worker. Kept deliberately thin —
 * AL-14 is about the spawn + monitor mechanics, not worker prompt
 * engineering. The prompt names the ticket, the repo, and the PR-creation
 * expectation so stdout-tail detection of the PR URL remains the cheap
 * happy path.
 *
 * Exported so tests can assert on its shape (otherwise the exact text is
 * opaque to assertions).
 */
export function buildWorkerPrompt(
  ticket: TicketLedgerEntry,
  repoAssignment: RepoAssignment,
  specialty: AgentSpecialty
): string {
  const agentId = specialtyToAgentId(specialty);
  const lines = [
    `You are ${agentId}, running inside a per-ticket git worktree under Relay.`,
    ``,
    `Ticket: ${ticket.ticketId} — ${ticket.title}`,
    `Specialty: ${specialty}`,
    `Repo alias: ${repoAssignment.alias}`,
    `Worktree: ${repoAssignment.repoPath} (you are already cd'd into the worktree)`,
    ``,
    `Do the work the ticket describes. Commit your changes, push the branch,`,
    `and open a pull request via \`gh pr create\`. Print the resulting PR URL`,
    `on stdout so the orchestrator can track it — this is how Relay detects`,
    `that the ticket has produced a PR.`,
  ];
  return lines.join("\n");
}
