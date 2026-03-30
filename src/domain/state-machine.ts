import type { RunEventType, RunState } from "./run.js";

const transitions: Record<RunState, Partial<Record<RunEventType, RunState>>> = {
  DRAFT_PLAN: {
    PlanGenerated: "PLAN_REVIEW"
  },
  PLAN_REVIEW: {
    PlanAccepted: "PHASE_READY"
  },
  PHASE_READY: {
    PhaseStarted: "PHASE_EXECUTE",
    NoPhasesRemain: "COMPLETE"
  },
  PHASE_EXECUTE: {
    PatchGenerated: "TEST_FIX_LOOP",
    NoProgressDetected: "BLOCKED"
  },
  TEST_FIX_LOOP: {
    ChecksPassed: "REVIEW_FIX_LOOP",
    ChecksFailedRecoverable: "PHASE_EXECUTE",
    ChecksFailedNonRecoverable: "FAILED"
  },
  REVIEW_FIX_LOOP: {
    ReviewResolved: "PHASE_READY"
  },
  COMPLETE: {},
  BLOCKED: {},
  FAILED: {}
};

export function getNextState(
  currentState: RunState,
  eventType: RunEventType
): RunState | null {
  return transitions[currentState][eventType] ?? null;
}

export function assertTransition(
  currentState: RunState,
  eventType: RunEventType
): RunState {
  const nextState = getNextState(currentState, eventType);

  if (!nextState) {
    throw new Error(
      `Invalid transition: state=${currentState} event=${eventType}`
    );
  }

  return nextState;
}
