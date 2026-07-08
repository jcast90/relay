import { describe, expect, it } from "vitest";

import { type CommandInvoker, type SpawnedProcess } from "../../src/agents/command-invoker.js";
import type { TicketDefinition } from "../../src/domain/ticket.js";
import { LocalChildProcessExecutor } from "../../src/execution/local-child-process-executor.js";
import { NoopSandboxProvider } from "../../src/execution/noop-executor.js";

function makeTicket(): TicketDefinition {
  return {
    id: "T-usage",
    title: "usage",
    objective: "emit usage",
    specialty: "general",
    acceptanceCriteria: ["ok"],
    allowedCommands: [],
    verificationCommands: [],
    docsToUpdate: [],
    dependsOn: [],
    retryPolicy: { maxAgentAttempts: 1, maxTestFixLoops: 1 },
  };
}

/** Minimal spawn double that lets the test push stdout then exit. */
class FakeSpawned {
  private stdout: ((c: string) => void) | null = null;
  private exit: ((code: number | null, signal: NodeJS.Signals | null) => void) | null = null;
  emitStdout(c: string): void {
    this.stdout?.(c);
  }
  emitExit(code: number): void {
    this.exit?.(code, null);
  }
  asProcess(): SpawnedProcess {
    return {
      pid: 1,
      onStdout: (l) => {
        this.stdout = l;
      },
      onStderr: () => {},
      onExit: (l) => {
        this.exit = l;
      },
      onError: () => {},
      kill: () => false,
    };
  }
}

class FakeInvoker implements CommandInvoker {
  spawned: FakeSpawned[] = [];
  async exec(): Promise<never> {
    throw new Error("not used");
  }
  spawn(): SpawnedProcess {
    const f = new FakeSpawned();
    this.spawned.push(f);
    return f.asProcess();
  }
}

describe("LocalChildProcessExecutor token usage", () => {
  it("attaches tokenUsage parsed from stream-json stdout", async () => {
    const invoker = new FakeInvoker();
    const executor = new LocalChildProcessExecutor({
      invoker,
      resolveCommand: () => ({ command: "claude", args: ["--output-format", "stream-json"] }),
    });
    const provider = new NoopSandboxProvider();
    const sandbox = await provider.create({ root: "/tmp/fake" }, "main");

    const handle = await executor.start(makeTicket(), {
      runId: "run-usage",
      repoRoot: "/tmp/fake",
      sandbox,
    });

    const fake = invoker.spawned[0]!;
    fake.emitStdout(
      JSON.stringify({
        type: "result",
        result: "done",
        usage: { input_tokens: 500, output_tokens: 120 },
      }) + "\n"
    );
    fake.emitExit(0);

    const result = await handle.wait();
    expect(result.tokenUsage).toEqual({ inputTokens: 500, outputTokens: 120 });
  });

  it("leaves tokenUsage undefined for a raw command with no usage block", async () => {
    const invoker = new FakeInvoker();
    const executor = new LocalChildProcessExecutor({
      invoker,
      resolveCommand: () => ({ command: "echo", args: ["hi"] }),
    });
    const provider = new NoopSandboxProvider();
    const sandbox = await provider.create({ root: "/tmp/fake" }, "main");

    const handle = await executor.start(makeTicket(), {
      runId: "run-raw",
      repoRoot: "/tmp/fake",
      sandbox,
    });

    const fake = invoker.spawned[0]!;
    fake.emitStdout("hello there\n");
    fake.emitExit(0);

    const result = await handle.wait();
    expect(result.tokenUsage).toBeUndefined();
  });
});
