import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ChannelStore } from "../src/channels/channel-store.js";
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

describe("channel ticket board (unified)", () => {
  it("returns [] when no tickets.json exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-board-"));
    const store = new ChannelStore(dir);

    try {
      const channel = await store.createChannel({ name: "#empty", description: "" });
      const tickets = await store.readChannelTickets(channel.channelId);
      expect(tickets).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("round-trips a full ledger via writeChannelTickets", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-board-"));
    const store = new ChannelStore(dir);

    try {
      const channel = await store.createChannel({ name: "#rt", description: "" });
      const ledger = initializeTicketLedger(
        [makeTicket("T-1"), makeTicket("T-2", { dependsOn: ["T-1"] })],
        "run-alpha"
      );

      await store.writeChannelTickets(channel.channelId, ledger);
      const read = await store.readChannelTickets(channel.channelId);

      expect(read).toHaveLength(2);
      expect(read[0].ticketId).toBe("T-1");
      expect(read[0].runId).toBe("run-alpha");
      expect(read[1].status).toBe("blocked");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("upsert replaces existing ticketIds and preserves order", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-board-"));
    const store = new ChannelStore(dir);

    try {
      const channel = await store.createChannel({ name: "#upsert", description: "" });

      // Initial: T-1 ready, T-2 blocked
      const initial = initializeTicketLedger(
        [makeTicket("T-1"), makeTicket("T-2", { dependsOn: ["T-1"] })],
        "run-alpha"
      );
      await store.writeChannelTickets(channel.channelId, initial);

      // Scheduler-style update: T-1 completed
      const completedT1: TicketLedgerEntry = {
        ...initial[0],
        status: "completed",
        completedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const merged = await store.upsertChannelTickets(channel.channelId, [completedT1]);

      expect(merged).toHaveLength(2);
      expect(merged[0].ticketId).toBe("T-1");
      expect(merged[0].status).toBe("completed");
      // T-2 untouched, still in place after T-1
      expect(merged[1].ticketId).toBe("T-2");
      expect(merged[1].status).toBe("blocked");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("upsert appends new tickets in supplied order", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-board-"));
    const store = new ChannelStore(dir);

    try {
      const channel = await store.createChannel({ name: "#append", description: "" });

      // Start with a chat-created ticket (runId=null).
      const chatTickets = initializeTicketLedger([makeTicket("T-chat")], null);
      await store.writeChannelTickets(channel.channelId, chatTickets);

      // Orchestrator run adds two more.
      const runTickets = initializeTicketLedger(
        [makeTicket("T-1"), makeTicket("T-2", { dependsOn: ["T-1"] })],
        "run-beta"
      );
      const merged = await store.upsertChannelTickets(channel.channelId, runTickets);

      expect(merged.map((t) => t.ticketId)).toEqual(["T-chat", "T-1", "T-2"]);
      expect(merged[0].runId).toBeNull();
      expect(merged[1].runId).toBe("run-beta");
      expect(merged[2].runId).toBe("run-beta");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
