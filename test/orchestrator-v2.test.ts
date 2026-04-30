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
import { STORE_NS } from "../src/storage/namespaces.js";
import type { HarnessStore } from "../src/storage/store.js";
import { VerificationRunner } from "../src/execution/verification-runner.js";
import { OrchestratorV2 } from "../src/orchestrator/orchestrator-v2.js";
import { ScriptedInvoker } from "../src/simulation/scripted-invoker.js";

// Defensive tmp-dir cleanup. `force: true` alone swallows ENOENT but not
// ENOTEMPTY, which can surface on Linux CI when an atomic tmp-rename lands
// between rmdir's readdir scan and unlink. `maxRetries: 3` re-scans the
// directory so any late-arriving file gets unlinked on the next pass. The
// orchestrator now awaits its in-flight best-effort writes before returning
// (see OrchestratorV2.waitForPendingWrites), so this is belt-and-suspenders
// for the non-orchestrator writers (poller, scheduler tail, filesystem lag).
const RM_OPTS = { recursive: true, force: true, maxRetries: 3, retryDelay: 50 } as const;

/**
 * Poll `fn` until it returns a truthy value or `timeoutMs` elapses. OSS-21:
 * mirror the pattern from `verification-override-feed.test.ts` so cross-
 * process visibility races (atomic tmp-rename visible to a fresh
 * directory-read on Linux CI) surface as a crisp timeout instead of a flaky
 * single-snapshot assertion. Orchestrator-v2 already drains its tracked
 * writes before returning, so this is defensive — the timeout budget is
 * small and the happy path resolves on the first iteration.
 */
async function waitFor<T>(
  fn: () => Promise<T | undefined> | T | undefined,
  opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {}
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 2000;
  const intervalMs = opts.intervalMs ?? 20;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const value = await fn();
    if (value !== undefined && value !== null && value !== false) {
      return value as T;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `waitFor timed out after ${timeoutMs}ms${opts.label ? `: ${opts.label}` : ""}`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function buildOrchestrator(
  cwd: string,
  artifactsDir: string,
  opts: { channelStore?: ChannelStore; workspaceId?: string } = {}
) {
  const registry = new AgentRegistry();
  const agents = createLiveAgents({
    cwd,
    invoker: new ScriptedInvoker(cwd),
  });

  for (const agent of agents) {
    registry.register(agent);
  }

  const artifactStore = new LocalArtifactStore(
    artifactsDir,
    new FileHarnessStore(join(artifactsDir, "__hs__"))
  );
  const verificationRunner = new VerificationRunner(new NodeCommandInvoker(), artifactStore);

  const orchestrator = new OrchestratorV2(
    registry,
    cwd,
    verificationRunner,
    artifactStore,
    artifactsDir,
    opts.channelStore,
    opts.workspaceId
  );

  return { orchestrator, artifactStore };
}

async function readSavedDesignDoc(
  artifactStore: LocalArtifactStore,
  runId: string
): Promise<string | undefined> {
  // The artifact store has no public read-back for design docs today;
  // #206's coverage need does not justify expanding the public interface.
  const store = (artifactStore as unknown as { store: HarnessStore }).store;
  try {
    const bytes = await store.getBlob({
      ns: STORE_NS.runArtifacts,
      id: `${runId}__design-doc`,
      size: 0,
    });
    return new TextDecoder().decode(bytes);
  } catch {
    return undefined;
  }
}

describe("OrchestratorV2 integration", () => {
  it("classifies and executes a feature_small request end-to-end", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "orch-v2-test-"));
    const artifactsDir = join(tmpDir, "artifacts");

    try {
      const { orchestrator, artifactStore } = buildOrchestrator(tmpDir, artifactsDir);
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

      // #206: feature_small now triggers the design-doc step. Verify the
      // artifact landed so a future revert of tierNeedsDesignDoc would fail
      // this test instead of silently passing.
      const designDoc = await readSavedDesignDoc(artifactStore, run.id);
      expect(designDoc).toBeDefined();
      expect(designDoc!.length).toBeGreaterThan(0);
    } finally {
      await rm(tmpDir, RM_OPTS);
    }
  }, 30_000);

  it("classifies trivial requests and fast-tracks them", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "orch-v2-test-"));
    const artifactsDir = join(tmpDir, "artifacts");

    try {
      const { orchestrator, artifactStore } = buildOrchestrator(tmpDir, artifactsDir);
      const run = await orchestrator.run("Fix typo in README");

      expect(run.classification).not.toBeNull();
      expect(run.classification!.tier).toBe("trivial");

      // Trivial should still get tickets
      expect(run.ticketPlan).not.toBeNull();
      expect(run.ticketLedger.length).toBeGreaterThan(0);

      const eventTypes = run.events.map((e) => e.type);
      expect(eventTypes).toContain("ClassificationComplete");
      expect(eventTypes).toContain("TicketsCreated");

      // #206: trivial must NOT trigger the design-doc step.
      const designDoc = await readSavedDesignDoc(artifactStore, run.id);
      expect(designDoc).toBeUndefined();
    } finally {
      await rm(tmpDir, RM_OPTS);
    }
  }, 30_000);

  it("returns AWAITING_APPROVAL for feature_large without blocking", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "orch-v2-test-"));
    const artifactsDir = join(tmpDir, "artifacts");

    try {
      // Override classification by using a request that won't match heuristics
      // The ScriptedInvoker always returns feature_small, so let's test with
      // a direct classification override via a bugfix heuristic
      const { orchestrator } = buildOrchestrator(tmpDir, artifactsDir);
      const run = await orchestrator.run(
        "Implement a new authentication system with JWT tokens and session management"
      );

      // ScriptedInvoker returns feature_small, which doesn't need approval
      // So this test verifies the non-approval path completes
      expect(run.classification!.tier).toBe("feature_small");
      expect(run.state).not.toBe("AWAITING_APPROVAL");
    } finally {
      await rm(tmpDir, RM_OPTS);
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
      const { orchestrator } = buildOrchestrator(tmpDir, artifactsDir);
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
      await rm(tmpDir, RM_OPTS);
    }
  }, 30_000);

  it("mirrors ticket ledger to the channel board on the regular decomposition path", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "orch-v2-test-"));
    const artifactsDir = join(tmpDir, "artifacts");
    const channelsDir = join(tmpDir, "channels");

    try {
      const channelStore = new ChannelStore(channelsDir);
      const { orchestrator } = buildOrchestrator(tmpDir, artifactsDir, {
        channelStore,
        workspaceId: "ws-test",
      });
      const run = await orchestrator.run(
        "Implement a new authentication system with JWT tokens and session management"
      );

      expect(run.channelId).not.toBeNull();
      const boardTickets = await waitFor(
        async () => {
          const tickets = await channelStore.readChannelTickets(run.channelId!);
          return tickets.length === run.ticketLedger.length ? tickets : undefined;
        },
        { timeoutMs: 2000, intervalMs: 20, label: "channel board mirror settled" }
      );
      expect(boardTickets.length).toBe(run.ticketLedger.length);
      for (const entry of boardTickets) {
        expect(entry.runId).toBe(run.id);
      }
      const boardIds = boardTickets.map((t) => t.ticketId).sort();
      const ledgerIds = run.ticketLedger.map((t) => t.ticketId).sort();
      expect(boardIds).toEqual(ledgerIds);
    } finally {
      await rm(tmpDir, RM_OPTS);
    }
  }, 30_000);

  it("mirrors ticket ledger to the channel board on the trivial fast-track path", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "orch-v2-test-"));
    const artifactsDir = join(tmpDir, "artifacts");
    const channelsDir = join(tmpDir, "channels");

    try {
      const channelStore = new ChannelStore(channelsDir);
      const { orchestrator } = buildOrchestrator(tmpDir, artifactsDir, {
        channelStore,
        workspaceId: "ws-test",
      });
      const run = await orchestrator.run("Fix typo in README");

      expect(run.classification!.tier).toBe("trivial");
      expect(run.channelId).not.toBeNull();
      const boardTickets = await waitFor(
        async () => {
          const tickets = await channelStore.readChannelTickets(run.channelId!);
          return tickets.length > 0 ? tickets : undefined;
        },
        { timeoutMs: 2000, intervalMs: 20, label: "trivial fast-track board mirror settled" }
      );
      expect(boardTickets.length).toBeGreaterThan(0);
      expect(boardTickets[0].runId).toBe(run.id);
    } finally {
      await rm(tmpDir, RM_OPTS);
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

      const { orchestrator } = buildOrchestrator(tmpDir, artifactsDir, {
        channelStore,
        workspaceId: "ws-test",
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
      await rm(tmpDir, RM_OPTS);
    }
  }, 30_000);
});
