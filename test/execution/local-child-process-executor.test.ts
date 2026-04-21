import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  NodeCommandInvoker,
  type CommandInvoker,
  type SpawnedProcess
} from "../../src/agents/command-invoker.js";
import type { TicketDefinition } from "../../src/domain/ticket.js";
import type { ExecutionEvent } from "../../src/execution/executor.js";
import { LocalChildProcessExecutor } from "../../src/execution/local-child-process-executor.js";
import { NoopSandboxProvider } from "../../src/execution/noop-executor.js";
import type {
  DestroyResult,
  RepoRef,
  SandboxProvider,
  SandboxRef
} from "../../src/execution/sandbox.js";

function makeTicket(partial: Partial<TicketDefinition> = {}): TicketDefinition {
  return {
    id: partial.id ?? "T-local-test",
    title: partial.title ?? "Local test",
    objective: partial.objective ?? "Run something locally",
    specialty: partial.specialty ?? "general",
    acceptanceCriteria: partial.acceptanceCriteria ?? ["Runs"],
    allowedCommands: partial.allowedCommands ?? [],
    verificationCommands: partial.verificationCommands ?? [],
    docsToUpdate: partial.docsToUpdate ?? [],
    dependsOn: partial.dependsOn ?? [],
    retryPolicy: partial.retryPolicy ?? { maxAgentAttempts: 1, maxTestFixLoops: 1 }
  };
}

async function collectStream(
  stream: AsyncIterable<ExecutionEvent>
): Promise<ExecutionEvent[]> {
  const events: ExecutionEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

/**
 * CommandInvoker + SpawnedProcess test double that never touches the real
 * filesystem or spawn() — lets us assert on lifecycle without a real child.
 */
class FakeSpawned {
  private stdoutListener: ((chunk: string) => void) | null = null;
  private stderrListener: ((chunk: string) => void) | null = null;
  private exitListener:
    | ((code: number | null, signal: NodeJS.Signals | null) => void)
    | null = null;
  private errorListener: ((err: Error) => void) | null = null;
  public killed: NodeJS.Signals[] = [];
  private alive = true;

  readonly pid = 4242;

  emitStdout(chunk: string): void {
    this.stdoutListener?.(chunk);
  }
  emitStderr(chunk: string): void {
    this.stderrListener?.(chunk);
  }
  emitExit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.alive = false;
    this.exitListener?.(code, signal);
  }
  emitError(err: Error): void {
    this.errorListener?.(err);
  }

  asSpawnedProcess(): SpawnedProcess {
    return {
      pid: this.pid,
      onStdout: (l) => {
        this.stdoutListener = l;
      },
      onStderr: (l) => {
        this.stderrListener = l;
      },
      onExit: (l) => {
        this.exitListener = l;
      },
      onError: (l) => {
        this.errorListener = l;
      },
      kill: (signal) => {
        const s = (signal ?? "SIGTERM") as NodeJS.Signals;
        this.killed.push(s);
        return this.alive;
      }
    };
  }
}

class FakeInvoker implements CommandInvoker {
  public lastInvocation: Record<string, unknown> | null = null;
  public spawned: FakeSpawned[] = [];

  async exec(): Promise<never> {
    throw new Error("FakeInvoker.exec not supported");
  }

  spawn(invocation: {
    command: string;
    args: string[];
    cwd: string;
  }): SpawnedProcess {
    this.lastInvocation = { ...invocation };
    const fake = new FakeSpawned();
    this.spawned.push(fake);
    return fake.asSpawnedProcess();
  }
}

class CountingSandboxProvider implements SandboxProvider {
  creates = 0;
  destroys = 0;
  lastRef: SandboxRef | null = null;
  failCreate = false;
  constructor(private readonly workdirPath: string) {}

  async create(_repo: RepoRef, base: string): Promise<SandboxRef> {
    if (this.failCreate) {
      throw new Error("create failed");
    }
    this.creates += 1;
    this.lastRef = {
      id: `counting-${this.creates}`,
      workdir: { kind: "local", path: this.workdirPath },
      meta: { base }
    };
    return this.lastRef;
  }

  async destroy(_ref: SandboxRef): Promise<DestroyResult> {
    this.destroys += 1;
    return { kind: "removed" };
  }
}

const REPO: RepoRef = { root: "/tmp/fake-repo" };

describe("LocalChildProcessExecutor - real child processes", () => {
  it("runs an echo hello command via NodeCommandInvoker and reports stdout", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "local-exec-echo-"));
    try {
      const executor = new LocalChildProcessExecutor({
        invoker: new NodeCommandInvoker(),
        resolveCommand: () => ({ command: "echo", args: ["hello"] })
      });
      const provider = new NoopSandboxProvider();
      const sandbox = await provider.create({ root: tmp }, "main");

      const handle = await executor.start(makeTicket(), {
        runId: "run-echo",
        repoRoot: tmp,
        sandbox
      });

      const result = await handle.wait();
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("hello");
      expect(result.summary).toBe(result.stdout.slice(0, 120));
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("defaults to resolving the first allowedCommand when no resolver is given", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "local-exec-default-"));
    try {
      const executor = new LocalChildProcessExecutor({
        invoker: new NodeCommandInvoker()
      });
      const provider = new NoopSandboxProvider();
      const sandbox = await provider.create({ root: tmp }, "main");

      const ticket = makeTicket({ allowedCommands: ["echo default-path"] });
      const handle = await executor.start(ticket, {
        runId: "run-default",
        repoRoot: tmp,
        sandbox
      });

      const result = await handle.wait();
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("default-path");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("LocalChildProcessExecutor - lifecycle and streaming", () => {
  it("stream yields start -> stdout -> exit", async () => {
    const invoker = new FakeInvoker();
    const executor = new LocalChildProcessExecutor({
      invoker,
      resolveCommand: () => ({ command: "noop", args: [] })
    });

    const provider = new NoopSandboxProvider();
    const sandbox = await provider.create(REPO, "main");
    const handle = await executor.start(makeTicket(), {
      runId: "run-stream",
      repoRoot: "/tmp/repo",
      sandbox
    });

    // Drive the fake through its lifecycle on the next tick so stream() has
    // already subscribed before events emit.
    const streamP = collectStream(handle.stream());
    queueMicrotask(() => {
      const fake = invoker.spawned[0];
      fake.emitStdout("chunk-1");
      fake.emitExit(0, null);
    });

    await handle.wait();
    const events = await streamP;
    const kinds = events.map((e) => e.kind);
    expect(kinds[0]).toBe("start");
    expect(kinds).toContain("stdout");
    expect(kinds[kinds.length - 1]).toBe("exit");
    expect(events[events.length - 1].data).toBe("0");
  });

  it("stream called on a completed handle yields synthesized start + exit", async () => {
    const invoker = new FakeInvoker();
    const executor = new LocalChildProcessExecutor({
      invoker,
      resolveCommand: () => ({ command: "noop", args: [] })
    });

    const provider = new NoopSandboxProvider();
    const sandbox = await provider.create(REPO, "main");
    const handle = await executor.start(makeTicket(), {
      runId: "run-stream-2",
      repoRoot: "/tmp/repo",
      sandbox
    });

    invoker.spawned[0].emitExit(0, null);
    await handle.wait();

    const events = await collectStream(handle.stream());
    expect(events.map((e) => e.kind)).toEqual(["start", "exit"]);
  });

  it("kill before wait reports exit 137 and transitions status to killed", async () => {
    const invoker = new FakeInvoker();
    const executor = new LocalChildProcessExecutor({
      invoker,
      resolveCommand: () => ({ command: "noop", args: [] })
    });

    const provider = new NoopSandboxProvider();
    const sandbox = await provider.create(REPO, "main");
    const handle = await executor.start(makeTicket(), {
      runId: "run-kill",
      repoRoot: "/tmp/repo",
      sandbox
    });

    expect(handle.status).toBe("running");

    const waitP = handle.wait();
    await handle.kill("SIGKILL");
    expect(invoker.spawned[0]).toBeDefined();
    // Simulate the OS delivering the signal and the process terminating.
    invoker.spawned[0].emitExit(null, "SIGKILL");

    const result = await waitP;
    expect(result.exitCode).toBe(137);
    expect(result.summary).toBe("killed");
    expect(handle.status).toBe("killed");
  });

  it("kill after wait is a no-op and keeps status exited", async () => {
    const invoker = new FakeInvoker();
    const executor = new LocalChildProcessExecutor({
      invoker,
      resolveCommand: () => ({ command: "noop", args: [] })
    });

    const provider = new NoopSandboxProvider();
    const sandbox = await provider.create(REPO, "main");
    const handle = await executor.start(makeTicket(), {
      runId: "run-kill-after",
      repoRoot: "/tmp/repo",
      sandbox
    });

    invoker.spawned[0].emitExit(0, null);
    const first = await handle.wait();
    expect(first.exitCode).toBe(0);
    expect(handle.status).toBe("exited");

    await expect(handle.kill("SIGTERM")).resolves.toBeUndefined();
    expect(handle.status).toBe("exited");
    const second = await handle.wait();
    expect(second.exitCode).toBe(0);
  });

  it("timeout escalates SIGTERM -> SIGKILL and reports exit 124", async () => {
    const invoker = new FakeInvoker();
    const executor = new LocalChildProcessExecutor({
      invoker,
      resolveCommand: () => ({ command: "sleep", args: ["999"] }),
      killGraceMs: 20
    });

    const provider = new NoopSandboxProvider();
    const sandbox = await provider.create(REPO, "main");
    const handle = await executor.start(makeTicket(), {
      runId: "run-timeout",
      repoRoot: "/tmp/repo",
      sandbox,
      timeoutMs: 30
    });

    // Don't emit exit for SIGTERM - simulate an uncooperative child that only
    // dies on SIGKILL. The executor must escalate.
    await new Promise((resolve) => setTimeout(resolve, 80));
    const fake = invoker.spawned[0];
    expect(fake.killed).toContain("SIGTERM");
    expect(fake.killed).toContain("SIGKILL");

    // The OS would then deliver the KILL and the process exits.
    fake.emitExit(null, "SIGKILL");

    const result = await handle.wait();
    expect(result.exitCode).toBe(124);
    expect(result.summary).toBe("timed out");
  });

  it("rejects a remote sandbox with a clear error", async () => {
    const invoker = new FakeInvoker();
    const executor = new LocalChildProcessExecutor({
      invoker,
      resolveCommand: () => ({ command: "noop", args: [] })
    });

    const remoteSandbox: SandboxRef = {
      id: "remote-1",
      workdir: { kind: "remote", uri: "pod://ns/name:/work" }
    };

    await expect(
      executor.start(makeTicket(), {
        runId: "run-remote",
        repoRoot: "/tmp/repo",
        sandbox: remoteSandbox
      })
    ).rejects.toThrow(/kind === "local"/);
  });

  it("throws when no command can be resolved", async () => {
    const invoker = new FakeInvoker();
    const executor = new LocalChildProcessExecutor({ invoker });

    const provider = new NoopSandboxProvider();
    const sandbox = await provider.create(REPO, "main");

    await expect(
      executor.start(makeTicket({ allowedCommands: [] }), {
        runId: "run-nocmd",
        repoRoot: "/tmp/repo",
        sandbox
      })
    ).rejects.toThrow(/No command resolved/);
  });

  it("rejects an invoker that does not implement spawn at construction time", () => {
    const bareInvoker: CommandInvoker = {
      exec: async () => ({ stdout: "", stderr: "", exitCode: 0 })
    };
    expect(() => new LocalChildProcessExecutor({ invoker: bareInvoker })).toThrow(
      /requires a CommandInvoker that implements spawn/
    );
  });
});

describe("LocalChildProcessExecutor - sandbox lifecycle via injected provider", () => {
  it("creates a sandbox per start() and destroys it on successful wait()", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "local-exec-sb-success-"));
    try {
      const provider = new CountingSandboxProvider(tmp);
      const invoker = new FakeInvoker();
      const executor = new LocalChildProcessExecutor({
        invoker,
        sandboxProvider: provider,
        resolveCommand: () => ({ command: "noop", args: [] })
      });

      const handle = await executor.start(makeTicket(), {
        runId: "run-sb-success",
        repoRoot: tmp
      });

      expect(provider.creates).toBe(1);
      expect(provider.destroys).toBe(0);
      expect(handle.sandbox.id).toBe("counting-1");

      invoker.spawned[0].emitExit(0, null);
      await handle.wait();

      // destroy fires via the onComplete hook AFTER wait() resolves.
      await new Promise((resolve) => setImmediate(resolve));
      expect(provider.destroys).toBe(1);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("destroys the sandbox even when the child fails (non-zero exit)", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "local-exec-sb-fail-"));
    try {
      const provider = new CountingSandboxProvider(tmp);
      const invoker = new FakeInvoker();
      const executor = new LocalChildProcessExecutor({
        invoker,
        sandboxProvider: provider,
        resolveCommand: () => ({ command: "noop", args: [] })
      });

      const handle = await executor.start(makeTicket(), {
        runId: "run-sb-fail",
        repoRoot: tmp
      });

      invoker.spawned[0].emitStderr("oops");
      invoker.spawned[0].emitExit(2, null);
      const result = await handle.wait();
      expect(result.exitCode).toBe(2);

      await new Promise((resolve) => setImmediate(resolve));
      expect(provider.destroys).toBe(1);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("propagates sandbox creation failures instead of returning a fake handle", async () => {
    const provider = new CountingSandboxProvider("/tmp/unused");
    provider.failCreate = true;
    const executor = new LocalChildProcessExecutor({
      invoker: new FakeInvoker(),
      sandboxProvider: provider,
      resolveCommand: () => ({ command: "noop", args: [] })
    });

    await expect(
      executor.start(makeTicket(), {
        runId: "run-sb-create-fail",
        repoRoot: "/tmp/repo"
      })
    ).rejects.toThrow(/create failed/);
  });

  it("releases a provider-created sandbox if the ref turns out to be remote", async () => {
    let destroyed = false;
    const provider: SandboxProvider = {
      async create(): Promise<SandboxRef> {
        return {
          id: "remote-from-provider",
          workdir: { kind: "remote", uri: "pod://x" }
        };
      },
      async destroy(): Promise<DestroyResult> {
        destroyed = true;
        return { kind: "missing" };
      }
    };
    const executor = new LocalChildProcessExecutor({
      invoker: new FakeInvoker(),
      sandboxProvider: provider,
      resolveCommand: () => ({ command: "noop", args: [] })
    });

    await expect(
      executor.start(makeTicket(), {
        runId: "run-remote-prov",
        repoRoot: "/tmp/repo"
      })
    ).rejects.toThrow(/kind === "local"/);
    expect(destroyed).toBe(true);
  });

  it("logs a warning with full context when sandbox destroy fails on a throw path", async () => {
    // The throw path in question: remote-ref rejection during start(). We use
    // a provider whose destroy() rejects, and assert that the failure message
    // reaches console.warn *with* runId, ticketId, and sandbox id — silent
    // catch({}) would leak a sandbox without an operator-visible trace.
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (msg: string) => {
      warnings.push(msg);
    };
    try {
      const provider: SandboxProvider = {
        async create(): Promise<SandboxRef> {
          return {
            id: "sb-destroy-will-fail",
            workdir: { kind: "remote", uri: "pod://y" }
          };
        },
        async destroy(): Promise<DestroyResult> {
          throw new Error("destroy boom");
        }
      };
      const executor = new LocalChildProcessExecutor({
        invoker: new FakeInvoker(),
        sandboxProvider: provider,
        resolveCommand: () => ({ command: "noop", args: [] })
      });

      await expect(
        executor.start(makeTicket({ id: "T-destroy-fail" }), {
          runId: "run-destroy-fail",
          repoRoot: "/tmp/repo"
        })
      ).rejects.toThrow(/kind === "local"/);

      const hit = warnings.find((w) => w.includes("destroy boom"));
      expect(hit).toBeDefined();
      expect(hit).toContain("sb-destroy-will-fail");
      expect(hit).toContain("run-destroy-fail");
      expect(hit).toContain("T-destroy-fail");
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe("LocalChildProcessExecutor - stuck-child and failure-mode escape hatches", () => {
  it("synthesizes an exit if SIGKILL is delivered but the child never exits", async () => {
    // Fake child that accepts signals but never fires onExit — models a
    // process stuck in a D-state / zombie-parent situation. wait() would
    // hang forever without the post-SIGKILL watchdog.
    const invoker = new FakeInvoker();
    const executor = new LocalChildProcessExecutor({
      invoker,
      resolveCommand: () => ({ command: "noop", args: [] }),
      postKillWatchdogMs: 30
    });

    const provider = new NoopSandboxProvider();
    const sandbox = await provider.create(REPO, "main");
    const handle = await executor.start(makeTicket(), {
      runId: "run-stuck",
      repoRoot: "/tmp/repo",
      sandbox
    });

    const waitP = handle.wait();
    await handle.kill("SIGKILL");
    // Do NOT emit exit. The watchdog should finalize within ~30ms.
    const started = Date.now();
    const result = await waitP;
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(1000);
    expect(result.exitCode).toBe(137);
    expect(result.summary).toBe("killed but never exited");
    expect(handle.status).toBe("killed");
  });

  it("maps ENOENT to exit 127 (command not found) and EACCES to exit 126 (permission denied)", async () => {
    for (const [code, expectedExit] of [
      ["ENOENT", 127],
      ["EACCES", 126]
    ] as const) {
      const invoker = new FakeInvoker();
      const executor = new LocalChildProcessExecutor({
        invoker,
        resolveCommand: () => ({ command: "noop", args: [] })
      });

      const provider = new NoopSandboxProvider();
      const sandbox = await provider.create(REPO, "main");
      const handle = await executor.start(makeTicket(), {
        runId: `run-err-${code}`,
        repoRoot: "/tmp/repo",
        sandbox
      });

      const err: NodeJS.ErrnoException = new Error(`spawn ${code}`);
      err.code = code;
      invoker.spawned[0].emitError(err);

      const result = await handle.wait();
      expect(result.exitCode).toBe(expectedExit);
      // The reason surfaces err.code so operators can grep for the underlying
      // POSIX errno, not just a numeric exit.
      expect(result.summary).toContain(code);
    }
  });

  it("caps heartbeat emissions and emits a terminal cap marker", async () => {
    // Short interval + small cap so we can trip the guard in test time.
    const invoker = new FakeInvoker();
    const executor = new LocalChildProcessExecutor({
      invoker,
      resolveCommand: () => ({ command: "noop", args: [] }),
      heartbeatIntervalMs: 5,
      maxHeartbeatCount: 3
    });

    const provider = new NoopSandboxProvider();
    const sandbox = await provider.create(REPO, "main");
    const handle = await executor.start(makeTicket(), {
      runId: "run-hb-cap",
      repoRoot: "/tmp/repo",
      sandbox
    });

    // Collect events in the background. We'll emit exit after the cap trips
    // so the stream can terminate cleanly.
    const collected: ExecutionEvent[] = [];
    const streamIter = handle.stream();
    const collectP = (async () => {
      for await (const ev of streamIter) {
        collected.push(ev);
      }
    })();

    // Wait long enough for heartbeats to trip the cap.
    await new Promise((resolve) => setTimeout(resolve, 80));
    invoker.spawned[0].emitExit(0, null);
    await handle.wait();
    await collectP;

    const heartbeats = collected.filter((e) => e.kind === "heartbeat");
    // Cap is 3 "regular" ticks + 1 terminal cap event = 4.
    expect(heartbeats.length).toBeLessThanOrEqual(4);
    const capMarker = heartbeats.find((e) => e.data === "heartbeat-cap-reached");
    expect(capMarker).toBeDefined();
    // Stream must still terminate (await collectP returned).
    expect(collected[collected.length - 1].kind).toBe("exit");
  });
});
