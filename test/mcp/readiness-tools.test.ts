import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChannelStore } from "../../src/channels/channel-store.js";
import { CrosslinkStore } from "../../src/crosslink/store.js";
import { callReadinessTool, type ReadinessToolState } from "../../src/mcp/readiness-tools.js";

/**
 * Phase 3 Wave 1 — RED test scaffolds for the `agent_ready` MCP tool.
 *
 * Wave 1 lands `callReadinessTool` as a stub that throws. Every test in
 * this file fails with that thrown error until Wave 2 Task 3 ships the
 * real handler body. The test shapes are written to the contract spec'd
 * in `03-PLAN.md` Task 3 so the green-after-Wave-2 transition is a no-op.
 *
 * Channel store is faked via a recording mock — the contract under test
 * is "exactly one `status_update` posted with `metadata.kind: agent_ready`
 * per first-time readiness assertion, zero on idempotent re-calls, zero
 * when channelId is null."
 */

interface PostedEntry {
  channelId: string;
  entry: unknown;
}

function makeFakeChannelStore(posted: PostedEntry[]): ChannelStore {
  return {
    postEntry: vi.fn(async (channelId: string, entry: unknown) => {
      posted.push({ channelId, entry });
      return { entryId: `entry-${posted.length}` } as unknown;
    }),
  } as unknown as ChannelStore;
}

describe("agent_ready MCP tool — Phase 3 Wave 1 RED scaffolds", () => {
  let root: string;
  let crosslinkStore: CrosslinkStore;
  let posted: PostedEntry[];
  let channelStore: ChannelStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "agent-ready-"));
    crosslinkStore = new CrosslinkStore(root);
    posted = [];
    channelStore = makeFakeChannelStore(posted);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function makeState(
    overrides: Partial<ReadinessToolState> = {}
  ): Promise<ReadinessToolState> {
    const session = await crosslinkStore.registerSession({
      pid: process.pid,
      repoPath: "/tmp/test-repo",
      description: "agent_ready test",
      capabilities: ["general"],
      agentProvider: "claude",
      status: "active",
    });
    return {
      crosslinkSessionId: session.sessionId,
      channelId: "channel-test",
      alias: "test-admin",
      crosslinkStore,
      channelStore,
      ...overrides,
    };
  }

  it("returns ok with readyAt when called with valid state", async () => {
    const state = await makeState();
    const result = (await callReadinessTool({}, state)) as {
      ok: boolean;
      readyAt?: string;
    };
    expect(result.ok).toBe(true);
    expect(result.readyAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("posts a single status_update entry with metadata.kind agent_ready", async () => {
    const state = await makeState();
    await callReadinessTool({}, state);

    expect(posted).toHaveLength(1);
    const entry = posted[0].entry as {
      type: string;
      metadata: { kind: string; readyKind: string; sessionId: string };
    };
    expect(posted[0].channelId).toBe("channel-test");
    expect(entry.type).toBe("status_update");
    expect(entry.metadata.kind).toBe("agent_ready");
    expect(entry.metadata.readyKind).toBe("admin");
    expect(entry.metadata.sessionId).toBe(state.crosslinkSessionId);
  });

  it("is idempotent — second call posts no second feed entry", async () => {
    const state = await makeState();
    const first = (await callReadinessTool({}, state)) as { readyAt: string };
    const second = (await callReadinessTool({}, state)) as {
      readyAt: string;
      idempotent: boolean;
    };

    expect(second.idempotent).toBe(true);
    expect(second.readyAt).toBe(first.readyAt);
    expect(posted).toHaveLength(1);
  });

  it("degrades gracefully without channelId — flips disk flag, no feed entry", async () => {
    const state = await makeState({ channelId: null });
    const result = (await callReadinessTool({}, state)) as {
      ok: boolean;
      readyAt?: string;
    };
    expect(result.ok).toBe(true);
    expect(result.readyAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(posted).toHaveLength(0);

    // Disk flag is still authoritative even without a feed entry.
    const sessions = await crosslinkStore.discoverSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].readyAt).toBe(result.readyAt);
  });

  it("returns ok:false when crosslinkSessionId is null", async () => {
    const state = await makeState({ crosslinkSessionId: null });
    const result = (await callReadinessTool({}, state)) as {
      ok: boolean;
      reason?: string;
    };
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("session-not-registered");
    expect(posted).toHaveLength(0);
  });
});
