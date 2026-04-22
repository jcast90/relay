import type { TicketDefinition } from "../domain/ticket.js";
import {
  NodeCommandInvoker,
  type CommandInvocation,
  type CommandInvoker,
  type SpawnedProcess,
} from "../agents/command-invoker.js";
import type {
  AgentExecutor,
  ExecutionEvent,
  ExecutionHandle,
  ExecutionResult,
  ExecutionStatus,
  ExecutorStartOptions,
} from "./executor.js";
import type { SandboxProvider, SandboxRef } from "./sandbox.js";

/**
 * Resolves a ticket to the argv the child process should run.
 *
 * Returning `null` lets a resolver opt-out without throwing — useful for
 * chained resolvers. The default resolver picks the first entry in
 * `ticket.allowedCommands` and shell-splits it into argv via whitespace.
 * Callers with a real agent CLI (codex, claude-cli, …) inject their own
 * resolver so the executor stays decoupled from agent choice.
 */
export type CommandResolver = (
  ticket: TicketDefinition,
  opts: ExecutorStartOptions
) => ResolvedCommand | null;

export interface ResolvedCommand {
  command: string;
  args: string[];
  stdin?: string;
  env?: Record<string, string | undefined>;
}

export interface LocalChildProcessExecutorOptions {
  invoker?: CommandInvoker;
  /**
   * Optional provider. When set, the executor creates one sandbox per
   * {@link AgentExecutor.start} call via {@link SandboxProvider.create} and
   * destroys it when the handle's {@link ExecutionHandle.wait} resolves (on
   * both success and failure paths). When omitted, callers must pass a
   * pre-built sandbox via {@link ExecutorStartOptions.sandbox} and are
   * responsible for its lifecycle.
   */
  sandboxProvider?: SandboxProvider;
  /** Command resolver; defaults to picking the first allowedCommand. */
  resolveCommand?: CommandResolver;
  /** Heartbeat cadence while the child is alive (ms). */
  heartbeatIntervalMs?: number;
  /**
   * Delay between SIGTERM and SIGKILL escalation on timeout. Factored out as
   * an option so tests don't have to sleep 2s to exercise the escalation.
   */
  killGraceMs?: number;
  /**
   * Hard cap after SIGKILL: if the OS never delivers an exit event within
   * this window we synthesize one so `wait()` can never hang. See
   * {@link LocalExecutionHandle}'s `armPostKillWatchdog` for the tradeoff.
   * Factored out so tests can trip the cap cheaply.
   */
  postKillWatchdogMs?: number;
  /**
   * Ceiling on emitted heartbeat events. Defense-in-depth for the (rare)
   * case where finalize never runs: a bounded interval can't flood a
   * subscriber forever.
   */
  maxHeartbeatCount?: number;
}

const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_KILL_GRACE_MS = 2_000;
// 124 is the shell timeout convention (coreutils `timeout` exits 124 on expiry).
const TIMEOUT_EXIT_CODE = 124;
// 128 + 9 (SIGKILL); matches NoopExecutor and the usual Unix convention.
const KILLED_EXIT_CODE = 137;
// Shell conventions surfaced by /bin/sh and bash:
//   127 = command not found (maps to spawn ENOENT)
//   126 = found but not executable / permission denied (maps to EACCES)
// We mirror these so operators can tell apart "binary missing" from "binary
// ran and exited 1" without having to parse the reason string.
const COMMAND_NOT_FOUND_EXIT_CODE = 127;
const PERMISSION_DENIED_EXIT_CODE = 126;
// Cap after SIGKILL: if the child still hasn't exited within this window we
// synthesize a terminal exit so `wait()` resolves. See `armPostKillWatchdog`.
const POST_KILL_WATCHDOG_MS = 5_000;
// Hard cap on heartbeat emissions. At the default 30s cadence this is ~1h of
// liveness signal. Past the cap we emit one final heartbeat (with an error
// marker on the event data) and stop the interval — defense-in-depth so a
// handle that somehow never finalizes can't flood a subscriber forever.
const MAX_HEARTBEAT_COUNT = 120;
const SUMMARY_PREFIX_LENGTH = 120;

function defaultResolveCommand(ticket: TicketDefinition): ResolvedCommand | null {
  const first = ticket.allowedCommands[0];
  if (!first) return null;
  const parts = first.trim().split(/\s+/);
  const [command, ...args] = parts;
  if (!command) return null;
  return { command, args };
}

interface QueuedEvent {
  event: ExecutionEvent;
  isTerminal: boolean;
}

/**
 * Multi-consumer, pull-based event fanout. Each subscriber gets its own
 * buffer so slow consumers can't block the producer, and late subscribers on
 * a completed handle still see the cached `start` + `exit` pair (matching the
 * documented {@link ExecutionHandle.stream} contract).
 */
class EventBus {
  private readonly subscribers = new Set<(event: QueuedEvent) => void>();
  private cachedStart: ExecutionEvent | null = null;
  private cachedExit: ExecutionEvent | null = null;

  emit(event: ExecutionEvent, isTerminal = false): void {
    if (event.kind === "start") {
      this.cachedStart = event;
    } else if (event.kind === "exit") {
      this.cachedExit = event;
    }
    for (const subscriber of this.subscribers) {
      subscriber({ event, isTerminal });
    }
  }

  subscribe(onEvent: (event: QueuedEvent) => void): () => void {
    this.subscribers.add(onEvent);
    return () => {
      this.subscribers.delete(onEvent);
    };
  }

  get completed(): boolean {
    return this.cachedExit !== null;
  }

  get cache(): { start: ExecutionEvent | null; exit: ExecutionEvent | null } {
    return { start: this.cachedStart, exit: this.cachedExit };
  }
}

interface HandleDeps {
  id: string;
  sandbox: SandboxRef;
  process: SpawnedProcess;
  timeoutMs?: number;
  heartbeatIntervalMs: number;
  killGraceMs: number;
  /**
   * Hard-cap window after SIGKILL before we synthesize an exit and resolve
   * {@link ExecutionHandle.wait}. Factored out so tests don't sleep 5s.
   */
  postKillWatchdogMs?: number;
  /**
   * Ceiling on the number of heartbeat events emitted. Factored out so tests
   * can trip the cap cheaply; production leaves the default.
   */
  maxHeartbeatCount?: number;
  /** Context for teardown-failure warnings (helps operators trace drift). */
  runId: string;
  ticketId: string;
  onComplete: (result: ExecutionResult) => Promise<void> | void;
}

class LocalExecutionHandle implements ExecutionHandle {
  readonly id: string;
  readonly sandbox: SandboxRef;

  private readonly bus = new EventBus();
  private stdoutBuf = "";
  private stderrBuf = "";
  private cachedResult: ExecutionResult | null = null;
  private killRequested = false;
  private timedOut = false;
  private waitPromise: Promise<ExecutionResult> | null = null;
  private timeoutHandle: NodeJS.Timeout | null = null;
  private heartbeatHandle: NodeJS.Timeout | null = null;
  private escalationHandle: NodeJS.Timeout | null = null;
  private postKillWatchdogHandle: NodeJS.Timeout | null = null;
  private childAlive = true;
  private heartbeatCount = 0;

  constructor(private readonly deps: HandleDeps) {
    this.id = deps.id;
    this.sandbox = deps.sandbox;
    this.bus.emit({ kind: "start", at: new Date().toISOString() });
    this.wireProcess();
    this.startHeartbeat();
    this.armTimeout();
  }

  get status(): ExecutionStatus {
    if (this.cachedResult) {
      // `killed` is only the observable status when kill() drove the exit;
      // a natural exit after a no-op kill-after-wait stays `exited`. Same
      // contract as NoopExecutor.
      return this.killRequested && this.cachedResult.exitCode === KILLED_EXIT_CODE
        ? "killed"
        : "exited";
    }
    return this.killRequested ? "killed" : "running";
  }

  wait(): Promise<ExecutionResult> {
    if (!this.waitPromise) {
      this.waitPromise = new Promise<ExecutionResult>((resolve) => {
        const check = () => {
          if (this.cachedResult) {
            resolve(this.cachedResult);
            return;
          }
          // Subscribe to the bus so we wake up exactly when exit fires —
          // cheaper than polling and avoids a stray setTimeout race.
          const unsubscribe = this.bus.subscribe(({ event }) => {
            if (event.kind === "exit" && this.cachedResult) {
              unsubscribe();
              resolve(this.cachedResult);
            }
          });
          // Re-check: exit could have fired between the `if` above and the
          // subscribe call, leaving us subscribed after the last emit.
          if (this.cachedResult) {
            unsubscribe();
            resolve(this.cachedResult);
          }
        };
        check();
      });
    }
    return this.waitPromise;
  }

  async kill(signal: "SIGTERM" | "SIGKILL" = "SIGTERM"): Promise<void> {
    if (this.cachedResult) {
      // kill-after-wait is a no-op. Preserves the documented idempotency
      // contract on ExecutionHandle.kill.
      return;
    }
    this.killRequested = true;
    if (this.childAlive) {
      this.deps.process.kill(signal);
      if (signal === "SIGKILL") {
        this.armPostKillWatchdog();
      }
    }
  }

  async *stream(): AsyncIterable<ExecutionEvent> {
    if (this.bus.completed) {
      // Late subscribers on a completed handle get the cached terminal pair
      // synthesized from state — matches the NoopExecutor contract.
      const { start, exit } = this.bus.cache;
      if (start) yield start;
      if (exit) yield exit;
      return;
    }

    const queue: QueuedEvent[] = [];
    let resolver: (() => void) | null = null;

    const unsubscribe = this.bus.subscribe((ev) => {
      queue.push(ev);
      resolver?.();
      resolver = null;
    });

    // The `start` event fires once during handle construction, so a subscriber
    // that calls stream() AFTER the ctor returned would miss it. Replay the
    // cached `start` first so every fresh iterator sees a coherent begin —
    // the contract is "start → chunks → exit", not "maybe-start-chunks-exit".
    const cachedStart = this.bus.cache.start;
    if (cachedStart) yield cachedStart;

    try {
      while (true) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            resolver = resolve;
          });
        }
        const next = queue.shift();
        if (!next) continue;
        // Skip a re-broadcast of `start` — we already yielded the cached one
        // above. This handles the (rare) race where the subscribe callback
        // fires before we check the cached flag. Any other event kind passes
        // through unchanged.
        if (next.event.kind === "start" && cachedStart) continue;
        yield next.event;
        if (next.isTerminal) return;
      }
    } finally {
      unsubscribe();
    }
  }

  private wireProcess(): void {
    this.deps.process.onStdout((chunk) => {
      this.stdoutBuf += chunk;
      this.bus.emit({
        kind: "stdout",
        at: new Date().toISOString(),
        data: chunk,
      });
    });
    this.deps.process.onStderr((chunk) => {
      this.stderrBuf += chunk;
      this.bus.emit({
        kind: "stderr",
        at: new Date().toISOString(),
        data: chunk,
      });
    });
    this.deps.process.onError((error) => {
      // Spawn-level error (ENOENT etc.): treat as a killed-style terminal so
      // wait() resolves instead of hanging forever. Map the POSIX errno into
      // the shell convention so "binary missing" (127) and "permission
      // denied" (126) stay distinguishable from a real exit 1 — operators
      // reading a run log shouldn't have to grep the reason string to tell
      // those apart. Unknown codes fall through to 1.
      this.stderrBuf += error.message;
      const code = (error as NodeJS.ErrnoException).code;
      const reason = code ? `${error.message} (code ${code})` : error.message;
      let exitCode = 1;
      if (code === "ENOENT") {
        exitCode = COMMAND_NOT_FOUND_EXIT_CODE;
      } else if (code === "EACCES") {
        exitCode = PERMISSION_DENIED_EXIT_CODE;
      }
      this.finalize(exitCode, reason);
    });
    this.deps.process.onExit((code, signal) => {
      this.childAlive = false;
      if (this.timedOut) {
        this.finalize(TIMEOUT_EXIT_CODE, "timed out");
        return;
      }
      if (this.killRequested) {
        this.finalize(KILLED_EXIT_CODE, "killed");
        return;
      }
      // Unix convention: signal-terminated processes surface as 128+signo so
      // callers can distinguish them from natural exits. We preserve Node's
      // own `code` when present, otherwise fall back to signo arithmetic.
      const exitCode = code ?? (signal ? 128 + signalToNumber(signal) : 1);
      this.finalize(exitCode);
    });
  }

  private startHeartbeat(): void {
    // Fire the first heartbeat after the interval, not immediately — we just
    // emitted `start`, so an instant heartbeat would be noise. T-301's
    // stuck-agent detector subscribes via `stream()` and reads these.
    //
    // Defense in depth: finalize() normally clears this interval. If the
    // child ever ends up stuck in a state where finalize never runs (the
    // post-SIGKILL watchdog below is the primary guard), an unbounded
    // interval would flood every `stream()` subscriber forever. Cap the
    // emission count — at the default 30s cadence 120 ticks is ~1h, which
    // is well past any realistic ticket runtime. After the cap we emit one
    // final heartbeat annotated as terminal-via-error and stop the timer.
    const maxCount = this.deps.maxHeartbeatCount ?? MAX_HEARTBEAT_COUNT;
    this.heartbeatHandle = setInterval(() => {
      if (this.cachedResult) return;
      this.heartbeatCount += 1;
      if (this.heartbeatCount > maxCount) {
        // One last heartbeat with an error marker so subscribers observe the
        // cap rather than just silently losing the liveness signal, then
        // stop ticking.
        this.bus.emit({
          kind: "heartbeat",
          at: new Date().toISOString(),
          data: "heartbeat-cap-reached",
        });
        if (this.heartbeatHandle) clearInterval(this.heartbeatHandle);
        this.heartbeatHandle = null;
        return;
      }
      this.bus.emit({ kind: "heartbeat", at: new Date().toISOString() });
    }, this.deps.heartbeatIntervalMs);
    // Don't keep the event loop alive solely for the heartbeat — tests and
    // short-lived invocations shouldn't block process exit on a pending tick.
    this.heartbeatHandle.unref?.();
  }

  /**
   * After SIGKILL is delivered, the OS is supposed to reap the child
   * immediately — but on macOS/Linux a process blocked in an uninterruptible
   * syscall (D state) or orphaned with a zombie parent can survive long
   * enough to hang our `wait()` indefinitely. That would then hang the
   * scheduler slot it's holding.
   *
   * We bound that worst case: start a short timer when SIGKILL fires, and if
   * the process still hasn't exited when it elapses, finalize with
   * `KILLED_EXIT_CODE` and a reason string. Callers observing that reason
   * can tell the exit was synthesized rather than reported by the OS.
   *
   * Tradeoff we're explicit about: a false "exited" report is strictly
   * preferable to a hung scheduler. The alternative — letting `wait()` sit
   * forever — poisons retries, blocks concurrency slots, and is effectively
   * undetectable without external liveness probes.
   */
  private armPostKillWatchdog(): void {
    if (this.postKillWatchdogHandle) return;
    const ms = this.deps.postKillWatchdogMs ?? POST_KILL_WATCHDOG_MS;
    this.postKillWatchdogHandle = setTimeout(() => {
      if (this.cachedResult || !this.childAlive) return;
      this.finalize(KILLED_EXIT_CODE, "killed but never exited");
    }, ms);
    this.postKillWatchdogHandle.unref?.();
  }

  private armTimeout(): void {
    if (!this.deps.timeoutMs) return;
    this.timeoutHandle = setTimeout(() => {
      if (this.cachedResult || !this.childAlive) return;
      this.timedOut = true;
      this.deps.process.kill("SIGTERM");
      // Escalate if the child is still alive after the grace window. Keeping
      // this as a separate timer (not a busy-wait) means a cooperative child
      // that exits on SIGTERM within the grace avoids the SIGKILL noise.
      this.escalationHandle = setTimeout(() => {
        if (!this.cachedResult && this.childAlive) {
          this.deps.process.kill("SIGKILL");
          // Same stuck-child concern as the explicit kill() path: arm the
          // watchdog so `wait()` can't hang if SIGKILL doesn't produce an
          // exit event.
          this.armPostKillWatchdog();
        }
      }, this.deps.killGraceMs);
      this.escalationHandle.unref?.();
    }, this.deps.timeoutMs);
    this.timeoutHandle.unref?.();
  }

  private finalize(exitCode: number, reason?: string): void {
    if (this.cachedResult) return;
    const summary = buildSummary(this.stdoutBuf, this.stderrBuf, exitCode, reason);
    this.cachedResult = {
      exitCode,
      summary,
      stdout: this.stdoutBuf,
      stderr: this.stderrBuf,
    };

    if (this.timeoutHandle) clearTimeout(this.timeoutHandle);
    if (this.heartbeatHandle) clearInterval(this.heartbeatHandle);
    if (this.escalationHandle) clearTimeout(this.escalationHandle);
    if (this.postKillWatchdogHandle) clearTimeout(this.postKillWatchdogHandle);

    this.bus.emit(
      {
        kind: "exit",
        at: new Date().toISOString(),
        data: String(exitCode),
      },
      true
    );

    // Fire onComplete AFTER the exit event so subscribers see the terminal
    // event before any teardown side effects (sandbox destroy).
    Promise.resolve(this.deps.onComplete(this.cachedResult)).catch((err) => {
      // onComplete failures (sandbox destroy throwing, etc.) must not block
      // a pending wait() — the result is already cached. Log at warn so the
      // operator can see teardown drift without having to crawl the FS.
      // Context fields (runId/ticketId/sandbox id) make drift attributable
      // without grepping a sea of identical messages.
      const message = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.warn(
        `[local-executor] onComplete hook failed ` +
          `(runId=${this.deps.runId} ticketId=${this.deps.ticketId} ` +
          `sandboxId=${this.deps.sandbox.id} handleId=${this.deps.id}): ${message}`
      );
    });
  }
}

function buildSummary(stdout: string, stderr: string, exitCode: number, reason?: string): string {
  if (reason) return reason;
  if (exitCode === 0 && stderr.trim() === "") {
    return stdout.slice(0, SUMMARY_PREFIX_LENGTH);
  }
  return `failed (exit ${exitCode})`;
}

// Minimal signal→number map for the handful we ever raise here. Node's typings
// don't expose a programmatic mapping and we only need a fallback exit code
// when Node hands us `signal` without `code`.
function signalToNumber(signal: NodeJS.Signals): number {
  switch (signal) {
    case "SIGHUP":
      return 1;
    case "SIGINT":
      return 2;
    case "SIGQUIT":
      return 3;
    case "SIGABRT":
      return 6;
    case "SIGKILL":
      return 9;
    case "SIGTERM":
      return 15;
    default:
      return 1;
  }
}

/**
 * Production-grade {@link AgentExecutor} that spawns the agent as a local
 * child process inside an {@link SandboxRef} with `kind: "local"`.
 *
 * Sandbox lifecycle:
 *   The executor creates one sandbox per `start()` call via the injected
 *   {@link SandboxProvider} and destroys it when the handle's `wait()`
 *   resolves — on BOTH success and failure paths via a try/finally in the
 *   teardown hook. Callers that want to manage sandboxes themselves can
 *   omit `sandboxProvider` and pass a pre-built `opts.sandbox`; in that
 *   mode the executor never creates or destroys sandboxes.
 *
 * Streaming:
 *   `handle.stream()` yields `start` → `stdout`/`stderr`/`heartbeat` → `exit`.
 *   Heartbeats fire every `heartbeatIntervalMs` (default 30s) so a future
 *   stuck-agent patroller (T-301) can observe liveness without owning the
 *   event loop.
 */
export class LocalChildProcessExecutor implements AgentExecutor {
  private readonly invoker: CommandInvoker;
  private readonly sandboxProvider: SandboxProvider | undefined;
  private readonly resolveCommand: CommandResolver;
  private readonly heartbeatIntervalMs: number;
  private readonly killGraceMs: number;
  private readonly postKillWatchdogMs: number | undefined;
  private readonly maxHeartbeatCount: number | undefined;
  private counter = 0;

  constructor(options: LocalChildProcessExecutorOptions = {}) {
    this.invoker = options.invoker ?? new NodeCommandInvoker();
    this.sandboxProvider = options.sandboxProvider;
    this.resolveCommand = options.resolveCommand ?? defaultResolveCommand;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS;
    this.killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    this.postKillWatchdogMs = options.postKillWatchdogMs;
    this.maxHeartbeatCount = options.maxHeartbeatCount;

    if (typeof this.invoker.spawn !== "function") {
      throw new Error(
        "LocalChildProcessExecutor requires a CommandInvoker that implements spawn(). " +
          "Use NodeCommandInvoker (default) or inject a streaming-capable fake."
      );
    }
  }

  async start(ticket: TicketDefinition, opts: ExecutorStartOptions): Promise<ExecutionHandle> {
    // Create-per-start sandbox management. We create before validating opts
    // so a mis-typed "remote" ref from the provider path is still caught
    // symmetrically with the caller-supplied path below.
    let sandbox: SandboxRef | undefined;
    let ownsSandbox = false;
    if (this.sandboxProvider) {
      // The provider's base signature is `create(repo, base)`. The
      // git-worktree impl accepts an optional third `{ runId, ticketId }`
      // bag for path readability (`git worktree list` traces back to the
      // owning run). NoopSandboxProvider ignores extra args. We call through
      // a cast rather than patching the interface so providers that don't
      // care about ids stay structurally compatible.
      const provider = this.sandboxProvider as SandboxProvider & {
        create(
          repo: { root: string },
          base: string,
          options?: { runId: string; ticketId: string }
        ): Promise<SandboxRef>;
      };
      sandbox = await provider.create({ root: opts.repoRoot }, "main", {
        runId: opts.runId,
        ticketId: ticket.id,
      });
      ownsSandbox = true;
    } else {
      sandbox = opts.sandbox;
    }

    if (!sandbox) {
      throw new Error(
        "LocalChildProcessExecutor.start requires either an injected sandboxProvider or opts.sandbox."
      );
    }
    const ownedSandbox: SandboxRef = sandbox;

    // Centralize teardown of a provider-created sandbox so every throw path
    // goes through the same code. `ownsSandbox && this.sandboxProvider` gates
    // callers-supplied sandboxes out — we never destroy someone else's ref.
    //
    // Destroy failures must not mask the original throw (we're already on
    // the error path), but we also can't swallow them silently: a leaked
    // worktree or pod is precisely the kind of resource drift operators
    // need to see. Log with full context instead.
    const releaseIfOwned = async () => {
      if (ownsSandbox && this.sandboxProvider) {
        await this.sandboxProvider.destroy(ownedSandbox).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          // eslint-disable-next-line no-console
          console.warn(
            `[local-executor] sandbox destroy failed for ${ownedSandbox.id} ` +
              `(runId=${opts.runId} ticketId=${ticket.id}): ${msg}`
          );
        });
      }
    };

    if (ownedSandbox.workdir.kind !== "local") {
      await releaseIfOwned();
      throw new Error(
        `LocalChildProcessExecutor requires sandbox.workdir.kind === "local"; got "${ownedSandbox.workdir.kind}".`
      );
    }

    const resolved = this.resolveCommand(ticket, { ...opts, sandbox: ownedSandbox });
    if (!resolved) {
      await releaseIfOwned();
      throw new Error(
        `No command resolved for ticket ${ticket.id}; ensure resolveCommand or ticket.allowedCommands produces a command.`
      );
    }

    const invocation: CommandInvocation = {
      command: resolved.command,
      args: resolved.args,
      cwd: ownedSandbox.workdir.path,
      stdin: resolved.stdin,
      env: { ...opts.env, ...resolved.env },
    };

    // Narrowed above by the ctor-time check; `!` here is load-bearing so TS
    // doesn't force every call site to re-prove spawn exists.
    const spawned = this.invoker.spawn!(invocation);

    const providerForCleanup = this.sandboxProvider;
    const id = `${ticket.id}-${Date.now()}-${++this.counter}`;

    const handle = new LocalExecutionHandle({
      id,
      sandbox: ownedSandbox,
      process: spawned,
      timeoutMs: opts.timeoutMs,
      heartbeatIntervalMs: this.heartbeatIntervalMs,
      killGraceMs: this.killGraceMs,
      postKillWatchdogMs: this.postKillWatchdogMs,
      maxHeartbeatCount: this.maxHeartbeatCount,
      runId: opts.runId,
      ticketId: ticket.id,
      onComplete: async () => {
        if (ownsSandbox && providerForCleanup) {
          // Single try/catch path: failure of the destroy surfaces to the
          // warn() in finalize(). The handle is already terminal so nothing
          // waits on the result of this cleanup.
          await providerForCleanup.destroy(ownedSandbox);
        }
      },
    });

    return handle;
  }
}
