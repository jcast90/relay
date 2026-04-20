import { describe, expect, it } from "vitest";

import {
  validateTicketDag,
  linearizeTickets,
  getReadyTickets,
  initializeTicketLedger,
  type TicketDefinition
} from "../src/domain/ticket.js";

const retryPolicy = { maxAgentAttempts: 2, maxTestFixLoops: 2 };

function ticket(id: string, deps: string[] = []): TicketDefinition {
  return {
    id,
    title: `Ticket ${id}`,
    objective: `Do ${id}`,
    specialty: "general",
    acceptanceCriteria: ["Done"],
    allowedCommands: [],
    verificationCommands: [],
    docsToUpdate: [],
    dependsOn: deps,
    retryPolicy
  };
}

describe("ticket DAG validation", () => {
  it("validates a valid DAG", () => {
    const tickets = [
      ticket("a"),
      ticket("b", ["a"]),
      ticket("c", ["a"]),
      ticket("d", ["b", "c"])
    ];

    const result = validateTicketDag(tickets);

    expect(result.valid).toBe(true);
    expect(result.order).toHaveLength(4);
    expect(result.order.indexOf("a")).toBeLessThan(result.order.indexOf("b"));
    expect(result.order.indexOf("a")).toBeLessThan(result.order.indexOf("c"));
    expect(result.order.indexOf("b")).toBeLessThan(result.order.indexOf("d"));
    expect(result.cycle).toBeNull();
  });

  it("detects a cycle", () => {
    const tickets = [
      ticket("a", ["c"]),
      ticket("b", ["a"]),
      ticket("c", ["b"])
    ];

    const result = validateTicketDag(tickets);

    expect(result.valid).toBe(false);
    expect(result.cycle).not.toBeNull();
    expect(result.cycle!.length).toBeGreaterThan(0);
  });

  it("handles independent tickets (no deps)", () => {
    const tickets = [ticket("a"), ticket("b"), ticket("c")];
    const result = validateTicketDag(tickets);

    expect(result.valid).toBe(true);
    expect(result.order).toHaveLength(3);
  });
});

describe("linearizeTickets", () => {
  it("adds sequential dependencies", () => {
    const tickets = [ticket("a"), ticket("b"), ticket("c")];
    const linear = linearizeTickets(tickets);

    expect(linear[0].dependsOn).toEqual([]);
    expect(linear[1].dependsOn).toEqual(["a"]);
    expect(linear[2].dependsOn).toEqual(["b"]);
  });
});

describe("getReadyTickets", () => {
  it("returns tickets with all deps completed", () => {
    const ledger = initializeTicketLedger([
      ticket("a"),
      ticket("b", ["a"]),
      ticket("c")
    ]);

    // a and c should be ready (no deps or deps met)
    const ready = getReadyTickets(ledger);
    const readyIds = ready.map((t) => t.ticketId);

    expect(readyIds).toContain("a");
    expect(readyIds).toContain("c");
    expect(readyIds).not.toContain("b");
  });

  it("unblocks tickets when deps complete", () => {
    const ledger = initializeTicketLedger([
      ticket("a"),
      ticket("b", ["a"])
    ]);

    // Mark a as completed
    ledger[0].status = "completed";

    const ready = getReadyTickets(ledger);
    expect(ready.map((t) => t.ticketId)).toContain("b");
  });
});

describe("initializeTicketLedger", () => {
  it("sets correct initial statuses based on dependencies", () => {
    const ledger = initializeTicketLedger([
      ticket("a"),
      ticket("b", ["a"]),
      ticket("c")
    ]);

    expect(ledger[0].status).toBe("ready");
    expect(ledger[1].status).toBe("blocked");
    expect(ledger[2].status).toBe("ready");
  });

  it("defaults runId to null for chat-created ledgers", () => {
    const ledger = initializeTicketLedger([ticket("a")]);
    expect(ledger[0].runId).toBeNull();
  });

  it("tags every entry with the supplied runId", () => {
    const ledger = initializeTicketLedger([ticket("a"), ticket("b")], "run-abc");
    expect(ledger[0].runId).toBe("run-abc");
    expect(ledger[1].runId).toBe("run-abc");
  });
});
