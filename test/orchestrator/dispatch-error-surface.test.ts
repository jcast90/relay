import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mocks must be declared at module scope (hoisted by vitest). We mock the
// orchestrator so `orchestrator.run()` rejects; dispatch should then surface
// the failure to the channel feed instead of silently swallowing it.
const runRejection = new Error("synthetic orchestrator failure");
runRejection.stack = [
  "Error: synthetic orchestrator failure",
  "    at frame 1",
  "    at frame 2",
  "    at frame 3",
  "    at frame 4"
].join("\n");

vi.mock("../../src/orchestrator/orchestrator-v2.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/orchestrator/orchestrator-v2.js")
  >("../../src/orchestrator/orchestrator-v2.js");
  class MockOrchestratorV2 {
    attachPoller(): void {
      /* no-op */
    }
    async run(): Promise<never> {
      throw runRejection;
    }
  }
  return {
    ...actual,
    OrchestratorV2: MockOrchestratorV2
  };
});

// Prevent the real agent factory from shelling out.
vi.mock("../../src/agents/factory.js", () => ({
  createLiveAgents: () => [],
  registerAgentNames: async () => {
    /* no-op */
  }
}));

// Pin the storage factory to a tmp-backed FileHarnessStore so dispatch's call
// to getHarnessStore() doesn't touch ~/.relay.
const storeRoots: string[] = [];
vi.mock("../../src/storage/factory.js", async () => {
  const { FileHarnessStore } = await import("../../src/storage/file-store.js");
  const root = await mkdtemp(join(tmpdir(), "dispatch-err-hs-"));
  storeRoots.push(root);
  const store = new FileHarnessStore(root);
  return {
    getHarnessStore: () => store,
    buildHarnessStore: () => store
  };
});

describe("dispatch surfaces fire-and-forget orchestrator errors", () => {
  let tmpHome: string;
  const ORIGINAL_HOME = process.env.HOME;

  beforeEach(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), "dispatch-err-home-"));
    process.env.HOME = tmpHome;
    const { __resetRelayDirCacheForTests } = await import("../../src/cli/paths.js");
    __resetRelayDirCacheForTests();
  });

  afterEach(async () => {
    await rm(tmpHome, { recursive: true, force: true });
    if (ORIGINAL_HOME === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = ORIGINAL_HOME;
    }
    const { __resetRelayDirCacheForTests } = await import("../../src/cli/paths.js");
    __resetRelayDirCacheForTests();
    while (storeRoots.length > 0) {
      const r = storeRoots.pop();
      if (r) await rm(r, { recursive: true, force: true });
    }
  });

  it("posts a feed entry describing the failure when the background run rejects", async () => {
    const { dispatch } = await import("../../src/orchestrator/dispatch.js");
    const { ChannelStore } = await import("../../src/channels/channel-store.js");

    const result = await dispatch({
      featureRequest: "Test feature",
      repoPath: "/irrelevant/repo"
    });

    expect(result.status).toBe("dispatched");
    expect(result.channelId).toBeDefined();

    // Allow the background .catch handler to run and post the feed entry.
    // postEntry awaits mkdir + appendFile + touchChannel (channel read+write);
    // a real timer flush is more reliable than microtask pumping.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const store = new ChannelStore();
    const entries = await store.readFeed(result.channelId);

    const failure = entries.find(
      (e) => e.type === "status_update" && e.content.startsWith("Run failed:")
    );
    expect(failure).toBeDefined();
    expect(failure!.content).toContain("synthetic orchestrator failure");
    expect(failure!.metadata.runId).toBe(result.runId);
    expect(failure!.metadata.channelId).toBe(result.channelId);
    expect(failure!.metadata.error).toBe("true");
    expect(failure!.metadata.errorMessage).toContain("synthetic orchestrator failure");
    // Stack trace is included, truncated to <= 20 lines.
    expect(failure!.metadata.errorStack).toBeDefined();
    const stackStr = String(failure!.metadata.errorStack);
    expect(stackStr.split("\n").length).toBeLessThanOrEqual(20);
    expect(stackStr).toContain("frame 1");
  });
});
