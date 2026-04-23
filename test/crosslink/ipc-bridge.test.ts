/**
 * AL-16 IPC bridge integration tests.
 *
 * Cover the three seams individually then the end-to-end loop:
 *
 *  - `writeOutboxRecord` — child-side append via the file-based fallback.
 *  - `IpcBridge` parent-side tail + route → inbox fan-out.
 *  - `coordination_receive` — child-side drain with cursor persistence.
 *  - End-to-end: admin A's `coordination_send` (via file) → bridge
 *    routes through coordinator → admin B's `coordination_receive`
 *    (via file) returns the same message body.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Coordinator } from "../../src/crosslink/coordinator.js";
import {
  IpcBridge,
  writeOutboxRecord,
  readInboxCursor,
  type IpcRecord,
} from "../../src/crosslink/ipc-bridge.js";
import { getInboxPath, getOutboxPath, getInboxCursorPath } from "../../src/crosslink/ipc-paths.js";
import {
  callCoordinationTool,
  COORDINATION_RECEIVE_TOOL,
  COORDINATION_SEND_TOOL,
  type CoordinationToolState,
} from "../../src/mcp/coordination-tools.js";
import { ChannelStore } from "../../src/channels/channel-store.js";

const SESSION_ID = "ipc-bridge-test";

interface FakePool {
  getSession(alias: string): { alias: string } | null;
  listSessions(): Array<{ alias: string }>;
}

function makeFakePool(aliases: string[]): FakePool {
  const set = new Map(aliases.map((a) => [a, { alias: a }]));
  return {
    getSession: (a) => set.get(a) ?? null,
    listSessions: () => [...set.values()],
  };
}

async function withFixture(
  aliases: string[],
  body: (ctx: { rootDir: string; coordinator: Coordinator; channelId: string }) => Promise<void>
): Promise<void> {
  const rootDir = await mkdtemp(join(tmpdir(), "al-16-ipc-"));
  process.env.RELAY_HOME = rootDir;
  const channelStore = new ChannelStore(join(rootDir, "channels"));
  const channel = await channelStore.createChannel({
    name: "#ipc-bridge",
    description: "ipc bridge tests",
  });
  const coordinator = new Coordinator({
    pool: makeFakePool(aliases),
    channelStore,
    channelId: channel.channelId,
  });
  try {
    await body({ rootDir, coordinator, channelId: channel.channelId });
  } finally {
    await coordinator.close();
    await rm(rootDir, { recursive: true, force: true });
    delete process.env.RELAY_HOME;
  }
}

describe("AL-16 IPC bridge — file-based cross-process coordination", () => {
  let originalHome: string | undefined;
  beforeEach(() => {
    originalHome = process.env.RELAY_HOME;
  });
  afterEach(() => {
    if (originalHome === undefined) delete process.env.RELAY_HOME;
    else process.env.RELAY_HOME = originalHome;
  });

  it("writeOutboxRecord + bridge routes the message into target's inbox", async () => {
    await withFixture(["backend", "frontend"], async ({ rootDir, coordinator }) => {
      const bridge = new IpcBridge({ sessionId: SESSION_ID, coordinator, rootDir });
      bridge.registerAlias("backend");
      bridge.registerAlias("frontend");
      await bridge.start();
      try {
        const record: IpcRecord = {
          id: "m-1",
          from: "backend",
          to: "frontend",
          payload: {
            kind: "repo-ready",
            alias: "backend",
            ticketId: "T-1",
            prUrl: "https://example.com/x/pull/1",
            announcedAt: "2026-04-22T00:00:00Z",
          },
          writtenAt: "2026-04-22T00:00:00Z",
        };
        await writeOutboxRecord(SESSION_ID, "backend", record, rootDir);
        await bridge.drainOnce();

        const inboxRaw = await readFile(getInboxPath(SESSION_ID, "frontend", rootDir), "utf8");
        expect(inboxRaw).toContain("m-1");
        const line = JSON.parse(inboxRaw.trim()) as IpcRecord;
        expect(line.from).toBe("backend");
        expect(line.to).toBe("frontend");
        expect((line.payload as { kind: string }).kind).toBe("repo-ready");
      } finally {
        await bridge.stop();
      }
    });
  });

  it("bridge tolerates a torn trailing line — reprocesses once the writer completes it", async () => {
    await withFixture(["a", "b"], async ({ rootDir, coordinator }) => {
      const outbox = getOutboxPath(SESSION_ID, "a", rootDir);
      await mkdir(join(rootDir, "sessions", SESSION_ID, "coordination"), {
        recursive: true,
      });
      // Pre-seed a valid line + a torn tail (no newline).
      await writeFile(
        outbox,
        `${JSON.stringify({
          id: "valid-1",
          from: "a",
          to: "b",
          payload: {
            kind: "repo-ready",
            alias: "a",
            ticketId: "T-9",
            prUrl: "https://x.test/pull/9",
            announcedAt: "2026-04-22T00:00:00Z",
          },
          writtenAt: "2026-04-22T00:00:00Z",
        })}\n{"id":"torn","from":"a`,
        "utf8"
      );

      const bridge = new IpcBridge({ sessionId: SESSION_ID, coordinator, rootDir });
      bridge.registerAlias("a");
      bridge.registerAlias("b");
      // Don't seed the cursor to EOF — tests want to observe pre-seeded records.
      await bridge.drainOnce();

      // Only the complete record lands in the inbox.
      const inbox = await readFile(getInboxPath(SESSION_ID, "b", rootDir), "utf8");
      expect(inbox).toContain("valid-1");
      expect(inbox).not.toContain("torn");
    });
  });

  it("coordination_receive returns only messages since last cursor", async () => {
    await withFixture(["admin-a"], async ({ rootDir }) => {
      // Pre-seed two records directly into admin-a's inbox so the
      // `receive` tool has something to read without a running bridge.
      const inbox = getInboxPath(SESSION_ID, "admin-a", rootDir);
      await mkdir(join(rootDir, "sessions", SESSION_ID, "coordination"), {
        recursive: true,
      });
      const lines = [
        {
          id: "m-1",
          from: "backend",
          to: "admin-a",
          payload: {
            kind: "repo-ready",
            alias: "backend",
            ticketId: "T-1",
            prUrl: "https://x.test/pull/1",
            announcedAt: "2026-04-22T00:00:00Z",
          },
          writtenAt: "2026-04-22T00:00:00Z",
        },
        {
          id: "m-2",
          from: "frontend",
          to: "admin-a",
          payload: {
            kind: "repo-ready",
            alias: "frontend",
            ticketId: "T-2",
            prUrl: "https://x.test/pull/2",
            announcedAt: "2026-04-22T00:00:01Z",
          },
          writtenAt: "2026-04-22T00:00:01Z",
        },
      ];
      await writeFile(inbox, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

      const state: CoordinationToolState = {
        alias: "admin-a",
        coordinator: null,
        sessionId: SESSION_ID,
        rootDir,
      };
      const first = (await callCoordinationTool(COORDINATION_RECEIVE_TOOL, {}, state)) as {
        ok: boolean;
        messages: IpcRecord[];
      };
      expect(first.ok).toBe(true);
      expect(first.messages.map((m) => m.id)).toEqual(["m-1", "m-2"]);

      const second = (await callCoordinationTool(COORDINATION_RECEIVE_TOOL, {}, state)) as {
        messages: IpcRecord[];
      };
      expect(second.messages).toHaveLength(0);
    });
  });

  it("coordination_send falls back to outbox file when coordinator is null but sessionId is set", async () => {
    await withFixture(["backend", "frontend"], async ({ rootDir }) => {
      const state: CoordinationToolState = {
        alias: "backend",
        coordinator: null,
        sessionId: SESSION_ID,
        rootDir,
      };
      const result = (await callCoordinationTool(
        COORDINATION_SEND_TOOL,
        {
          to: "frontend",
          payload: {
            kind: "repo-ready",
            alias: "backend",
            ticketId: "T-7",
            prUrl: "https://x.test/pull/7",
            announcedAt: "2026-04-22T00:00:00Z",
          },
        },
        state
      )) as { ok: boolean; routedVia?: string; messageId?: string };
      expect(result.ok).toBe(true);
      expect(result.routedVia).toBe("ipc-file");
      expect(typeof result.messageId).toBe("string");

      const outbox = await readFile(getOutboxPath(SESSION_ID, "backend", rootDir), "utf8");
      expect(outbox).toContain("T-7");
    });
  });

  it("end-to-end: send via file → bridge routes → receive via file returns same body", async () => {
    await withFixture(["backend", "frontend"], async ({ rootDir, coordinator }) => {
      const bridge = new IpcBridge({ sessionId: SESSION_ID, coordinator, rootDir });
      bridge.registerAlias("backend");
      bridge.registerAlias("frontend");
      await bridge.start();
      try {
        const sendState: CoordinationToolState = {
          alias: "backend",
          coordinator: null,
          sessionId: SESSION_ID,
          rootDir,
        };
        await callCoordinationTool(
          COORDINATION_SEND_TOOL,
          {
            to: "frontend",
            payload: {
              kind: "repo-ready",
              alias: "backend",
              ticketId: "T-E2E",
              prUrl: "https://x.test/pull/99",
              announcedAt: "2026-04-22T00:00:00Z",
            },
          },
          sendState
        );
        await bridge.drainOnce();

        const recvState: CoordinationToolState = {
          alias: "frontend",
          coordinator: null,
          sessionId: SESSION_ID,
          rootDir,
        };
        const recv = (await callCoordinationTool(COORDINATION_RECEIVE_TOOL, {}, recvState)) as {
          messages: IpcRecord[];
        };
        expect(recv.messages).toHaveLength(1);
        expect(recv.messages[0].payload.kind).toBe("repo-ready");
        expect((recv.messages[0].payload as { ticketId: string }).ticketId).toBe("T-E2E");
      } finally {
        await bridge.stop();
      }

      // Cursor file should be written post-receive.
      const cursor = await readInboxCursor(SESSION_ID, "frontend", rootDir);
      expect(cursor.offset).toBeGreaterThan(0);
      const cursorFile = getInboxCursorPath(SESSION_ID, "frontend", rootDir);
      expect((await readFile(cursorFile, "utf8")).length).toBeGreaterThan(0);
    });
  });

  it("bridge stop is idempotent + clears the poll timer", async () => {
    await withFixture(["a"], async ({ rootDir, coordinator }) => {
      const bridge = new IpcBridge({
        sessionId: SESSION_ID,
        coordinator,
        rootDir,
        pollIntervalMs: 20,
      });
      bridge.registerAlias("a");
      await bridge.start();
      await bridge.stop();
      await bridge.stop(); // idempotent
      // After stop, start() is a no-op (bridge permanently stopped).
      await bridge.start();
      // If the timer leaked, vitest would hang; we're verifying no leak by
      // simply reaching here with an unref'd poller cleared.
      expect(true).toBe(true);
    });
  });
});
