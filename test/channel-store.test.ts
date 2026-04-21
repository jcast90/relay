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

  describe("primary repo assignment", () => {
    const assignments = [
      { alias: "ui", workspaceId: "ws-ui", repoPath: "/tmp/ui" },
      { alias: "be", workspaceId: "ws-be", repoPath: "/tmp/be" },
      { alias: "brain", workspaceId: "ws-brain", repoPath: "/tmp/brain" }
    ];

    it("persists primaryWorkspaceId passed to createChannel", async () => {
      const dir = await mkdtemp(join(tmpdir(), "ch-test-"));
      const store = new ChannelStore(dir);
      try {
        const channel = await store.createChannel({
          name: "#multi-repo",
          description: "Multi-repo channel",
          repoAssignments: assignments,
          primaryWorkspaceId: "ws-be"
        });

        expect(channel.primaryWorkspaceId).toBe("ws-be");
        const fetched = await store.getChannel(channel.channelId);
        expect(fetched!.primaryWorkspaceId).toBe("ws-be");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("drops primaryWorkspaceId that doesn't match any assignment on create", async () => {
      const dir = await mkdtemp(join(tmpdir(), "ch-test-"));
      const store = new ChannelStore(dir);
      try {
        const channel = await store.createChannel({
          name: "#bad-primary",
          description: "Dangling primary",
          repoAssignments: assignments,
          primaryWorkspaceId: "ws-does-not-exist"
        });

        expect(channel.primaryWorkspaceId).toBeUndefined();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("getPrimaryAssignment returns the matching assignment when primary is set", async () => {
      const dir = await mkdtemp(join(tmpdir(), "ch-test-"));
      const store = new ChannelStore(dir);
      try {
        const channel = await store.createChannel({
          name: "#primary-set",
          description: "Primary set",
          repoAssignments: assignments,
          primaryWorkspaceId: "ws-brain"
        });

        const primary = store.getPrimaryAssignment(channel);
        expect(primary).not.toBeNull();
        expect(primary!.alias).toBe("brain");
        expect(primary!.workspaceId).toBe("ws-brain");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("getPrimaryAssignment falls back to the first assignment when primary is unset", async () => {
      const dir = await mkdtemp(join(tmpdir(), "ch-test-"));
      const store = new ChannelStore(dir);
      try {
        const channel = await store.createChannel({
          name: "#primary-unset",
          description: "Primary unset",
          repoAssignments: assignments
        });

        expect(channel.primaryWorkspaceId).toBeUndefined();
        const primary = store.getPrimaryAssignment(channel);
        expect(primary).not.toBeNull();
        expect(primary!.alias).toBe("ui");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("getPrimaryAssignment falls back to first assignment when primary points at a missing workspaceId", async () => {
      const dir = await mkdtemp(join(tmpdir(), "ch-test-"));
      const store = new ChannelStore(dir);
      try {
        // Simulate a channel file that was hand-edited or written by an
        // older version: primaryWorkspaceId is set but isn't in
        // repoAssignments. The helper must not strand the caller.
        const channel = await store.createChannel({
          name: "#stale-primary",
          description: "Stale primary",
          repoAssignments: assignments
        });
        const stale = { ...channel, primaryWorkspaceId: "ws-gone" };

        const primary = store.getPrimaryAssignment(stale);
        expect(primary).not.toBeNull();
        expect(primary!.alias).toBe("ui");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("getPrimaryAssignment returns null when the channel has no repoAssignments", async () => {
      const dir = await mkdtemp(join(tmpdir(), "ch-test-"));
      const store = new ChannelStore(dir);
      try {
        const channel = await store.createChannel({
          name: "#no-repos",
          description: "No repos"
        });
        expect(store.getPrimaryAssignment(channel)).toBeNull();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("updateChannel reassigns primary to first remaining repo when the current primary is removed", async () => {
      const dir = await mkdtemp(join(tmpdir(), "ch-test-"));
      const store = new ChannelStore(dir);
      try {
        const channel = await store.createChannel({
          name: "#shrink",
          description: "Shrink repos",
          repoAssignments: assignments,
          primaryWorkspaceId: "ws-brain"
        });

        const updated = await store.updateChannel(channel.channelId, {
          repoAssignments: [assignments[0], assignments[1]] // drops brain
        });

        expect(updated).not.toBeNull();
        // brain is gone → primary should fall back to first remaining (ui)
        expect(updated!.primaryWorkspaceId).toBe("ws-ui");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("updateChannel preserves primaryWorkspaceId when the primary survives the repos update", async () => {
      const dir = await mkdtemp(join(tmpdir(), "ch-test-"));
      const store = new ChannelStore(dir);
      try {
        const channel = await store.createChannel({
          name: "#preserve",
          description: "Preserve primary",
          repoAssignments: assignments,
          primaryWorkspaceId: "ws-be"
        });

        const updated = await store.updateChannel(channel.channelId, {
          repoAssignments: [assignments[0], assignments[1]] // keeps be
        });

        expect(updated!.primaryWorkspaceId).toBe("ws-be");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("updateChannel can change primaryWorkspaceId directly", async () => {
      const dir = await mkdtemp(join(tmpdir(), "ch-test-"));
      const store = new ChannelStore(dir);
      try {
        const channel = await store.createChannel({
          name: "#repoint",
          description: "Repoint primary",
          repoAssignments: assignments,
          primaryWorkspaceId: "ws-ui"
        });

        const updated = await store.updateChannel(channel.channelId, {
          primaryWorkspaceId: "ws-brain"
        });

        expect(updated!.primaryWorkspaceId).toBe("ws-brain");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("updateChannel clears primaryWorkspaceId when repoAssignments is emptied", async () => {
      const dir = await mkdtemp(join(tmpdir(), "ch-test-"));
      const store = new ChannelStore(dir);
      try {
        const channel = await store.createChannel({
          name: "#clear",
          description: "Clear primary",
          repoAssignments: assignments,
          primaryWorkspaceId: "ws-ui"
        });

        const updated = await store.updateChannel(channel.channelId, {
          repoAssignments: []
        });

        expect(updated!.primaryWorkspaceId).toBeUndefined();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
