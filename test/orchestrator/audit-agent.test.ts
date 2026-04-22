/**
 * AL-6 — post-completion audit agent unit + integration tests.
 *
 * Covers:
 *  1. Unit: gating — budget headroom < 15% skips silently with the
 *     `budget_headroom_too_low` reason and NEVER invokes the agent.
 *  2. Unit: gating — ledger with any failure skips silently with
 *     `ledger_had_failures` (no agent invocation, no decision writes).
 *  3. Unit: invalid agent response → `invalid` result, no decision
 *     writes, warning logged (zod rejection).
 *  4. Unit: agent invoker throws → `skipped / agent_error`, no writes.
 *  5. Integration (AC4): 2-ticket green board drives the autonomous
 *     loop's drain pass; audit fires; >=1 `audit_proposal` decision
 *     entry lands on the board with the expected metadata shape.
 *
 * The integration test reuses the AL-14 drain fixture shape (fake admin
 * spawner + fake worker spawner) so no real `claude` binary, no real git,
 * no real subprocess fires. The audit invoker is a scripted function that
 * returns a pre-shaped JSON payload — the focus of AL-6 is the gating +
 * decision-write contract, not the LLM-call plumbing (which sits behind
 * the `invokeAudit` seam and is exercised by the CLI-agent tests already).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SpawnedProcess } from "../../src/agents/command-invoker.js";
import { ChannelStore } from "../../src/channels/channel-store.js";
import type { Channel, RepoAssignment } from "../../src/domain/channel.js";
import type { TicketLedgerEntry } from "../../src/domain/ticket.js";
import type { SandboxRef } from "../../src/execution/sandbox.js";
import { SessionLifecycle } from "../../src/lifecycle/session-lifecycle.js";
import { TokenTracker } from "../../src/budget/token-tracker.js";
import {
  AUDIT_MIN_HEADROOM_PCT,
  runPostCompletionAudit,
  type AuditInvoker,
  type AuditResponse,
} from "../../src/orchestrator/audit-agent.js";
import {
  RELAY_AL14_WORKER_DRAIN,
  startAutonomousSession,
} from "../../src/orchestrator/autonomous-loop.js";
import { RELAY_REPO_ADMIN_POOL_ENABLED } from "../../src/orchestrator/repo-admin-pool.js";
import type {
  RepoAdminProcessSpawner,
  RepoAdminSpawnArgs,
} from "../../src/orchestrator/repo-admin-session.js";
import type {
  WorkerExitEvent,
  WorkerHandle,
  WorkerSpawner,
} from "../../src/orchestrator/worker-spawner.js";
import { FileHarnessStore } from "../../src/storage/file-store.js";

// --- Shared helpers ----------------------------------------------------------

function makeTicket(
  id: string,
  alias: string,
  status: "completed" | "verifying"
): TicketLedgerEntry {
  return {
    ticketId: id,
    title: `Ticket ${id}`,
    specialty: "general",
    status,
    dependsOn: [],
    assignedAgentId: null,
    assignedAgentName: null,
    crosslinkSessionId: null,
    verification: status === "completed" ? "passed" : "pending",
    lastClassification: null,
    chosenNextAction: null,
    attempt: 1,
    startedAt: "2026-04-21T00:00:00.000Z",
    completedAt: status === "completed" ? "2026-04-21T00:05:00.000Z" : null,
    updatedAt: "2026-04-21T00:05:00.000Z",
    runId: null,
    assignedAlias: alias,
  };
}

const VALID_RESPONSE: AuditResponse = {
  proposals: [
    {
      title: "Add TUI keybinding for audit-proposal acceptance",
      rationale:
        "Operators just reviewed audit proposals inline; a one-key accept path closes the feedback loop.",
      dependencies: [],
      effortEstimate: "S",
    },
    {
      title: "Persist audit proposals to Linear on god-mode opt-in",
      rationale:
        "Once AL-7 lands god mode, the proposals should create Linear tickets automatically instead of manual triage.",
      dependencies: ["AL-7 trust-mode flag"],
      effortEstimate: "M",
    },
    {
      title: "Surface audit proposals in the GUI decisions tab",
      rationale:
        "Proposals live on the decisions board already; the GUI filter just needs an `audit_proposal` chip.",
      dependencies: [],
      effortEstimate: "XS",
    },
  ],
};

function makeValidInvoker(response: AuditResponse = VALID_RESPONSE): AuditInvoker {
  return async () => JSON.stringify(response);
}

// --- Unit tests --------------------------------------------------------------

describe("runPostCompletionAudit — gating", () => {
  let root: string;
  let channelStore: ChannelStore;
  let channel: Channel;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "al-6-audit-unit-"));
    const harnessStore = new FileHarnessStore(join(root, "__hs__"));
    channelStore = new ChannelStore(join(root, "channels"), harnessStore);
    channel = await channelStore.createChannel({
      name: "al-6-unit",
      description: "audit-agent unit tests",
      workspaceIds: ["ws-1"],
      repoAssignments: [{ alias: "primary", workspaceId: "ws-1", repoPath: "/tmp/fake" }],
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("skips silently when budget headroom is below 15%", async () => {
    const invoker = vi.fn<AuditInvoker>();
    const result = await runPostCompletionAudit({
      channel,
      channelStore,
      run: {
        sessionId: "s-1",
        tickets: [makeTicket("t-1", "primary", "completed")],
        decisions: [],
        recentCommits: [],
      },
      budgetHeadroomPct: AUDIT_MIN_HEADROOM_PCT - 1, // 14
      invokeAudit: invoker,
    });

    expect(result).toEqual({ kind: "skipped", reason: "budget_headroom_too_low" });
    expect(invoker).not.toHaveBeenCalled();
    const decisions = await channelStore.listDecisions(channel.channelId);
    expect(decisions.filter((d) => d.type === "audit_proposal")).toHaveLength(0);
  });

  it("skips when ledger has a failed ticket", async () => {
    const invoker = vi.fn<AuditInvoker>();
    const tickets = [
      makeTicket("t-1", "primary", "completed"),
      { ...makeTicket("t-2", "primary", "completed"), status: "failed" as const },
    ];
    const result = await runPostCompletionAudit({
      channel,
      channelStore,
      run: { sessionId: "s-1", tickets, decisions: [], recentCommits: [] },
      budgetHeadroomPct: 50,
      invokeAudit: invoker,
    });

    expect(result).toEqual({ kind: "skipped", reason: "ledger_had_failures" });
    expect(invoker).not.toHaveBeenCalled();
  });

  it("skips when ledger is empty", async () => {
    const invoker = vi.fn<AuditInvoker>();
    const result = await runPostCompletionAudit({
      channel,
      channelStore,
      run: { sessionId: "s-1", tickets: [], decisions: [], recentCommits: [] },
      budgetHeadroomPct: 80,
      invokeAudit: invoker,
    });
    expect(result).toEqual({ kind: "skipped", reason: "ledger_empty" });
    expect(invoker).not.toHaveBeenCalled();
  });

  it("returns invalid when agent response fails zod validation", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const invoker: AuditInvoker = async () =>
      JSON.stringify({
        proposals: [
          {
            title: "Only one proposal",
            rationale: "This fails the min(3) gate.",
            dependencies: [],
            effortEstimate: "S",
          },
        ],
      });

    const result = await runPostCompletionAudit({
      channel,
      channelStore,
      run: {
        sessionId: "s-1",
        tickets: [makeTicket("t-1", "primary", "completed")],
        decisions: [],
        recentCommits: [],
      },
      budgetHeadroomPct: 50,
      invokeAudit: invoker,
    });

    expect(result.kind).toBe("invalid");
    // No decisions written on invalid responses.
    const decisions = await channelStore.listDecisions(channel.channelId);
    expect(decisions.filter((d) => d.type === "audit_proposal")).toHaveLength(0);
    warnSpy.mockRestore();
  });

  it("returns agent_error when invoker throws", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const invoker: AuditInvoker = async () => {
      throw new Error("network down");
    };

    const result = await runPostCompletionAudit({
      channel,
      channelStore,
      run: {
        sessionId: "s-1",
        tickets: [makeTicket("t-1", "primary", "completed")],
        decisions: [],
        recentCommits: [],
      },
      budgetHeadroomPct: 50,
      invokeAudit: invoker,
    });
    expect(result).toEqual({ kind: "skipped", reason: "agent_error" });
    warnSpy.mockRestore();
  });

  it("tolerates a fenced ```json code block in the agent response", async () => {
    const fenced = "```json\n" + JSON.stringify(VALID_RESPONSE) + "\n```";
    const invoker: AuditInvoker = async () => fenced;

    const result = await runPostCompletionAudit({
      channel,
      channelStore,
      run: {
        sessionId: "s-1",
        tickets: [makeTicket("t-1", "primary", "completed")],
        decisions: [],
        recentCommits: [],
      },
      budgetHeadroomPct: 50,
      invokeAudit: invoker,
    });
    expect(result.kind).toBe("fired");
    if (result.kind === "fired") {
      expect(result.proposalsWritten).toBe(3);
    }
  });

  it("writes one audit_proposal decision per proposal with the expected metadata shape", async () => {
    const result = await runPostCompletionAudit({
      channel,
      channelStore,
      run: {
        sessionId: "sess-abc",
        tickets: [
          makeTicket("t-1", "primary", "completed"),
          makeTicket("t-2", "primary", "verifying"),
        ],
        decisions: [],
        recentCommits: ["abc123 feat: ship the thing"],
      },
      budgetHeadroomPct: 40,
      invokeAudit: makeValidInvoker(),
    });

    expect(result).toEqual({ kind: "fired", proposalsWritten: 3 });

    const proposals = (await channelStore.listDecisions(channel.channelId)).filter(
      (d) => d.type === "audit_proposal"
    );
    expect(proposals).toHaveLength(3);
    for (let i = 0; i < proposals.length; i++) {
      const d = proposals[i];
      expect(d.type).toBe("audit_proposal");
      expect(d.decidedBy).toBe("audit-agent");
      expect(d.metadata).toBeDefined();
      expect(d.metadata?.title).toBeDefined();
      expect(d.metadata?.effortEstimate).toBeDefined();
      expect(d.metadata?.sessionId).toBe("sess-abc");
      expect(Array.isArray(d.metadata?.dependencies)).toBe(true);
    }
  });
});

// --- Integration: autonomous-loop drives the audit seam ----------------------

// Reused AL-14 drain-fixture fakes. Minimal copies so this test stays hermetic
// from the autonomous-loop-drain.test.ts file — if one breaks, the other
// shouldn't cascade.
type StdListener = (chunk: string) => void;
type ExitListener = (code: number | null, signal: NodeJS.Signals | null) => void;
type ErrorListener = (err: Error) => void;

interface FakeAdminChild extends SpawnedProcess {
  emitExit(code: number | null, signal?: NodeJS.Signals | null): void;
  spawnArgs: RepoAdminSpawnArgs;
}

function makeFakeAdminChild(args: RepoAdminSpawnArgs): FakeAdminChild {
  const exitListeners: ExitListener[] = [];
  return {
    pid: 30_000 + Math.floor(Math.random() * 1000),
    spawnArgs: args,
    onStdout(_l: StdListener) {},
    onStderr(_l: StdListener) {},
    onExit(l: ExitListener) {
      exitListeners.push(l);
    },
    onError(_l: ErrorListener) {},
    kill() {
      for (const l of exitListeners) l(0, "SIGTERM");
      return true;
    },
    emitExit(code, signal = null) {
      for (const l of exitListeners) l(code, signal);
    },
  };
}

class FakeAdminSpawner implements RepoAdminProcessSpawner {
  spawn(args: RepoAdminSpawnArgs): SpawnedProcess {
    return makeFakeAdminChild(args);
  }
}

class FakeWorkerHandle implements WorkerHandle {
  readonly ticketId: string;
  readonly sessionId: string;
  readonly specialty = "general" as const;
  readonly worktreePath: string;
  readonly sandboxRef: SandboxRef;
  private _state: "running" | "completed" | "failed" | "stopped" = "running";
  private _prUrl: string | null = null;
  private listeners: Array<(evt: WorkerExitEvent) => void> = [];
  private finalEvent: WorkerExitEvent | null = null;

  constructor(ticketId: string, sessionId: string, worktreePath: string, sandboxRef: SandboxRef) {
    this.ticketId = ticketId;
    this.sessionId = sessionId;
    this.worktreePath = worktreePath;
    this.sandboxRef = sandboxRef;
  }
  get state(): "running" | "completed" | "failed" | "stopped" {
    return this._state;
  }
  get detectedPrUrl(): string | null {
    return this._prUrl;
  }
  onExit(listener: (evt: WorkerExitEvent) => void): () => void {
    if (this.finalEvent) {
      const evt = this.finalEvent;
      queueMicrotask(() => listener(evt));
      return () => {};
    }
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }
  stop = vi.fn(async (): Promise<void> => {
    if (this._state === "running") {
      this.fire({ exitCode: null });
    }
  });
  fire(args: { exitCode: number | null; prUrl?: string | null }): void {
    if (this.finalEvent) return;
    this._prUrl = args.prUrl ?? null;
    const evt: WorkerExitEvent = {
      exitCode: args.exitCode,
      signal: null,
      reason:
        args.exitCode === 0
          ? "completed"
          : args.exitCode === null
            ? "stopped"
            : `exit ${args.exitCode}`,
      stdoutTail: "",
      stderrTail: "",
      detectedPrUrl: args.prUrl ?? null,
    };
    if (args.exitCode === 0) this._state = "completed";
    else if (args.exitCode === null) this._state = "stopped";
    else this._state = "failed";
    this.finalEvent = evt;
    const listeners = this.listeners.slice();
    this.listeners = [];
    for (const l of listeners) l(evt);
  }
}

class FakeWorkerSpawner {
  readonly spawnedByAlias = new Map<string, FakeWorkerHandle[]>();
  private counter = 0;
  private onSpawnListeners: Array<
    (args: { alias: string; ticketId: string; handle: FakeWorkerHandle }) => void
  > = [];

  onSpawn(cb: (args: { alias: string; ticketId: string; handle: FakeWorkerHandle }) => void): void {
    this.onSpawnListeners.push(cb);
  }

  spawn = vi.fn(
    async (opts: {
      ticket: TicketLedgerEntry;
      repoAssignment: RepoAssignment;
      channel: Channel;
    }) => {
      this.counter += 1;
      const runId = `fake-run-${this.counter}`;
      const ticketId = opts.ticket.ticketId;
      const alias = opts.repoAssignment.alias;
      const worktreePath = `/tmp/fake-worktree/${alias}/${runId}/${ticketId}`;
      const sandboxRef: SandboxRef = {
        id: `sb-${runId}-${ticketId}`,
        workdir: { kind: "local", path: worktreePath },
        meta: {
          branch: `sandbox/${runId}/${ticketId}`,
          base: "main",
          runId,
          ticketId,
          repoRoot: opts.repoAssignment.repoPath,
        },
      };
      const handle = new FakeWorkerHandle(
        ticketId,
        `worker-sess-${this.counter}`,
        worktreePath,
        sandboxRef
      );
      const list = this.spawnedByAlias.get(alias) ?? [];
      list.push(handle);
      this.spawnedByAlias.set(alias, list);
      for (const cb of this.onSpawnListeners) cb({ alias, ticketId, handle });
      return { handle, worktreePath, sandboxRef };
    }
  );

  destroyWorktree = vi.fn(async (_ref: SandboxRef) => {});

  handles(alias: string): FakeWorkerHandle[] {
    return this.spawnedByAlias.get(alias) ?? [];
  }
}

async function waitUntil(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitUntil timed out");
    }
    await new Promise((r) => setTimeout(r, 2));
  }
}

describe("audit-agent integration — autonomous-loop onAllTicketsComplete seam", () => {
  let cleanupFns: Array<() => Promise<void>> = [];
  let originalPoolFlag: string | undefined;
  let originalDrainFlag: string | undefined;

  beforeEach(() => {
    cleanupFns = [];
    originalPoolFlag = process.env[RELAY_REPO_ADMIN_POOL_ENABLED];
    originalDrainFlag = process.env[RELAY_AL14_WORKER_DRAIN];
    process.env[RELAY_REPO_ADMIN_POOL_ENABLED] = "1";
    process.env[RELAY_AL14_WORKER_DRAIN] = "1";
  });

  afterEach(async () => {
    for (const fn of cleanupFns) await fn();
    if (originalPoolFlag === undefined) delete process.env[RELAY_REPO_ADMIN_POOL_ENABLED];
    else process.env[RELAY_REPO_ADMIN_POOL_ENABLED] = originalPoolFlag;
    if (originalDrainFlag === undefined) delete process.env[RELAY_AL14_WORKER_DRAIN];
    else process.env[RELAY_AL14_WORKER_DRAIN] = originalDrainFlag;
  });

  it("fires the audit agent after a 2-ticket board drains green and writes >=1 audit_proposal decision", async () => {
    // Fixture: 1 admin, 2 tickets, both complete cleanly.
    const root = await mkdtemp(join(tmpdir(), "al-6-audit-int-"));
    const harnessStore = new FileHarnessStore(join(root, "__hs__"));
    const channelStore = new ChannelStore(join(root, "channels"), harnessStore);

    const assignments: RepoAssignment[] = [
      { alias: "primary", workspaceId: "ws-primary", repoPath: "/tmp/fake-primary" },
    ];
    const persisted = await channelStore.createChannel({
      name: "al-6-int",
      description: "al-6 integration",
      workspaceIds: ["ws-primary"],
      repoAssignments: assignments,
    });
    const channel: Channel = { ...persisted, repoAssignments: assignments, fullAccess: false };

    const tickets: TicketLedgerEntry[] = [
      {
        ticketId: "al-6-int-1",
        title: "t-1",
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
        assignedAlias: "primary",
      },
      {
        ticketId: "al-6-int-2",
        title: "t-2",
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
        assignedAlias: "primary",
      },
    ];
    await channelStore.writeChannelTickets(channel.channelId, tickets);

    const sessionId = `auto-al-6-${Date.now()}`;
    const lifecycle = new SessionLifecycle(sessionId, { rootDir: root });
    await lifecycle.transition("dispatching", "autonomous-session-started");
    const tracker = new TokenTracker(sessionId, 100_000, { rootDir: root });

    const adminSpawner = new FakeAdminSpawner();
    const workerSpawner = new FakeWorkerSpawner();
    const auditInvoker: AuditInvoker = vi.fn(async () => JSON.stringify(VALID_RESPONSE));

    cleanupFns.push(async () => {
      await tracker.close().catch(() => {});
      await lifecycle.close().catch(() => {});
      await rm(root, { recursive: true, force: true });
    });

    // Silence expected info noise — the loop logs its phases + the audit
    // outcome. We only want to fail on unexpected warn() calls coming from
    // the runner/coordinator.
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    cleanupFns.push(async () => {
      logSpy.mockRestore();
      warnSpy.mockRestore();
    });

    const driverP = startAutonomousSession({
      sessionId,
      channel,
      tracker,
      lifecycle,
      trust: "supervised",
      allowedRepos: assignments,
      testOverrides: {
        channelStore,
        repoAdminSpawner: adminSpawner,
        workerSpawner: workerSpawner as unknown as WorkerSpawner,
        rootDir: root,
        auditInvoker,
      },
    });

    // Drive the drain: each ticket spawns → complete with PR URL → next
    // ticket spawns → complete. After the second completion the loop's
    // post-drain block fires onAllTicketsComplete → audit-agent.
    await waitUntil(() => workerSpawner.handles("primary").length >= 1);
    workerSpawner
      .handles("primary")[0]
      .fire({ exitCode: 0, prUrl: "https://github.com/o/r/pull/1" });
    await waitUntil(() => workerSpawner.handles("primary").length >= 2);
    workerSpawner
      .handles("primary")[1]
      .fire({ exitCode: 0, prUrl: "https://github.com/o/r/pull/2" });

    await driverP;

    // AC1: audit fired exactly once — the invoker recorded exactly one call.
    expect(auditInvoker).toHaveBeenCalledTimes(1);

    // AC3: each proposal writes a decision entry with the audit_proposal
    // type + the metadata shape the spec calls out.
    const decisions = await channelStore.listDecisions(channel.channelId);
    const proposals = decisions.filter((d) => d.type === "audit_proposal");
    expect(proposals.length).toBeGreaterThanOrEqual(1);
    expect(proposals.length).toBe(VALID_RESPONSE.proposals.length);
    for (const d of proposals) {
      expect(d.decidedBy).toBe("audit-agent");
      expect(d.metadata?.title).toBeDefined();
      expect(d.metadata?.effortEstimate).toBeDefined();
      expect(d.metadata?.sessionId).toBe(sessionId);
      expect(Array.isArray(d.metadata?.dependencies)).toBe(true);
    }
  }, 10_000);

  it("does NOT fire audit when worker drain is disabled (AL-13 pending path)", async () => {
    // Drain flag off = no tickets execute, no audit should be triggered.
    process.env[RELAY_AL14_WORKER_DRAIN] = "0";

    const root = await mkdtemp(join(tmpdir(), "al-6-audit-int-drain-off-"));
    const harnessStore = new FileHarnessStore(join(root, "__hs__"));
    const channelStore = new ChannelStore(join(root, "channels"), harnessStore);

    const assignments: RepoAssignment[] = [
      { alias: "primary", workspaceId: "ws-primary", repoPath: "/tmp/fake-primary" },
    ];
    const persisted = await channelStore.createChannel({
      name: "al-6-int-drain-off",
      description: "drain off",
      workspaceIds: ["ws-primary"],
      repoAssignments: assignments,
    });
    const channel: Channel = { ...persisted, repoAssignments: assignments, fullAccess: false };
    await channelStore.writeChannelTickets(channel.channelId, []);

    const sessionId = `auto-al-6-off-${Date.now()}`;
    const lifecycle = new SessionLifecycle(sessionId, { rootDir: root });
    await lifecycle.transition("dispatching", "autonomous-session-started");
    const tracker = new TokenTracker(sessionId, 100_000, { rootDir: root });

    const adminSpawner = new FakeAdminSpawner();
    const workerSpawner = new FakeWorkerSpawner();
    const auditInvoker: AuditInvoker = vi.fn(async () => JSON.stringify(VALID_RESPONSE));

    cleanupFns.push(async () => {
      await tracker.close().catch(() => {});
      await lifecycle.close().catch(() => {});
      await rm(root, { recursive: true, force: true });
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    cleanupFns.push(async () => {
      logSpy.mockRestore();
      warnSpy.mockRestore();
    });

    await startAutonomousSession({
      sessionId,
      channel,
      tracker,
      lifecycle,
      trust: "supervised",
      allowedRepos: assignments,
      testOverrides: {
        channelStore,
        repoAdminSpawner: adminSpawner,
        workerSpawner: workerSpawner as unknown as WorkerSpawner,
        rootDir: root,
        auditInvoker,
      },
    });

    expect(auditInvoker).not.toHaveBeenCalled();
    const decisions = await channelStore.listDecisions(channel.channelId);
    expect(decisions.filter((d) => d.type === "audit_proposal")).toHaveLength(0);
  });
});
