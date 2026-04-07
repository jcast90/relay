import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CrosslinkStore } from "../src/crosslink/store.js";
import {
  callCrosslinkTool,
  isCrosslinkTool,
  type CrosslinkToolState
} from "../src/crosslink/tools.js";

describe("crosslink tools", () => {
  it("isCrosslinkTool identifies crosslink tools", () => {
    expect(isCrosslinkTool("crosslink_discover")).toBe(true);
    expect(isCrosslinkTool("crosslink_send")).toBe(true);
    expect(isCrosslinkTool("harness_status")).toBe(false);
  });

  it("discover returns registered sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), "crosslink-tools-"));
    const store = new CrosslinkStore(root);

    try {
      const session = await store.registerSession({
        pid: process.pid,
        repoPath: "/tmp/repo",
        description: "Test session",
        capabilities: ["general"],
        agentProvider: "claude",
        status: "active"
      });

      const state: CrosslinkToolState = {
        sessionId: session.sessionId,
        store
      };

      const result = await callCrosslinkTool("crosslink_discover", {}, state) as {
        currentSessionId: string;
        sessions: Array<{ sessionId: string; isSelf: boolean }>;
      };

      expect(result.currentSessionId).toBe(session.sessionId);
      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0].isSelf).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("send and poll round-trip", async () => {
    const root = await mkdtemp(join(tmpdir(), "crosslink-tools-"));
    const store = new CrosslinkStore(root);

    try {
      const sessionA = await store.registerSession({
        pid: process.pid,
        repoPath: "/tmp/repo-a",
        description: "Session A",
        capabilities: ["general"],
        agentProvider: "claude",
        status: "active"
      });

      const sessionB = await store.registerSession({
        pid: process.pid,
        repoPath: "/tmp/repo-b",
        description: "Session B",
        capabilities: ["code_implementation"],
        agentProvider: "codex",
        status: "active"
      });

      const stateA: CrosslinkToolState = { sessionId: sessionA.sessionId, store };
      const stateB: CrosslinkToolState = { sessionId: sessionB.sessionId, store };

      // A sends to B
      const sendResult = await callCrosslinkTool("crosslink_send", {
        toSessionId: sessionB.sessionId,
        content: "What endpoints exist?"
      }, stateA) as { messageId: string };

      expect(sendResult.messageId).toMatch(/^msg-/);

      // B polls
      const pollResult = await callCrosslinkTool("crosslink_poll", {}, stateB) as {
        count: number;
        messages: Array<{ messageId: string; content: string; fromSessionId: string }>;
      };

      expect(pollResult.count).toBe(1);
      expect(pollResult.messages[0].content).toBe("What endpoints exist?");
      expect(pollResult.messages[0].fromSessionId).toBe(sessionA.sessionId);

      // B replies
      const replyResult = await callCrosslinkTool("crosslink_reply", {
        messageId: pollResult.messages[0].messageId,
        content: "GET /users, POST /users"
      }, stateB) as { replyMessageId: string; toSessionId: string };

      expect(replyResult.toSessionId).toBe(sessionA.sessionId);

      // A polls and gets the reply
      const replyPoll = await callCrosslinkTool("crosslink_poll", {}, stateA) as {
        count: number;
        messages: Array<{ content: string; inReplyTo: string | null }>;
      };

      expect(replyPoll.count).toBe(1);
      expect(replyPoll.messages[0].content).toBe("GET /users, POST /users");
      expect(replyPoll.messages[0].inReplyTo).toBe(pollResult.messages[0].messageId);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("register updates session description", async () => {
    const root = await mkdtemp(join(tmpdir(), "crosslink-tools-"));
    const store = new CrosslinkStore(root);

    try {
      const session = await store.registerSession({
        pid: process.pid,
        repoPath: "/tmp/repo",
        description: "Initial",
        capabilities: ["general"],
        agentProvider: "claude",
        status: "active"
      });

      const state: CrosslinkToolState = { sessionId: session.sessionId, store };

      const result = await callCrosslinkTool("crosslink_register", {
        description: "Working on auth module",
        capabilities: ["code_implementation", "architecture"]
      }, state) as { description: string; capabilities: string[] };

      expect(result.description).toBe("Working on auth module");
      expect(result.capabilities).toEqual(["code_implementation", "architecture"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("deregister removes session", async () => {
    const root = await mkdtemp(join(tmpdir(), "crosslink-tools-"));
    const store = new CrosslinkStore(root);

    try {
      const session = await store.registerSession({
        pid: process.pid,
        repoPath: "/tmp/repo",
        description: "Test",
        capabilities: ["general"],
        agentProvider: "claude",
        status: "active"
      });

      const state: CrosslinkToolState = { sessionId: session.sessionId, store };

      const result = await callCrosslinkTool("crosslink_deregister", {}, state) as {
        deregistered: string;
      };

      expect(result.deregistered).toBe(session.sessionId);
      expect(state.sessionId).toBeNull();

      const sessions = await store.discoverSessions();
      expect(sessions).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns null for unknown tool names", async () => {
    const root = await mkdtemp(join(tmpdir(), "crosslink-tools-"));
    const store = new CrosslinkStore(root);

    try {
      const state: CrosslinkToolState = { sessionId: null, store };
      const result = await callCrosslinkTool("unknown_tool", {}, state);
      expect(result).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
