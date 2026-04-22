import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ChannelStore } from "../src/channels/channel-store.js";
import { callChannelTool, type ChannelToolState } from "../src/mcp/channel-tools.js";
import { initializeTicketLedger } from "../src/domain/ticket.js";
import type { TicketDefinition, TicketLedgerEntry } from "../src/domain/ticket.js";

function makeTicket(id: string, overrides: Partial<TicketDefinition> = {}): TicketDefinition {
  return {
    id,
    title: `Ticket ${id}`,
    objective: `Objective ${id}`,
    specialty: "general",
    acceptanceCriteria: [`AC for ${id}`],
    allowedCommands: [],
    verificationCommands: [],
    docsToUpdate: [],
    dependsOn: [],
    retryPolicy: { maxAgentAttempts: 1, maxTestFixLoops: 1 },
    ...overrides,
  };
}

interface BoardResult {
  channelId: string;
  board: Record<string, Array<{ ticketId: string; title: string; runId: string | null }>>;
}

describe("channel_task_board MCP tool — unified + fallback", () => {
  it("returns an empty board when the channel has neither tickets.json nor runs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ctb-empty-"));
    const channelStore = new ChannelStore(dir);
    const channel = await channelStore.createChannel({
      name: "#empty",
      description: "",
    });

    try {
      const state: ChannelToolState = { sessionId: null, channelStore };
      const result = (await callChannelTool(
        "channel_task_board",
        { channelId: channel.channelId },
        state
      )) as BoardResult;

      expect(result.channelId).toBe(channel.channelId);
      expect(result.board).toEqual({});
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reads from the channel file when it is populated and skips the run-link fallback", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ctb-populated-"));
    const channelStore = new ChannelStore(dir);
    const channel = await channelStore.createChannel({
      name: "#populated",
      description: "",
    });

    try {
      // Populate the channel file with a mix of chat (runId=null) + orchestrator (runId set).
      const ledger: TicketLedgerEntry[] = [
        ...initializeTicketLedger([makeTicket("T-chat")], null),
        ...initializeTicketLedger([makeTicket("T-run")], "run-alpha"),
      ];
      await channelStore.writeChannelTickets(channel.channelId, ledger);

      // Deliberately also link a run that does NOT have a real artifact store —
      // if the fallback ever activates, we'd see a crash or missing ticket.
      // The unified-read path must ignore the run link entirely when the
      // channel file is non-empty.
      await channelStore.linkRun(channel.channelId, "ghost-run", "ghost-workspace");

      const state: ChannelToolState = { sessionId: null, channelStore };
      const result = (await callChannelTool(
        "channel_task_board",
        { channelId: channel.channelId },
        state
      )) as BoardResult;

      // Both tickets should be in the ready bucket (no deps, status initialized
      // to "ready"). runId nulls and strings both preserved.
      const readyBucket = result.board.ready ?? [];
      const ids = readyBucket.map((t) => t.ticketId).sort();
      expect(ids).toEqual(["T-chat", "T-run"]);
      const byId = new Map(readyBucket.map((t) => [t.ticketId, t]));
      expect(byId.get("T-chat")?.runId).toBeNull();
      expect(byId.get("T-run")?.runId).toBe("run-alpha");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("propagates corruption from readChannelTickets instead of silently falling back", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ctb-corrupt-"));
    const channelStore = new ChannelStore(dir);
    const channel = await channelStore.createChannel({
      name: "#corrupt",
      description: "",
    });

    try {
      // Write a malformed file — this should surface as an error, not an
      // empty array that would erase data via downstream upsert.
      const { writeFile, mkdir } = await import("node:fs/promises");
      const chanDir = join(dir, channel.channelId);
      await mkdir(chanDir, { recursive: true });
      await writeFile(join(chanDir, "tickets.json"), "{this is not json");

      const state: ChannelToolState = { sessionId: null, channelStore };
      await expect(
        callChannelTool("channel_task_board", { channelId: channel.channelId }, state)
      ).rejects.toThrow(/Corrupt channel ticket board/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
