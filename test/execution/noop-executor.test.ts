import { describe, expect, it } from "vitest";

import type { TicketDefinition } from "../../src/domain/ticket.js";
import type { ExecutionEvent } from "../../src/execution/executor.js";
import {
  NoopExecutor,
  NoopSandboxProvider
} from "../../src/execution/noop-executor.js";
import type { RepoRef } from "../../src/execution/sandbox.js";

const ticket: TicketDefinition = {
  id: "T-noop",
  title: "Noop ticket",
  objective: "Do nothing",
  specialty: "general",
  acceptanceCriteria: ["Does nothing"],
  allowedCommands: [],
  verificationCommands: [],
  docsToUpdate: [],
  dependsOn: [],
  retryPolicy: { maxAgentAttempts: 1, maxTestFixLoops: 1 }
};

const repo: RepoRef = { root: "/tmp/fake-repo" };

async function collectStream(
  stream: AsyncIterable<ExecutionEvent>
): Promise<ExecutionEvent[]> {
  const events: ExecutionEvent[] = [];

  for await (const event of stream) {
    events.push(event);
  }

  return events;
}

describe("NoopSandboxProvider", () => {
  it("round-trips create + resolvePath for a local sandbox", async () => {
    const provider = new NoopSandboxProvider();
    const ref = await provider.create(repo, "main");

    expect(ref.id).toBe("noop-sandbox-1");
    expect(ref.workdir).toBe(repo.root);
    expect(ref.meta?.base).toBe("main");
    expect(provider.resolvePath(ref)).toBe(repo.root);
  });

  it("assigns distinct ids across create calls", async () => {
    const provider = new NoopSandboxProvider();
    const a = await provider.create(repo, "main");
    const b = await provider.create(repo, "main");

    expect(a.id).not.toBe(b.id);
  });

  it("destroy is idempotent", async () => {
    const provider = new NoopSandboxProvider();
    const ref = await provider.create(repo, "main");

    await provider.destroy(ref);
    await expect(provider.destroy(ref)).resolves.toBeUndefined();
    expect(provider.resolvePath(ref)).toBeNull();
  });
});

describe("NoopExecutor", () => {
  it("wait resolves with exitCode 0 and caches the result", async () => {
    const provider = new NoopSandboxProvider();
    const executor = new NoopExecutor();
    const sandbox = await provider.create(repo, "main");
    const handle = await executor.start(ticket, {
      runId: "run-1",
      repoRoot: repo.root,
      sandbox
    });

    const first = await handle.wait();
    const second = await handle.wait();

    expect(first).toEqual({
      exitCode: 0,
      summary: "noop",
      stdout: "",
      stderr: ""
    });
    expect(second).toBe(first);
  });

  it("stream yields start then exit in order", async () => {
    const provider = new NoopSandboxProvider();
    const executor = new NoopExecutor();
    const sandbox = await provider.create(repo, "main");
    const handle = await executor.start(ticket, {
      runId: "run-1",
      repoRoot: repo.root,
      sandbox
    });

    const events = await collectStream(handle.stream());

    expect(events.map((event) => event.kind)).toEqual(["start", "exit"]);
    expect(events[1].data).toBe("0");
  });

  it("kill before wait produces exitCode 137", async () => {
    const provider = new NoopSandboxProvider();
    const executor = new NoopExecutor();
    const sandbox = await provider.create(repo, "main");
    const handle = await executor.start(ticket, {
      runId: "run-1",
      repoRoot: repo.root,
      sandbox
    });

    await handle.kill("SIGKILL");
    const result = await handle.wait();

    expect(result.exitCode).toBe(137);
    expect(result.summary).toBe("killed");
  });

  it("assigns distinct ids to concurrent handles", async () => {
    const provider = new NoopSandboxProvider();
    const executor = new NoopExecutor();
    const sandbox = await provider.create(repo, "main");
    const opts = { runId: "run-1", repoRoot: repo.root, sandbox };

    const a = await executor.start(ticket, opts);
    const b = await executor.start(ticket, opts);

    expect(a.id).not.toBe(b.id);
    expect(a.sandbox.id).toBe(sandbox.id);
  });
});
