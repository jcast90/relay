import type {
  AgentProvider,
  FailureCategory,
  WorkKind
} from "./agent.js";
import type { PhasePlan } from "./phase-plan.js";

export type RunState =
  | "DRAFT_PLAN"
  | "PLAN_REVIEW"
  | "PHASE_READY"
  | "PHASE_EXECUTE"
  | "TEST_FIX_LOOP"
  | "REVIEW_FIX_LOOP"
  | "COMPLETE"
  | "BLOCKED"
  | "FAILED";

export type RunEventType =
  | "TaskSubmitted"
  | "AgentDispatched"
  | "AgentCompleted"
  | "AgentFailed"
  | "AgentRetried"
  | "CommandStarted"
  | "CommandCompleted"
  | "CommandRejected"
  | "ArtifactCaptured"
  | "FailureClassified"
  | "PlanGenerated"
  | "PlanAccepted"
  | "PhaseStarted"
  | "PatchGenerated"
  | "ChecksPassed"
  | "ChecksFailedRecoverable"
  | "ChecksFailedNonRecoverable"
  | "ReviewResolved"
  | "NoPhasesRemain"
  | "NoProgressDetected";

export interface RunEvent {
  type: RunEventType;
  createdAt: string;
  phaseId: string;
  details: Record<string, string>;
}

export interface EvidenceRecord {
  phaseId: string;
  agentId: string;
  provider: AgentProvider;
  workKind: WorkKind;
  attempt: number;
  summary: string;
  evidence: string[];
  proposedCommands: string[];
  blockers: string[];
}

export interface CommandResultArtifactRecord {
  artifactId: string;
  phaseId: string;
  type: "command_result";
  path: string;
  command: string;
  exitCode: number;
}

export interface FailureClassificationArtifactRecord {
  artifactId: string;
  phaseId: string;
  type: "failure_classification";
  path: string;
  category: FailureCategory;
  rationale: string;
  nextAction: string;
}

export type ArtifactRecord =
  | CommandResultArtifactRecord
  | FailureClassificationArtifactRecord;

export type VerificationStatus =
  | "pending"
  | "running"
  | "passed"
  | "failed_recoverable"
  | "failed_terminal";

export interface PhaseLedgerEntry {
  phaseId: string;
  title: string;
  specialty: PhasePlan["phases"][number]["specialty"];
  lifecycle: "pending" | "implementing" | "reviewing" | "completed" | "failed";
  verification: VerificationStatus;
  lastClassification: {
    category: FailureCategory;
    rationale: string;
    nextAction: string;
  } | null;
  chosenNextAction: string | null;
  updatedAt: string;
}

export interface RunIndexEntry {
  runId: string;
  featureRequest: string;
  state: RunState;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  phaseLedgerPath: string | null;
  artifactsRoot: string;
}

export interface HarnessRun {
  id: string;
  featureRequest: string;
  state: RunState;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  plan: PhasePlan | null;
  events: RunEvent[];
  evidence: EvidenceRecord[];
  artifacts: ArtifactRecord[];
  phaseLedger: PhaseLedgerEntry[];
  phaseLedgerPath: string | null;
  runIndexPath: string | null;
}
