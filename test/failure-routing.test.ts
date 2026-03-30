import { describe, expect, it } from "vitest";

import {
  buildRetryContext,
  buildRetryObjective,
  fallbackFailureClassification,
  isVerificationPlanIssue
} from "../src/orchestrator/failure-routing.js";

describe("failure routing", () => {
  it("builds repair objectives from classifications", () => {
    expect(
      buildRetryObjective("Repair the phase.", {
        category: "fix_code",
        rationale: "Code path failed.",
        nextAction: "Fix product logic."
      })
    ).toContain("product or business logic");

    expect(
      buildRetryObjective("Repair the phase.", {
        category: "fix_test",
        rationale: "Tests failed.",
        nextAction: "Fix tests."
      })
    ).toContain("tests, fixtures, mocks");
  });

  it("falls back to bad command plan when command-plan signals exist", () => {
    expect(
      fallbackFailureClassification({
        artifactContext: ["STDERR:\ncommand not found: pnpmx"],
        rejectedCommands: []
      }).category
    ).toBe("bad_command_plan");
  });

  it("marks bad command plan as a verification-plan issue", () => {
    expect(isVerificationPlanIssue("bad_command_plan")).toBe(true);
    expect(buildRetryContext({
      category: "bad_command_plan",
      rationale: "Allowlist mismatch.",
      nextAction: "Repair command plan."
    })[0]).toContain("bad_command_plan");
  });
});
