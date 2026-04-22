import { describe, expect, it } from "vitest";

import { createSeedPlan, parsePhasePlan } from "../src/domain/phase-plan.js";

describe("phase plan schema", () => {
  it("creates a valid seed plan", () => {
    const plan = createSeedPlan("Build harness scaffolding", process.cwd());

    expect(plan.version).toBe(1);
    expect(plan.phases).toHaveLength(2);
    expect(plan.phases[0]?.retryPolicy.maxAgentAttempts).toBeGreaterThan(0);
  });

  it("rejects malformed plans", () => {
    expect(() =>
      parsePhasePlan({
        version: 1,
        task: {
          title: "Bad",
          featureRequest: "Missing phases",
          repoRoot: process.cwd(),
        },
        phases: [],
        finalVerification: {
          commands: [],
        },
        docsToUpdate: [],
      })
    ).toThrow();
  });
});
