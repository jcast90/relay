import { describe, expect, it, vi } from "vitest";

import type { HarnessRun } from "../../src/domain/run.js";
import type { TicketDefinition } from "../../src/domain/ticket.js";
import {
  SchedulerFollowUpDispatcher,
  buildFollowUpTicketId
} from "../../src/integrations/scheduler-follow-up-dispatcher.js";
import type {
  FollowUpKind,
  FollowUpRequest
} from "../../src/integrations/pr-poller.js";

function makeRun(): HarnessRun {
  const now = new Date().toISOString();
  return {
    id: "run-fu",
    featureRequest: "feature",
    state: "TICKETS_EXECUTING",
    startedAt: now,
    updatedAt: now,
    completedAt: null,
    channelId: null,
    classification: null,
    plan: null,
    ticketPlan: null,
    events: [],
    evidence: [],
    artifacts: [],
    phaseLedger: [],
    phaseLedgerPath: null,
    ticketLedger: [],
    ticketLedgerPath: null,
    runIndexPath: null
  };
}

function request(overrides: Partial<FollowUpRequest> = {}): FollowUpRequest {
  const kind: FollowUpKind = overrides.kind ?? "fix-ci";
  return {
    kind,
    parentTicketId: overrides.parentTicketId ?? "ticket_01",
    channelId: overrides.channelId ?? "chan-1",
    pr: overrides.pr ?? {
      number: 7,
      url: "https://github.com/acme/widgets/pull/7",
      branch: "feat/7"
    },
    repo: overrides.repo ?? { owner: "acme", name: "widgets" },
    title: overrides.title ?? `${kind}: acme/widgets#7`,
    prompt: overrides.prompt ?? "Investigate and fix the failing CI run."
  };
}

describe("SchedulerFollowUpDispatcher", () => {
  it("synthesizes a ticket and forwards it to scheduler.enqueue", async () => {
    const run = makeRun();
    const enqueue = vi.fn(
      async (_r: HarnessRun, _t: TicketDefinition) => undefined
    );
    const dispatcher = new SchedulerFollowUpDispatcher({
      scheduler: { enqueue },
      run
    });

    const req = request({
      kind: "fix-ci",
      parentTicketId: "ticket_42",
      title: "fix-ci: acme/widgets#7",
      prompt: "CI is failing; reproduce and push a fix to feat/7."
    });

    const ticketId = await dispatcher.enqueueFollowUp(req);

    expect(enqueue).toHaveBeenCalledTimes(1);
    const [passedRun, passedTicket] = enqueue.mock.calls[0]!;
    expect(passedRun).toBe(run);

    expect(ticketId).toBe(buildFollowUpTicketId(req));
    expect(ticketId).toContain("fix-ci");
    expect(ticketId).toContain("ticket_42");

    expect(passedTicket.id).toBe(ticketId);
    expect(passedTicket.title).toBe(req.title);
    expect(passedTicket.objective).toBe(req.prompt);
    expect(passedTicket.specialty).toBe("general");
    expect(passedTicket.dependsOn).toEqual([]);
    expect(passedTicket.acceptanceCriteria.length).toBeGreaterThan(0);
    expect(passedTicket.retryPolicy.maxAgentAttempts).toBeGreaterThanOrEqual(1);
    expect(passedTicket.retryPolicy.maxTestFixLoops).toBeGreaterThanOrEqual(1);
  });

  it("uses a distinct acceptance line for address-reviews follow-ups", async () => {
    const run = makeRun();
    const enqueue = vi.fn(
      async (_r: HarnessRun, _t: TicketDefinition) => undefined
    );
    const dispatcher = new SchedulerFollowUpDispatcher({
      scheduler: { enqueue },
      run
    });

    const req = request({
      kind: "address-reviews",
      parentTicketId: "ticket_99",
      title: "address-reviews: acme/widgets#7"
    });

    await dispatcher.enqueueFollowUp(req);

    const [, ticket] = enqueue.mock.calls[0]!;
    expect(ticket.id).toBe(buildFollowUpTicketId(req));
    expect(ticket.id).toContain("address-reviews");
    expect(ticket.acceptanceCriteria.join(" ").toLowerCase()).toContain(
      "comments"
    );
  });

  it("produces stable ids per (parentTicketId, kind) pair", () => {
    const a = buildFollowUpTicketId(
      request({ kind: "fix-ci", parentTicketId: "x" })
    );
    const b = buildFollowUpTicketId(
      request({ kind: "fix-ci", parentTicketId: "x" })
    );
    const c = buildFollowUpTicketId(
      request({ kind: "address-reviews", parentTicketId: "x" })
    );
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
