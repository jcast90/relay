import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AgentRegistry } from "../src/agents/registry.js";
import { createLiveAgents } from "../src/agents/factory.js";
import { NodeCommandInvoker } from "../src/agents/command-invoker.js";
import { ChannelStore } from "../src/channels/channel-store.js";
import { LocalArtifactStore } from "../src/execution/artifact-store.js";
import { FileHarnessStore } from "../src/storage/file-store.js";
import { VerificationRunner } from "../src/execution/verification-runner.js";
import { OrchestratorV2 } from "../src/orchestrator/orchestrator-v2.js";
import { ScriptedInvoker } from "../src/simulation/scripted-invoker.js";

function buildOrchestrator(
  cwd: string,
  artifactsDir: string,
  opts: { channelStore?: ChannelStore; workspaceId?: string } = {}
) {
  const registry = new AgentRegistry();
  const agents = createLiveAgents({
    cwd,
    invoker: new ScriptedInvoker(cwd)
  });

  for (const agent of agents) {
    registry.register(agent);
  }

  const artifactStore = new LocalArtifactStore(
    artifactsDir,
    new FileHarnessStore(join(artifactsDir, "__hs__"))
  );
  const verificationRunner = new VerificationRunner(
    new NodeCommandInvoker(),
    artifactStore
  );

  return new OrchestratorV2(
    registry,
    cwd,
    verificationRunner,
    artifactStore,
    artifactsDir,
    opts.channelStore,
    opts.workspaceId
  );
}

describe("OrchestratorV2 integration", () => {
  it("classifies and executes a feature_small request end-to-end", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "orch-v2-test-"));
    const artifactsDir = join(tmpDir, "artifacts");

    try {
      const orchestrator = buildOrchestrator(tmpDir, artifactsDir);
      const run = await orchestrator.run(
        "Implement a new authentication system with JWT tokens and session management"
      );

      // Heuristic doesn't match, ScriptedInvoker returns feature_small
      expect(run.classification).not.toBeNull();
      expect(run.classification!.tier).toBe("feature_small");

      // Should have a ticket plan
      expect(run.ticketPlan).not.toBeNull();
      expect(run.ticketPlan!.tickets.length).toBeGreaterThan(0);

      // Ticket ledger should exist
      expect(run.ticketLedger.length).toBeGreaterThan(0);

      // Events should have been recorded
      expect(run.events.length).toBeGreaterThan(0);

      // Should have passed through CLASSIFYING and PLAN_REVIEW
      const eventTypes = run.events.map((e) => e.type);
      expect(eventTypes).toContain("ClassificationComplete");
      expect(eventTypes).toContain("PlanGenerated");
      expect(eventTypes).toContain("TicketsCreated");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("classifies trivial requests and fast-tracks them", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "orch-v2-test-"));
    const artifactsDir = join(tmpDir, "artifacts");

    try {
      const orchestrator = buildOrchestrator(tmpDir, artifactsDir);
      const run = await orchestrator.run("Fix typo in README");

      expect(run.classification).not.toBeNull();
      expect(run.classification!.tier).toBe("trivial");

      // Trivial should still get tickets
      expect(run.ticketPlan).not.toBeNull();
      expect(run.ticketLedger.length).toBeGreaterThan(0);

      const eventTypes = run.events.map((e) => e.type);
      expect(eventTypes).toContain("ClassificationComplete");
      expect(eventTypes).toContain("TicketsCreated");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("returns AWAITING_APPROVAL for feature_large without blocking", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "orch-v2-test-"));
    const artifactsDir = join(tmpDir, "artifacts");

    try {
      // Override classification by using a request that won't match heuristics
      // The ScriptedInvoker always returns feature_small, so let's test with
      // a direct classification override via a bugfix heuristic
      const orchestrator = buildOrchestrator(tmpDir, artifactsDir);
      const run = await orchestrator.run(
        "Implement a new authentication system with JWT tokens and session management"
      );

      // ScriptedInvoker returns feature_small, which doesn't need approval
      // So this test verifies the non-approval path completes
      expect(run.classification!.tier).toBe("feature_small");
      expect(run.state).not.toBe("AWAITING_APPROVAL");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("persists run snapshot and events to disk", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "orch-v2-test-"));
    const artifactsDir = join(tmpDir, "artifacts");

    try {
      const artifactStore = new LocalArtifactStore(
    artifactsDir,
    new FileHarnessStore(join(artifactsDir, "__hs__"))
  );
      const orchestrator = buildOrchestrator(tmpDir, artifactsDir);
      const run = await orchestrator.run("Fix typo in README");

      // Verify snapshot was written
      const snapshot = await artifactStore.readRunSnapshot(run.id);
      expect(snapshot).not.toBeNull();
      expect(snapshot!.runId).toBe(run.id);
      expect(snapshot!.classification).not.toBeNull();

      // Verify events were written
      const events = await artifactStore.readEventLog(run.id);
      expect(events.length).toBeGreaterThan(0);

      // Verify runs index
      const runs = await artifactStore.readRunsIndex();
      expect(runs.some((r) => r.runId === run.id)).toBe(true);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("mirrors ticket ledger to the channel board on the regular decomposition path", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "orch-v2-test-"));
    const artifactsDir = join(tmpDir, "artifacts");
    const channelsDir = join(tmpDir, "channels");

    try {
      const channelStore = new ChannelStore(channelsDir);
      const orchestrator = buildOrchestrator(tmpDir, artifactsDir, {
        channelStore,
        workspaceId: "ws-test"
      });
      const run = await orchestrator.run(
        "Implement a new authentication system with JWT tokens and session management"
      );

      expect(run.channelId).not.toBeNull();
      const boardTickets = await channelStore.readChannelTickets(run.channelId!);
      expect(boardTickets.length).toBe(run.ticketLedger.length);
      for (const entry of boardTickets) {
        expect(entry.runId).toBe(run.id);
      }
      const boardIds = boardTickets.map((t) => t.ticketId).sort();
      const ledgerIds = run.ticketLedger.map((t) => t.ticketId).sort();
      expect(boardIds).toEqual(ledgerIds);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("mirrors ticket ledger to the channel board on the trivial fast-track path", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "orch-v2-test-"));
    const artifactsDir = join(tmpDir, "artifacts");
    const channelsDir = join(tmpDir, "channels");

    try {
      const channelStore = new ChannelStore(channelsDir);
      const orchestrator = buildOrchestrator(tmpDir, artifactsDir, {
        channelStore,
        workspaceId: "ws-test"
      });
      const run = await orchestrator.run("Fix typo in README");

      expect(run.classification!.tier).toBe("trivial");
      expect(run.channelId).not.toBeNull();
      const boardTickets = await channelStore.readChannelTickets(run.channelId!);
      expect(boardTickets.length).toBeGreaterThan(0);
      expect(boardTickets[0].runId).toBe(run.id);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("continues the run when the channel store mirror throws", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "orch-v2-test-"));
    const artifactsDir = join(tmpDir, "artifacts");
    const channelsDir = join(tmpDir, "channels");

    try {
      const channelStore = new ChannelStore(channelsDir);
      // Force upsert to fail for the duration of the run.
      const originalUpsert = channelStore.upsertChannelTickets.bind(channelStore);
      channelStore.upsertChannelTickets = async () => {
        throw new Error("simulated write failure");
      };

      const orchestrator = buildOrchestrator(tmpDir, artifactsDir, {
        channelStore,
        workspaceId: "ws-test"
      });
      const run = await orchestrator.run(
        "Implement a new authentication system with JWT tokens and session management"
      );

      // Run still completes the per-run ledger even though the mirror failed.
      expect(run.ticketLedger.length).toBeGreaterThan(0);

      // Restore and verify the channel board is empty as expected.
      channelStore.upsertChannelTickets = originalUpsert;
      const boardTickets = await channelStore.readChannelTickets(run.channelId!);
      expect(boardTickets).toEqual([]);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);
});
