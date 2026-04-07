import { describe, expect, it } from "vitest";

import { buildTicketPlanFromPhases } from "../src/orchestrator/ticket-decomposer.js";
import { createSeedPlan } from "../src/domain/phase-plan.js";
import type { ClassificationResult } from "../src/domain/classification.js";

describe("ticket decomposer", () => {
  it("converts a phase plan into a linear ticket plan", () => {
    const plan = createSeedPlan("Test feature", "/tmp/repo");
    const classification: ClassificationResult = {
      tier: "feature_small",
      rationale: "Test",
      suggestedSpecialties: ["general"],
      estimatedTicketCount: 2,
      needsDesignDoc: false,
      needsUserApproval: false,
      crosslinkRepos: []
    };

    const ticketPlan = buildTicketPlanFromPhases(plan, classification);

    expect(ticketPlan.version).toBe(1);
    expect(ticketPlan.tickets).toHaveLength(2);
    expect(ticketPlan.tickets[0].id).toBe("ticket_01");
    expect(ticketPlan.tickets[0].dependsOn).toEqual([]);
    expect(ticketPlan.tickets[1].id).toBe("ticket_02");
    expect(ticketPlan.tickets[1].dependsOn).toEqual(["ticket_01"]);
    expect(ticketPlan.classification.tier).toBe("feature_small");
  });

  it("preserves phase verification commands in tickets", () => {
    const plan = createSeedPlan("Test feature", "/tmp/repo");
    const classification: ClassificationResult = {
      tier: "feature_small",
      rationale: "Test",
      suggestedSpecialties: ["general"],
      estimatedTicketCount: 2,
      needsDesignDoc: false,
      needsUserApproval: false,
      crosslinkRepos: []
    };

    const ticketPlan = buildTicketPlanFromPhases(plan, classification);

    expect(ticketPlan.tickets[0].verificationCommands).toContain("pnpm typecheck");
    expect(ticketPlan.tickets[1].verificationCommands).toContain("pnpm test");
  });
});
