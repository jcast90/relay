import type { TicketDefinition } from "../domain/ticket.js";
import type {
  AgentExecutor,
  ExecutionEvent,
  ExecutionHandle,
  ExecutionResult,
  ExecutorStartOptions
} from "./executor.js";
import type { RepoRef, SandboxProvider, SandboxRef } from "./sandbox.js";

export class NoopSandboxProvider implements SandboxProvider {
  private counter = 0;
  private readonly paths = new Map<string, string>();

  async create(repo: RepoRef, base: string): Promise<SandboxRef> {
    const id = `noop-sandbox-${++this.counter}`;
    this.paths.set(id, repo.root);

    return {
      id,
      workdir: repo.root,
      meta: { base }
    };
  }

  async destroy(ref: SandboxRef): Promise<void> {
    // Idempotent: missing entries are a silent no-op so callers can retry
    // destroy without guarding on existence.
    this.paths.delete(ref.id);
  }

  resolvePath(ref: SandboxRef): string | null {
    return this.paths.get(ref.id) ?? null;
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

  async wait(): Promise<ExecutionResult> {
    if (this.cachedResult) {
      return this.cachedResult;
    }

    this.cachedResult = this.killed
      ? { exitCode: 137, summary: "killed", stdout: "", stderr: "" }
      : { exitCode: 0, summary: "noop", stdout: "", stderr: "" };

    return this.cachedResult;
  }

  async kill(_signal?: "SIGTERM" | "SIGKILL"): Promise<void> {
    this.killed = true;
  }

  async *stream(): AsyncIterable<ExecutionEvent> {
    yield { kind: "start", at: new Date().toISOString() };
    const result = await this.wait();
    yield {
      kind: "exit",
      at: new Date().toISOString(),
      data: String(result.exitCode)
    };
  }
}

export class NoopExecutor implements AgentExecutor {
  private counter = 0;

  async start(
    _ticket: TicketDefinition,
    opts: ExecutorStartOptions
  ): Promise<ExecutionHandle> {
    const id = `noop-exec-${++this.counter}`;

    return new NoopExecutionHandle(id, opts.sandbox);
  }
}
