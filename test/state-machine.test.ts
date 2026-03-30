import { describe, expect, it } from "vitest";

import { assertTransition, getNextState } from "../src/domain/state-machine.js";

describe("state machine", () => {
  it("moves from planning into phase execution", () => {
    expect(getNextState("DRAFT_PLAN", "PlanGenerated")).toBe("PLAN_REVIEW");
    expect(getNextState("PLAN_REVIEW", "PlanAccepted")).toBe("PHASE_READY");
    expect(getNextState("PHASE_READY", "PhaseStarted")).toBe("PHASE_EXECUTE");
  });

  it("can fail a phase when verification budget is exhausted", () => {
    expect(getNextState("TEST_FIX_LOOP", "ChecksFailedNonRecoverable")).toBe(
      "FAILED"
    );
  });

  it("throws for invalid transitions", () => {
    expect(() => assertTransition("DRAFT_PLAN", "ChecksPassed")).toThrow(
      /Invalid transition/
    );
  });
});
