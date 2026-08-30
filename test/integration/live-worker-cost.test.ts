import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { NodeCommandInvoker, type SpawnedProcess } from "../../src/agents/command-invoker.js";
import { TaskCostLedger } from "../../src/budget/task-cost-ledger.js";
import { ChannelStore } from "../../src/channels/channel-store.js";
import { handleCostCommand } from "../../src/cli/cost.js";
import { handleRunAutonomous } from "../../src/cli/run-autonomous.js";
import type { Channel, RepoAssignment } from "../../src/domain/channel.js";
import type { TicketLedgerEntry } from "../../src/domain/ticket.js";
import type { SandboxProvider, SandboxRef } from "../../src/execution/sandbox.js";
import {
  RELAY_AL14_WORKER_DRAIN,
  startAutonomousSession,
} from "../../src/orchestrator/autonomous-loop.js";
import { RELAY_REPO_ADMIN_POOL_ENABLED } from "../../src/orchestrator/repo-admin-pool.js";
import type { RepoAdminProcessSpawner } from "../../src/orchestrator/repo-admin-session.js";
import { WorkerSpawner } from "../../src/orchestrator/worker-spawner.js";
import { FileHarnessStore } from "../../src/storage/file-store.js";

class Sink {
  data = "";
  write(chunk: string): boolean {
    this.data += chunk;
    return true;
  }
}

class FakeAdminSpawner implements RepoAdminProcessSpawner {
  spawn(): SpawnedProcess {
    const exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
    let exited = false;
    return {
      pid: 41_001,
      onStdout() {},
      onStderr() {},
      onExit(listener) {
        exitListeners.push(listener);
      },
      onError() {},
      kill() {
        if (!exited) {
          exited = true;
          for (const listener of exitListeners) listener(0, "SIGTERM");
        }
        return true;
      },
    };
  }
}

class LocalSandboxProvider implements SandboxProvider {
  async create(repo: { root: string }, base: string): Promise<SandboxRef> {
    return {
      id: "live-worker-cost",
      workdir: { kind: "local", path: repo.root },
      meta: { branch: "live-worker-cost", base },
    };
  }

  async destroy() {
    return { kind: "missing" } as const;
  }
}

const liveDescribe = process.env.HARNESS_LIVE === "1" ? describe : describe.skip;

liveDescribe("live Claude worker cost capture", () => {
  it("records a real worker result and renders it through rly cost", async () => {
    expect(process.env.HARNESS_LIVE).toBe("1");
    const base = await mkdtemp(join(tmpdir(), "relay-live-worker-cost-"));
    const root = join(base, "home", ".relay");
    const originalHome = process.env.HOME;
    const originalPoolFlag = process.env[RELAY_REPO_ADMIN_POOL_ENABLED];
    const originalDrainFlag = process.env[RELAY_AL14_WORKER_DRAIN];
    try {
      process.env[RELAY_REPO_ADMIN_POOL_ENABLED] = "1";
      process.env[RELAY_AL14_WORKER_DRAIN] = "1";
      const repoAssignment: RepoAssignment = {
        alias: "relay",
        workspaceId: "live-worker-cost",
        repoPath: base,
      };
      const channelStore = new ChannelStore(
        join(root, "channels"),
        new FileHarnessStore(join(root, "store"))
      );
      const persisted = await channelStore.createChannel({
        name: "live-worker-cost",
        description: "opt-in worker accounting check",
        workspaceIds: [repoAssignment.workspaceId],
        repoAssignments: [repoAssignment],
      });
      const channel: Channel = {
        ...persisted,
        repoAssignments: [repoAssignment],
        fullAccess: false,
      };
      const ticket: TicketLedgerEntry = {
        ticketId: "live-worker-cost",
        title: "verify live worker cost capture",
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
        updatedAt: new Date().toISOString(),
        runId: "live-worker-cost",
        taskType: "trivial",
        assignedAlias: "relay",
      };
      await channelStore.writeChannelTickets(channel.channelId, [ticket]);

      const spawner = new WorkerSpawner({
        invoker: new NodeCommandInvoker(),
        sandboxProvider: new LocalSandboxProvider(),
        buildPrompt: () =>
          "Do not call tools or modify files. Reply with exactly: Opened https://github.com/jcast90/relay/pull/999999",
      });
      const run = await handleRunAutonomous(
        [
          "--autonomous",
          channel.channelId,
          "--budget-tokens",
          "10000",
          "--max-hours",
          "1",
          "--json",
        ],
        {
          rootDir: root,
          channelsDir: join(root, "channels"),
          channelStore,
          sessionIdFactory: () => "live-worker-cost",
          stdout: () => {},
          stderr: () => {},
          startSession: (options) =>
            startAutonomousSession({
              ...options,
              testOverrides: {
                channelStore,
                repoAdminSpawner: new FakeAdminSpawner(),
                workerSpawner: spawner,
                rootDir: root,
                pollIntervalMs: 2,
              },
            }),
        }
      );
      expect(run.exitCode).toBe(0);

      const costLedger = new TaskCostLedger({ rootDir: root });
      await costLedger.flush();

      const lines = await costLedger.readAll();
      expect(lines).toHaveLength(1);
      expect(lines[0].inputTokens + lines[0].outputTokens).toBeGreaterThan(0);
      expect(lines[0].costUsd).toBeGreaterThan(0);
      const board = await channelStore.readChannelTickets(channel.channelId);
      expect(board[0].status).toBe("verifying");

      process.env.HOME = join(base, "home");
      const stdout = new Sink();
      const stderr = new Sink();
      const result = await handleCostCommand({ argv: ["--json"], stdout, stderr });
      expect(result.exitCode).toBe(0);
      expect(stderr.data).toBe("");
      const report = JSON.parse(stdout.data);
      expect(report.callCount).toBe(1);
      expect(report.taskCount).toBe(1);
      expect(report.totalUsd).toBe(lines[0].costUsd);
    } finally {
      process.env.HOME = originalHome;
      if (originalPoolFlag === undefined) delete process.env[RELAY_REPO_ADMIN_POOL_ENABLED];
      else process.env[RELAY_REPO_ADMIN_POOL_ENABLED] = originalPoolFlag;
      if (originalDrainFlag === undefined) delete process.env[RELAY_AL14_WORKER_DRAIN];
      else process.env[RELAY_AL14_WORKER_DRAIN] = originalDrainFlag;
      await rm(base, { recursive: true, force: true });
    }
  }, 180_000);
});
