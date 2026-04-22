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
        description: "Authentication feature work",
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
      await store.archiveChannel(
        (await store.listChannels())[0].channelId === ch1.channelId
          ? (await store.listChannels())[1].channelId
          : (await store.listChannels())[0].channelId
      );

      // At least one active channel
      const active = await store.listChannels("active");
      expect(active.length).toBeGreaterThanOrEqual(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("unarchiveChannel flips status back to active", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ch-test-"));
    const store = new ChannelStore(dir);

    try {
      const channel = await store.createChannel({
        name: "#revive",
        description: "Round-trip test",
      });

      const archived = await store.archiveChannel(channel.channelId);
      expect(archived?.status).toBe("archived");

      const unarchived = await store.unarchiveChannel(channel.channelId);
      expect(unarchived?.status).toBe("active");

      const active = await store.listChannels("active");
      expect(active.some((c) => c.channelId === channel.channelId)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("unarchiveChannel returns null for an unknown channel", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ch-test-"));
    const store = new ChannelStore(dir);

    try {
      const result = await store.unarchiveChannel("does-not-exist");
      expect(result).toBeNull();
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
        sessionId: null,
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
        metadata: {},
      });

      await store.postEntry(channel.channelId, {
        type: "status_update",
        fromAgentId: null,
        fromDisplayName: null,
        content: "Run started",
        metadata: { runId: "run-1" },
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
        label: "Backend repo",
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
      const channel = await store.createChannel({
        name: "#decisions",
        description: "Decisions test",
      });

      const decision = await store.recordDecision(channel.channelId, {
        runId: "run-1",
        ticketId: null,
        title: "Use PostgreSQL over MySQL",
        description: "Chose PostgreSQL for the primary database.",
        rationale: "Better JSON support, better performance for our use case.",
        alternatives: ["MySQL", "SQLite"],
        decidedBy: "planner-claude",
        decidedByName: "Claude (Planner)",
        linkedArtifacts: [],
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
      { alias: "brain", workspaceId: "ws-brain", repoPath: "/tmp/brain" },
    ];

    it("persists primaryWorkspaceId passed to createChannel", async () => {
      const dir = await mkdtemp(join(tmpdir(), "ch-test-"));
      const store = new ChannelStore(dir);
      try {
        const channel = await store.createChannel({
          name: "#multi-repo",
          description: "Multi-repo channel",
          repoAssignments: assignments,
          primaryWorkspaceId: "ws-be",
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
          primaryWorkspaceId: "ws-does-not-exist",
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
          primaryWorkspaceId: "ws-brain",
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
          repoAssignments: assignments,
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
          repoAssignments: assignments,
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
          description: "No repos",
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
          primaryWorkspaceId: "ws-brain",
        });

        const updated = await store.updateChannel(channel.channelId, {
          repoAssignments: [assignments[0], assignments[1]], // drops brain
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
          primaryWorkspaceId: "ws-be",
        });

        const updated = await store.updateChannel(channel.channelId, {
          repoAssignments: [assignments[0], assignments[1]], // keeps be
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
          primaryWorkspaceId: "ws-ui",
        });

        const updated = await store.updateChannel(channel.channelId, {
          primaryWorkspaceId: "ws-brain",
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
          primaryWorkspaceId: "ws-ui",
        });

        const updated = await store.updateChannel(channel.channelId, {
          repoAssignments: [],
        });

        expect(updated!.primaryWorkspaceId).toBeUndefined();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe("linearProjectId patching", () => {
    it("persists linearProjectId via updateChannel and clears it on undefined", async () => {
      const dir = await mkdtemp(join(tmpdir(), "ch-test-"));
      const store = new ChannelStore(dir);
      try {
        const channel = await store.createChannel({
          name: "linked",
          description: "test",
        });
        expect(channel.linearProjectId).toBeUndefined();

        const linked = await store.updateChannel(channel.channelId, {
          linearProjectId: "proj-uuid-abc",
        });
        expect(linked!.linearProjectId).toBe("proj-uuid-abc");

        const reloaded = await store.getChannel(channel.channelId);
        expect(reloaded!.linearProjectId).toBe("proj-uuid-abc");

        const cleared = await store.updateChannel(channel.channelId, {
          linearProjectId: undefined,
        });
        expect(cleared!.linearProjectId).toBeUndefined();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe("path-segment validation", () => {
    // Every public method that takes a `channelId` and path-joins it must
    // reject path-traversal inputs before touching the filesystem. Invariants
    // further up the stack (CLI / MCP layer) should already be preventing
    // these, but the store is the last line of defense — if a caller ever
    // lets caller-controlled input through, these guards keep a malicious
    // value from escaping `channelsDir`.
    const badChannelIds = [
      { label: "parent traversal", value: "../foo" },
      { label: "directory boundary", value: "foo/bar" },
      { label: "null byte", value: "foo\0bar" },
      { label: "empty", value: "" },
      { label: "dot", value: "." },
      { label: "dot-dot", value: ".." },
      { label: "backslash", value: "foo\\bar" },
    ];

    for (const { label, value } of badChannelIds) {
      it(`rejects ${label} (${JSON.stringify(value)}) across every public method`, async () => {
        const dir = await mkdtemp(join(tmpdir(), "ch-test-"));
        const store = new ChannelStore(dir);
        try {
          // Sanity: create a good channel so any method that would otherwise
          // succeed by finding a record has something to find — a reject here
          // must come from the guard, not from a missing channel.
          await store.createChannel({ name: "#ok", description: "ok" });

          const expectThrow = async (fn: () => Promise<unknown>): Promise<void> => {
            await expect(fn()).rejects.toThrow(/Unsafe path segment/);
          };

          await expectThrow(() => store.getChannel(value));
          await expectThrow(() => store.updateChannel(value, { name: "x" }));
          await expectThrow(() => store.archiveChannel(value));
          await expectThrow(() =>
            store.joinChannel(value, {
              agentId: "a",
              displayName: "A",
              role: "planner",
              provider: "claude",
              sessionId: null,
            })
          );
          await expectThrow(() => store.leaveChannel(value, "a"));
          await expectThrow(() =>
            store.postEntry(value, {
              type: "message",
              fromAgentId: null,
              fromDisplayName: null,
              content: "hi",
              metadata: {},
            })
          );
          await expectThrow(() => store.post(value, "hi"));
          await expectThrow(() => store.readFeed(value));
          await expectThrow(() => store.addRef(value, { type: "repo", targetId: "x", label: "x" }));
          await expectThrow(() => store.removeRef(value, "x"));
          await expectThrow(() => store.linkRun(value, "run-1", "ws-1"));
          await expectThrow(() => store.readRunLinks(value));
          await expectThrow(() => store.readTrackedPrs(value));
          await expectThrow(() => store.writeTrackedPrs(value, []));
          await expectThrow(() => store.readChannelTickets(value));
          await expectThrow(() => store.writeChannelTickets(value, []));
          await expectThrow(() => store.upsertChannelTickets(value, []));
          await expectThrow(() =>
            store.recordDecision(value, {
              runId: null,
              ticketId: null,
              title: "t",
              description: "d",
              rationale: "r",
              alternatives: [],
              decidedBy: "a",
              decidedByName: "A",
              linkedArtifacts: [],
            })
          );
          await expectThrow(() => store.getDecision(value, "d"));
          await expectThrow(() => store.listDecisions(value));
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      });
    }

    it("linkRun also validates runId and workspaceId", async () => {
      // linkRun path-joins channelId only, but runId/workspaceId are
      // user-controlled in the general case (e.g. a scheduler seeded from a
      // tracker payload) — guard them too so the store never embeds an
      // unsafe value in JSON written to disk, even when the channelId is
      // well-formed.
      const dir = await mkdtemp(join(tmpdir(), "ch-test-"));
      const store = new ChannelStore(dir);
      try {
        const channel = await store.createChannel({
          name: "#r",
          description: "r",
        });
        await expect(store.linkRun(channel.channelId, "../bad-run", "ws-1")).rejects.toThrow(
          /Unsafe path segment/
        );
        await expect(store.linkRun(channel.channelId, "run-1", "../bad-ws")).rejects.toThrow(
          /Unsafe path segment/
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("getDecision also validates decisionId", async () => {
      const dir = await mkdtemp(join(tmpdir(), "ch-test-"));
      const store = new ChannelStore(dir);
      try {
        const channel = await store.createChannel({
          name: "#d",
          description: "d",
        });
        await expect(store.getDecision(channel.channelId, "../escape")).rejects.toThrow(
          /Unsafe path segment/
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
