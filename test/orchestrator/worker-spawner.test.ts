/**
 * AL-14 — WorkerSpawner unit tests.
 *
 * Covers the spawn mechanics in isolation:
 *  - happy path: worktree created via injected sandbox provider, worker
 *    child spawned with cwd = worktree path, specialty -> agent id map
 *  - two-ticket isolation: distinct worktrees + branches per spawn
 *  - full-access inheritance: channel.fullAccess=true threads
 *    `--dangerously-skip-permissions` into the child argv
 *  - PR URL detection: stdout lines containing a GitHub PR URL populate
 *    `handle.detectedPrUrl` and surface on `onExit`
 *  - failure path: non-zero exit produces `state=failed` with tails
 *  - stop() escalates SIGTERM -> SIGKILL
 *
 * Sandbox provider + command invoker are fully faked — no real git or
 * claude binary is invoked.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  CommandInvocation,
  CommandInvoker,
  CommandResult,
  SpawnedProcess,
} from "../../src/agents/command-invoker.js";
import type { Channel, RepoAssignment } from "../../src/domain/channel.js";
import type { TicketLedgerEntry } from "../../src/domain/ticket.js";
import type {
  DestroyResult,
  RepoRef,
  SandboxProvider,
  SandboxRef,
} from "../../src/execution/sandbox.js";
import { WorkerSpawner, type WorkerExitEvent } from "../../src/orchestrator/worker-spawner.js";

type ExitListener = (code: number | null, signal: NodeJS.Signals | null) => void;
type StdListener = (chunk: string) => void;
type ErrorListener = (err: Error) => void;

interface FakeChild extends SpawnedProcess {
  readonly invocation: CommandInvocation;
  readonly killCalls: Array<NodeJS.Signals | undefined>;
  emitStdout(chunk: string): void;
  emitStderr(chunk: string): void;
  emitExit(code: number | null, signal?: NodeJS.Signals | null): void;
  emitError(err: Error): void;
}

function makeFakeChild(invocation: CommandInvocation): FakeChild {
  const stdoutListeners: StdListener[] = [];
  const stderrListeners: StdListener[] = [];
  const exitListeners: ExitListener[] = [];
  const errorListeners: ErrorListener[] = [];
  const killCalls: Array<NodeJS.Signals | undefined> = [];

  return {
    pid: 30_000 + Math.floor(Math.random() * 1000),
    invocation,
    killCalls,
    onStdout(l) {
      stdoutListeners.push(l);
    },
    onStderr(l) {
      stderrListeners.push(l);
    },
    onExit(l) {
      exitListeners.push(l);
    },
    onError(l) {
      errorListeners.push(l);
    },
    kill(signal) {
      killCalls.push(signal);
      return true;
    },
    emitStdout(chunk) {
      for (const l of stdoutListeners) l(chunk);
    },
    emitStderr(chunk) {
      for (const l of stderrListeners) l(chunk);
    },
    emitExit(code, signal = null) {
      for (const l of exitListeners) l(code, signal);
    },
    emitError(err) {
      for (const l of errorListeners) l(err);
    },
  };
}

class FakeInvoker implements CommandInvoker {
  readonly spawned: FakeChild[] = [];
  async exec(_invocation: CommandInvocation): Promise<CommandResult> {
    // Buffered path is unused by WorkerSpawner; reject to keep tests honest.
    return Promise.reject(new Error("FakeInvoker: buffered path not supported in these tests"));
  }
  spawn(invocation: CommandInvocation): SpawnedProcess {
    const child = makeFakeChild(invocation);
    this.spawned.push(child);
    return child;
  }
  last(): FakeChild {
    const c = this.spawned.at(-1);
    if (!c) throw new Error("no child spawned yet");
    return c;
  }
}

class FakeSandboxProvider implements SandboxProvider {
  readonly created: Array<{ repo: RepoRef; base: string; options?: unknown; ref: SandboxRef }> = [];
  readonly destroyed: SandboxRef[] = [];
  private counter = 0;

  async create(
    repo: RepoRef,
    base: string,
    options?: { runId: string; ticketId: string }
  ): Promise<SandboxRef> {
    this.counter += 1;
    const runId = options?.runId ?? `run-${this.counter}`;
    const ticketId = options?.ticketId ?? `t-${this.counter}`;
    const ref: SandboxRef = {
      id: `sb-${runId}-${ticketId}`,
      workdir: { kind: "local", path: `/tmp/worktree/${runId}/${ticketId}` },
      meta: {
        branch: `sandbox/${runId}/${ticketId}`,
        base,
        runId,
        ticketId,
        repoRoot: repo.root,
      },
    };
    this.created.push({ repo, base, options, ref });
    return ref;
  }

  async destroy(ref: SandboxRef): Promise<DestroyResult> {
    this.destroyed.push(ref);
    return { kind: "removed" };
  }
}

function buildTicket(id: string, overrides: Partial<TicketLedgerEntry> = {}): TicketLedgerEntry {
  return {
    ticketId: id,
    title: `ticket ${id}`,
    specialty: "general",
    status: "ready",
    dependsOn: [],
    assignedAgentId: null,
    assignedAgentName: null,
    crosslinkSessionId: null,
    verification: "pending",
    lastClassification: null,
    chosenNextAction: null,
    attempt: 0,
    startedAt: null,
    completedAt: null,
    updatedAt: "2026-04-21T00:00:00.000Z",
    runId: null,
    ...overrides,
  };
}

function buildChannel(fullAccess = false): Channel {
  return {
    channelId: "ch-test",
    name: "test",
    description: "",
    status: "active",
    workspaceIds: ["ws-backend"],
    members: [],
    pinnedRefs: [],
    repoAssignments: [{ alias: "backend", workspaceId: "ws-backend", repoPath: "/repo/backend" }],
    fullAccess,
    createdAt: "2026-04-21T00:00:00.000Z",
    updatedAt: "2026-04-21T00:00:00.000Z",
  };
}

const BACKEND: RepoAssignment = {
  alias: "backend",
  workspaceId: "ws-backend",
  repoPath: "/repo/backend",
};

describe("WorkerSpawner", () => {
  let provider: FakeSandboxProvider;
  let invoker: FakeInvoker;
  let spawner: WorkerSpawner;
  let clockNow: number;

  beforeEach(() => {
    provider = new FakeSandboxProvider();
    invoker = new FakeInvoker();
    clockNow = 1_700_000_000_000;
    spawner = new WorkerSpawner({
      sandboxProvider: provider,
      invoker,
      clock: () => clockNow++,
      buildSessionId: (() => {
        let i = 0;
        return () => `worker-sess-${++i}`;
      })(),
      stopGraceMs: 5,
    });
  });

  afterEach(() => {
    for (const child of invoker.spawned) {
      child.emitExit(0);
    }
  });

  it("creates a worktree and spawns the worker at that cwd (happy path)", async () => {
    const ticket = buildTicket("t-happy");
    const channel = buildChannel(false);
    const result = await spawner.spawn({ ticket, repoAssignment: BACKEND, channel });

    expect(provider.created).toHaveLength(1);
    expect(provider.created[0].repo).toEqual({ root: "/repo/backend" });
    expect(provider.created[0].base).toBe("main");
    expect((provider.created[0].options as { ticketId: string }).ticketId).toBe("t-happy");

    const workdir = provider.created[0].ref.workdir;
    expect(workdir.kind).toBe("local");
    if (workdir.kind === "local") {
      expect(result.worktreePath).toBe(workdir.path);
    }
    expect(result.handle.ticketId).toBe("t-happy");
    expect(result.handle.sessionId).toBe("worker-sess-1");

    expect(invoker.spawned).toHaveLength(1);
    expect(invoker.last().invocation.cwd).toBe(result.worktreePath);
    expect(invoker.last().invocation.command).toBe("claude");
    expect(invoker.last().invocation.args).toContain("--output-format");
    expect(invoker.last().invocation.args).toContain("stream-json");
    expect(invoker.last().invocation.args).toContain("--verbose");
    expect(invoker.last().invocation.args).not.toContain("--dangerously-skip-permissions");
    expect(invoker.last().invocation.args).toContain("--permission-mode");
  });

  it("produces distinct worktrees + branches for two tickets in the same repo (AC1)", async () => {
    const channel = buildChannel(false);
    const a = await spawner.spawn({ ticket: buildTicket("t-a"), repoAssignment: BACKEND, channel });
    const b = await spawner.spawn({ ticket: buildTicket("t-b"), repoAssignment: BACKEND, channel });

    expect(a.worktreePath).not.toBe(b.worktreePath);
    expect(a.sandboxRef.id).not.toBe(b.sandboxRef.id);
    expect(a.sandboxRef.meta?.branch).not.toBe(b.sandboxRef.meta?.branch);
    expect(a.sandboxRef.meta?.branch).toContain("t-a");
    expect(b.sandboxRef.meta?.branch).toContain("t-b");
  });

  it("inherits channel.fullAccess into the child argv (AC2)", async () => {
    const ticket = buildTicket("t-fa");
    const channel = buildChannel(true);
    await spawner.spawn({ ticket, repoAssignment: BACKEND, channel });
    const args = invoker.last().invocation.args;
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).not.toContain("--permission-mode");
  });

  it("does not pass --dangerously-skip-permissions when channel.fullAccess is false", async () => {
    const ticket = buildTicket("t-no-fa");
    const channel = buildChannel(false);
    await spawner.spawn({ ticket, repoAssignment: BACKEND, channel });
    const args = invoker.last().invocation.args;
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  it("parses structured output into a readable tail, PR URL, usage, model, and cost", async () => {
    const ticket = buildTicket("t-pr");
    const channel = buildChannel(false);
    const { handle } = await spawner.spawn({ ticket, repoAssignment: BACKEND, channel });

    const child = invoker.last();
    const exitP = new Promise<WorkerExitEvent>((resolve) => handle.onExit(resolve));

    child.emitStdout(
      [
        JSON.stringify({ type: "system", subtype: "init", model: "claude-sonnet-4-5" }),
        JSON.stringify({
          type: "assistant",
          message: {
            content: [
              {
                type: "text",
                text: "Opened https://github.com/jcast90/relay/pull/42 for review.",
              },
            ],
          },
        }),
        JSON.stringify({
          type: "result",
          result: "done",
          total_cost_usd: 0.42,
          usage: { input_tokens: 100, output_tokens: 25, cache_read_input_tokens: 50 },
        }),
        "",
      ].join("\n")
    );
    child.emitExit(0);

    const evt = await exitP;
    expect(evt.detectedPrUrl).toBe("https://github.com/jcast90/relay/pull/42");
    expect(evt.exitCode).toBe(0);
    expect(evt.stdoutTail).toBe(
      "Opened https://github.com/jcast90/relay/pull/42 for review.\ndone"
    );
    expect(evt.stdoutTail).not.toContain('\"type\":\"assistant\"');
    expect(evt.tokenUsage).toEqual({
      inputTokens: 150,
      outputTokens: 25,
      cacheReadTokens: 50,
    });
    expect(evt.model).toBe("claude-sonnet-4-5");
    expect(evt.reportedCostUsd).toBe(0.42);
    expect(handle.state).toBe("completed");
    expect(handle.detectedPrUrl).toBe("https://github.com/jcast90/relay/pull/42");
  });

  it("preserves non-JSON diagnostics and malformed structured lines", async () => {
    const { handle } = await spawner.spawn({
      ticket: buildTicket("t-diagnostics"),
      repoAssignment: BACKEND,
      channel: buildChannel(false),
    });
    const child = invoker.last();
    const exitP = new Promise<WorkerExitEvent>((resolve) => handle.onExit(resolve));

    child.emitStdout('starting worker\n{"type":"assistant"\n');
    child.emitExit(2);

    const evt = await exitP;
    expect(evt.stdoutTail).toBe('starting worker\n{"type":"assistant"');
    expect(evt.tokenUsage).toBeUndefined();
    expect(evt.reportedCostUsd).toBeUndefined();
  });

  it("parses a final partial result line before exit", async () => {
    const { handle } = await spawner.spawn({
      ticket: buildTicket("t-partial"),
      repoAssignment: BACKEND,
      channel: buildChannel(false),
    });
    const child = invoker.last();
    const exitP = new Promise<WorkerExitEvent>((resolve) => handle.onExit(resolve));

    child.emitStdout(
      JSON.stringify({
        type: "result",
        total_cost_usd: 0.01,
        usage: { input_tokens: 3, output_tokens: 1 },
      })
    );
    child.emitExit(0);

    const evt = await exitP;
    expect(evt.tokenUsage).toEqual({ inputTokens: 3, outputTokens: 1 });
    expect(evt.reportedCostUsd).toBe(0.01);
  });

  it("does not emit a confident usage reading for an empty usage object", async () => {
    const { handle } = await spawner.spawn({
      ticket: buildTicket("t-empty-usage"),
      repoAssignment: BACKEND,
      channel: buildChannel(false),
    });
    const child = invoker.last();
    const exitP = new Promise<WorkerExitEvent>((resolve) => handle.onExit(resolve));

    child.emitStdout(`${JSON.stringify({ type: "result", usage: {} })}\n`);
    child.emitExit(2);

    expect((await exitP).tokenUsage).toBeUndefined();
  });

  it("retains terminal result text and its PR URL after earlier assistant output", async () => {
    const { handle } = await spawner.spawn({
      ticket: buildTicket("t-terminal-result"),
      repoAssignment: BACKEND,
      channel: buildChannel(false),
    });
    const child = invoker.last();
    const exitP = new Promise<WorkerExitEvent>((resolve) => handle.onExit(resolve));

    child.emitStdout(
      [
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "Still working." }] },
        }),
        JSON.stringify({
          type: "result",
          result: "Opened https://github.com/jcast90/relay/pull/43",
          usage: { input_tokens: 10, output_tokens: 2 },
        }),
        "",
      ].join("\n")
    );
    child.emitExit(0);

    const evt = await exitP;
    expect(evt.stdoutTail).toBe("Still working.\nOpened https://github.com/jcast90/relay/pull/43");
    expect(evt.detectedPrUrl).toBe("https://github.com/jcast90/relay/pull/43");
  });

  it("reports failure + stdout/stderr tail on non-zero exit", async () => {
    const ticket = buildTicket("t-fail");
    const channel = buildChannel(false);
    const { handle } = await spawner.spawn({ ticket, repoAssignment: BACKEND, channel });

    const child = invoker.last();
    const exitP = new Promise<{
      exitCode: number | null;
      stdoutTail: string;
      stderrTail: string;
    }>((resolve) => {
      handle.onExit((e) =>
        resolve({ exitCode: e.exitCode, stdoutTail: e.stdoutTail, stderrTail: e.stderrTail })
      );
    });

    child.emitStdout("working...\nstill working\n");
    child.emitStderr("error: boom\n");
    child.emitExit(2);

    const evt = await exitP;
    expect(evt.exitCode).toBe(2);
    expect(evt.stdoutTail).toContain("still working");
    expect(evt.stderrTail).toContain("error: boom");
    expect(handle.state).toBe("failed");
  });

  it("stop() sends SIGTERM and escalates to SIGKILL after the grace period", async () => {
    const ticket = buildTicket("t-stop");
    const channel = buildChannel(false);
    const { handle } = await spawner.spawn({ ticket, repoAssignment: BACKEND, channel });

    const child = invoker.last();
    const stopP = handle.stop("manual");
    await new Promise((r) => setTimeout(r, 20));
    expect(child.killCalls).toContain("SIGTERM");
    expect(child.killCalls).toContain("SIGKILL");

    child.emitExit(null, "SIGKILL");
    await stopP;
    expect(handle.state).toBe("stopped");
  });

  it("destroyWorktree delegates to the sandbox provider", async () => {
    const ticket = buildTicket("t-destroy");
    const channel = buildChannel(false);
    const { sandboxRef } = await spawner.spawn({
      ticket,
      repoAssignment: BACKEND,
      channel,
    });

    await spawner.destroyWorktree(sandboxRef);
    expect(provider.destroyed).toHaveLength(1);
    expect(provider.destroyed[0].id).toBe(sandboxRef.id);
  });

  it("replays the final exit event on late subscribers (onExit contract)", async () => {
    const ticket = buildTicket("t-late");
    const channel = buildChannel(false);
    const { handle } = await spawner.spawn({ ticket, repoAssignment: BACKEND, channel });

    const child = invoker.last();
    child.emitExit(0);

    await new Promise((r) => setImmediate(r));
    const evt = await new Promise<{ exitCode: number | null }>((resolve) => {
      handle.onExit((e) => resolve({ exitCode: e.exitCode }));
    });
    expect(evt.exitCode).toBe(0);
  });
});
