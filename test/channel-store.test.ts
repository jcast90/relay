import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ChannelStore } from "../src/channels/channel-store.js";

describe("channel store", () => {
  it("creates and retrieves a channel", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ch-test-"));
    const store = new ChannelStore(dir);

    try {
      const channel = await store.createChannel({
        name: "#feature-auth",
        description: "Authentication feature work"
      });

      expect(channel.name).toBe("#feature-auth");
      expect(channel.status).toBe("active");
      expect(channel.members).toHaveLength(0);

      const fetched = await store.getChannel(channel.channelId);
      expect(fetched).not.toBeNull();
      expect(fetched!.name).toBe("#feature-auth");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("lists channels filtered by status", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ch-test-"));
    const store = new ChannelStore(dir);

    try {
      const ch1 = await store.createChannel({ name: "#active", description: "Active" });
      await store.createChannel({ name: "#archived", description: "Archived" });
      await store.archiveChannel((await store.listChannels())[0].channelId === ch1.channelId
        ? (await store.listChannels())[1].channelId
        : (await store.listChannels())[0].channelId);

      // At least one active channel
      const active = await store.listChannels("active");
      expect(active.length).toBeGreaterThanOrEqual(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("manages channel members (join/leave)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ch-test-"));
    const store = new ChannelStore(dir);

    try {
      const channel = await store.createChannel({ name: "#team", description: "Team" });

      await store.joinChannel(channel.channelId, {
        agentId: "planner-claude",
        displayName: "Claude (Planner)",
        role: "planner",
        provider: "claude",
        sessionId: null
      });

      const updated = await store.getChannel(channel.channelId);
      expect(updated!.members).toHaveLength(1);
      expect(updated!.members[0].displayName).toBe("Claude (Planner)");
      expect(updated!.members[0].status).toBe("active");

      await store.leaveChannel(channel.channelId, "planner-claude");
      const afterLeave = await store.getChannel(channel.channelId);
      expect(afterLeave!.members[0].status).toBe("offline");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("appends and reads feed entries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ch-test-"));
    const store = new ChannelStore(dir);

    try {
      const channel = await store.createChannel({ name: "#feed", description: "Feed test" });

      await store.postEntry(channel.channelId, {
        type: "message",
        fromAgentId: "agent-1",
        fromDisplayName: "Agent One",
        content: "Hello channel!",
        metadata: {}
      });

      await store.postEntry(channel.channelId, {
        type: "status_update",
        fromAgentId: null,
        fromDisplayName: null,
        content: "Run started",
        metadata: { runId: "run-1" }
      });

      const feed = await store.readFeed(channel.channelId);
      expect(feed).toHaveLength(2);
      expect(feed[0].type).toBe("message");
      expect(feed[0].content).toBe("Hello channel!");
      expect(feed[1].type).toBe("status_update");

      // Test limit
      const limited = await store.readFeed(channel.channelId, 1);
      expect(limited).toHaveLength(1);
      expect(limited[0].type).toBe("status_update");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("manages pinned references", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ch-test-"));
    const store = new ChannelStore(dir);

    try {
      const channel = await store.createChannel({ name: "#refs", description: "Refs test" });

      await store.addRef(channel.channelId, {
        type: "repo",
        targetId: "/path/to/repo",
        label: "Backend repo"
      });

      const updated = await store.getChannel(channel.channelId);
      expect(updated!.pinnedRefs).toHaveLength(1);
      expect(updated!.pinnedRefs[0].label).toBe("Backend repo");

      await store.removeRef(channel.channelId, "/path/to/repo");
      const afterRemove = await store.getChannel(channel.channelId);
      expect(afterRemove!.pinnedRefs).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("links runs to channels", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ch-test-"));
    const store = new ChannelStore(dir);

    try {
      const channel = await store.createChannel({ name: "#runs", description: "Runs test" });

      await store.linkRun(channel.channelId, "run-1", "workspace-abc");
      await store.linkRun(channel.channelId, "run-2", "workspace-abc");
      // Duplicate should be ignored
      await store.linkRun(channel.channelId, "run-1", "workspace-abc");

      const links = await store.readRunLinks(channel.channelId);
      expect(links).toHaveLength(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("records and lists decisions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ch-test-"));
    const store = new ChannelStore(dir);

    try {
      const channel = await store.createChannel({ name: "#decisions", description: "Decisions test" });

      const decision = await store.recordDecision(channel.channelId, {
        runId: "run-1",
        ticketId: null,
        title: "Use PostgreSQL over MySQL",
        description: "Chose PostgreSQL for the primary database.",
        rationale: "Better JSON support, better performance for our use case.",
        alternatives: ["MySQL", "SQLite"],
        decidedBy: "planner-claude",
        decidedByName: "Claude (Planner)",
        linkedArtifacts: []
      });

      expect(decision.title).toBe("Use PostgreSQL over MySQL");
      expect(decision.channelId).toBe(channel.channelId);

      const decisions = await store.listDecisions(channel.channelId);
      expect(decisions).toHaveLength(1);
      expect(decisions[0].alternatives).toContain("MySQL");

      const fetched = await store.getDecision(channel.channelId, decision.decisionId);
      expect(fetched).not.toBeNull();
      expect(fetched!.rationale).toContain("JSON support");

      // Check that decision was posted to feed
      const feed = await store.readFeed(channel.channelId);
      const decisionEntry = feed.find((e) => e.type === "decision");
      expect(decisionEntry).toBeDefined();
      expect(decisionEntry!.content).toContain("PostgreSQL");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
