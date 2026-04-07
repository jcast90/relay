import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CrosslinkStore } from "../src/crosslink/store.js";

describe("crosslink store", () => {
  it("registers and discovers a session", async () => {
    const root = await mkdtemp(join(tmpdir(), "crosslink-test-"));
    const store = new CrosslinkStore(root);

    try {
      const session = await store.registerSession({
        pid: process.pid,
        repoPath: "/tmp/test-repo",
        description: "Test session",
        capabilities: ["general"],
        agentProvider: "claude",
        status: "active"
      });

      expect(session.sessionId).toMatch(/^session-/);
      expect(session.pid).toBe(process.pid);

      const sessions = await store.discoverSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].sessionId).toBe(session.sessionId);
      expect(sessions[0].repoPath).toBe("/tmp/test-repo");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("deregisters a session", async () => {
    const root = await mkdtemp(join(tmpdir(), "crosslink-test-"));
    const store = new CrosslinkStore(root);

    try {
      const session = await store.registerSession({
        pid: process.pid,
        repoPath: "/tmp/test-repo",
        description: "Test session",
        capabilities: ["general"],
        agentProvider: "claude",
        status: "active"
      });

      await store.deregisterSession(session.sessionId);

      const sessions = await store.discoverSessions();
      expect(sessions).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("filters stale sessions with dead PIDs", async () => {
    const root = await mkdtemp(join(tmpdir(), "crosslink-test-"));
    const store = new CrosslinkStore(root);

    try {
      // Register with a PID that definitely doesn't exist
      const session = await store.registerSession({
        pid: 999999,
        repoPath: "/tmp/test-repo",
        description: "Dead session",
        capabilities: ["general"],
        agentProvider: "claude",
        status: "active"
      });

      // Manually set heartbeat to the past to trigger stale detection
      await store.updateSession(session.sessionId, { description: "Dead session" });

      // Force heartbeat to be old by writing directly
      const { writeFile } = await import("node:fs/promises");
      const sessionFile = join(root, "sessions", `${session.sessionId}.json`);
      const raw = JSON.parse(
        await (await import("node:fs/promises")).readFile(sessionFile, "utf8")
      );
      raw.lastHeartbeat = new Date(Date.now() - 200_000).toISOString();
      await writeFile(sessionFile, JSON.stringify(raw, null, 2));

      const sessions = await store.discoverSessions();
      expect(sessions).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("sends and polls messages", async () => {
    const root = await mkdtemp(join(tmpdir(), "crosslink-test-"));
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

      // A sends to B
      const message = await store.sendMessage({
        fromSessionId: sessionA.sessionId,
        toSessionId: sessionB.sessionId,
        content: "What is the API schema for /users?",
        type: "question"
      });

      expect(message.messageId).toMatch(/^msg-/);
      expect(message.status).toBe("pending");

      // B polls and receives
      const messages = await store.pollMessages(sessionB.sessionId);
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe("What is the API schema for /users?");
      expect(messages[0].status).toBe("delivered");
      expect(messages[0].fromSessionId).toBe(sessionA.sessionId);

      // Polling again returns nothing (already delivered)
      const empty = await store.pollMessages(sessionB.sessionId);
      expect(empty).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("updates message status to replied", async () => {
    const root = await mkdtemp(join(tmpdir(), "crosslink-test-"));
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

      const message = await store.sendMessage({
        fromSessionId: "other-session",
        toSessionId: session.sessionId,
        content: "Hello",
        type: "question"
      });

      await store.updateMessageStatus(session.sessionId, message.messageId, "replied");

      // Polling should return nothing since it's no longer pending
      const messages = await store.pollMessages(session.sessionId);
      expect(messages).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("updates session description and capabilities", async () => {
    const root = await mkdtemp(join(tmpdir(), "crosslink-test-"));
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

      const updated = await store.updateSession(session.sessionId, {
        description: "Working on auth feature",
        capabilities: ["code_implementation", "architecture"]
      });

      expect(updated).not.toBeNull();
      expect(updated!.description).toBe("Working on auth feature");
      expect(updated!.capabilities).toEqual(["code_implementation", "architecture"]);

      const sessions = await store.discoverSessions();
      expect(sessions[0].description).toBe("Working on auth feature");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("cleans expired messages", async () => {
    const root = await mkdtemp(join(tmpdir(), "crosslink-test-"));
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

      const message = await store.sendMessage({
        fromSessionId: "other",
        toSessionId: session.sessionId,
        content: "Old message",
        type: "question"
      });

      // Manually backdate the message
      const { readFile, writeFile } = await import("node:fs/promises");
      const msgFile = join(root, "mailboxes", session.sessionId, `${message.messageId}.json`);
      const raw = JSON.parse(await readFile(msgFile, "utf8"));
      raw.createdAt = new Date(Date.now() - 4_000_000).toISOString();
      await writeFile(msgFile, JSON.stringify(raw, null, 2));

      const cleaned = await store.cleanExpiredMessages();
      expect(cleaned).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
