import { describe, expect, it } from "vitest";

import type { TicketDefinition } from "../../src/domain/ticket.js";
import type { ExecutionEvent } from "../../src/execution/executor.js";
import {
  NoopExecutor,
  NoopSandboxProvider
} from "../../src/execution/noop-executor.js";
import type { RepoRef } from "../../src/execution/sandbox.js";
import { resolveLocalPath } from "../../src/execution/sandbox.js";

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
  it("round-trips create + resolveLocalPath for a local sandbox", async () => {
    const provider = new NoopSandboxProvider();
    const ref = await provider.create(repo, "main");

    expect(ref.id).toBe("noop-sandbox-1");
    expect(ref.workdir.kind).toBe("local");
    // Narrow manually so the kind-specific field is reachable in the assertion.
    if (ref.workdir.kind !== "local") {
      throw new Error("expected a local workdir");
    }
    expect(ref.workdir.path).toBe(repo.root);
    expect(ref.meta?.base).toBe("main");
    expect(resolveLocalPath(ref)).toBe(repo.root);
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
    // resolveLocalPath is a pure function of the ref — it stays valid even
    // after destroy. The destroyed-ness lives in the provider's own state;
    // that's intentional for the free-function design.
    expect(resolveLocalPath(ref)).toBe(repo.root);
  });

  it("resolveLocalPath returns null for a remote workdir ref", () => {
    const ref = {
      id: "remote-1",
      workdir: { kind: "remote" as const, uri: "pod://ns/name:/work" }
    };

    expect(resolveLocalPath(ref)).toBeNull();
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

  it("wait() then kill() is safe and does not change status", async () => {
    const provider = new NoopSandboxProvider();
    const executor = new NoopExecutor();
    const sandbox = await provider.create(repo, "main");
    const handle = await executor.start(ticket, {
      runId: "run-1",
      repoRoot: repo.root,
      sandbox
    });

    const result = await handle.wait();
    expect(result.exitCode).toBe(0);

    await expect(handle.kill("SIGTERM")).resolves.toBeUndefined();
    // kill-after-wait is a no-op: exit code stays cached and status stays
    // `exited`, per the documented ExecutionHandle.kill contract.
    expect(handle.status).toBe("exited");
    expect((await handle.wait()).exitCode).toBe(0);
  });

  it("status transitions correctly: running -> exited", async () => {
    const provider = new NoopSandboxProvider();
    const executor = new NoopExecutor();
    const sandbox = await provider.create(repo, "main");
    const handle = await executor.start(ticket, {
      runId: "run-1",
      repoRoot: repo.root,
      sandbox
    });

    expect(handle.status).toBe("running");
    await handle.wait();
    expect(handle.status).toBe("exited");
  });

  it("status transitions correctly: running -> killed (kill before wait)", async () => {
    const provider = new NoopSandboxProvider();
    const executor = new NoopExecutor();
    const sandbox = await provider.create(repo, "main");
    const handle = await executor.start(ticket, {
      runId: "run-1",
      repoRoot: repo.root,
      sandbox
    });

    expect(handle.status).toBe("running");
    await handle.kill("SIGKILL");
    expect(handle.status).toBe("killed");
    await handle.wait();
    expect(handle.status).toBe("killed");
  });

  it("stream() called twice returns independent iterators with the same sequence", async () => {
    const provider = new NoopSandboxProvider();
    const executor = new NoopExecutor();
    const sandbox = await provider.create(repo, "main");
    const handle = await executor.start(ticket, {
      runId: "run-1",
      repoRoot: repo.root,
      sandbox
    });

    // Drive the handle to completion first so both stream() calls operate on
    // cached state — the documented "synthesized from cached state" path.
    await handle.wait();

    const firstIter = handle.stream()[Symbol.asyncIterator]();
    const secondIter = handle.stream()[Symbol.asyncIterator]();

    // Each iterator is independent — reading from one does not drain the other.
    const firstEvents: ExecutionEvent[] = [];
    const secondEvents: ExecutionEvent[] = [];

    for (let i = 0; i < 2; i += 1) {
      const a = await firstIter.next();
      if (!a.done) {
        firstEvents.push(a.value);
      }

      const b = await secondIter.next();
      if (!b.done) {
        secondEvents.push(b.value);
      }
    }

    // Drain terminators so the generators release their resources cleanly.
    await firstIter.next();
    await secondIter.next();

    expect(firstEvents.map((e) => e.kind)).toEqual(["start", "exit"]);
    expect(secondEvents.map((e) => e.kind)).toEqual(["start", "exit"]);
    expect(firstEvents[1].data).toBe("0");
    expect(secondEvents[1].data).toBe("0");
  });
});
