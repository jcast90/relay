import type { TicketDefinition } from "../domain/ticket.js";
import type {
  AgentExecutor,
  ExecutionEvent,
  ExecutionHandle,
  ExecutionResult,
  ExecutionStatus,
  ExecutorStartOptions,
} from "./executor.js";
import type { DestroyResult, RepoRef, SandboxProvider, SandboxRef } from "./sandbox.js";
import { resolveLocalPath } from "./sandbox.js";

export class NoopSandboxProvider implements SandboxProvider {
  private counter = 0;
  private readonly refs = new Set<string>();

  async create(repo: RepoRef, base: string): Promise<SandboxRef> {
    const id = `noop-sandbox-${++this.counter}`;
    this.refs.add(id);

    return {
      id,
      workdir: { kind: "local", path: repo.root },
      meta: { base },
    };
  }

  async destroy(ref: SandboxRef): Promise<DestroyResult> {
    // Idempotent: `Set#delete` already reports whether the id was present;
    // surface that as the discriminated result so callers (and tests) can
    // tell a real removal from a no-op retry.
    const hadRef = this.refs.delete(ref.id);
    return hadRef ? { kind: "removed" } : { kind: "missing" };
  }
}

class NoopExecutionHandle implements ExecutionHandle {
  readonly id: string;
  readonly sandbox: SandboxRef;

  private killed = false;
  private cachedResult: ExecutionResult | null = null;

  constructor(id: string, sandbox: SandboxRef) {
    this.id = id;
    this.sandbox = sandbox;
  }

  get status(): ExecutionStatus {
    if (this.cachedResult) {
      // wait() resolved normally; if kill() fires afterward it's a no-op and
      // we stay `exited` per the documented contract on ExecutionHandle.kill.
      return this.killed && this.cachedResult.exitCode === 137 ? "killed" : "exited";
    }

    return this.killed ? "killed" : "running";
  }

  async wait(): Promise<ExecutionResult> {
    if (this.cachedResult) {
      return this.cachedResult;
    }

    this.cachedResult = this.killed
      ? // 128 + SIGKILL(9); standard Unix convention for a killed process.
        { exitCode: 137, summary: "killed", stdout: "", stderr: "" }
      : { exitCode: 0, summary: "noop", stdout: "", stderr: "" };

    return this.cachedResult;
  }

  async kill(_signal?: "SIGTERM" | "SIGKILL"): Promise<void> {
    // Idempotent. If wait() has already resolved the exit code is cached and
    // this is a deliberate no-op — the handle's observable status remains
    // `exited`. Double-kill is likewise safe: the flag is already set.
    this.killed = true;
  }

  async *stream(): AsyncIterable<ExecutionEvent> {
    // Noop handles have no live producer, so stream() just synthesizes a
    // terminal start+exit pair from cached state — matching the documented
    // "synthesized from cached state" clause on ExecutionHandle.stream().
    yield { kind: "start", at: new Date().toISOString() };
    const result = await this.wait();
    yield {
      kind: "exit",
      at: new Date().toISOString(),
      data: String(result.exitCode),
    };
  }
}

/**
 * Test double implementing {@link AgentExecutor}. Produces a synthetic
 * success run with no side effects — use for scheduler unit tests and
 * smoke tests that do not need real process spawning. Not a reference
 * implementation; see T-202 (LocalChildProcessExecutor) for the
 * production impl.
 */
export class NoopExecutor implements AgentExecutor {
  private counter = 0;

  async start(_ticket: TicketDefinition, opts: ExecutorStartOptions): Promise<ExecutionHandle> {
    const id = `noop-exec-${++this.counter}`;
    // `sandbox` is optional on ExecutorStartOptions so executors that manage
    // their own lifecycle can skip it. NoopExecutor does not create sandboxes;
    // surface a clear error rather than synthesize a placeholder ref.
    if (!opts.sandbox) {
      throw new Error(
        "NoopExecutor requires opts.sandbox — pass one from NoopSandboxProvider or similar."
      );
    }

    return new NoopExecutionHandle(id, opts.sandbox);
  }
}

// Re-export the free helper so consumers importing from noop-executor for
// tests don't need a separate sandbox.js import path.
export { resolveLocalPath };
