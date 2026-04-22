import { z } from "zod";

import type { PhasePlan } from "./phase-plan.js";
import type { AgentSpecialty } from "./specialty.js";
import type { TicketPlan } from "./ticket.js";

export type AgentRole = "planner" | "implementer" | "reviewer" | "tester";

export type AgentProvider = "codex" | "claude" | "harness";

export type WorkKind =
  | "classify_request"
  | "draft_plan"
  | "generate_design_doc"
  | "decompose_tickets"
  | "classify_failure"
  | "implement_phase"
  | "review_changes"
  | "run_checks";

export const FailureCategorySchema = z.enum(["fix_code", "fix_test", "bad_command_plan"]);

export type FailureCategory = z.infer<typeof FailureCategorySchema>;

export const FailureClassificationSchema = z.object({
  category: FailureCategorySchema,
  rationale: z.string().min(1),
  nextAction: z.string().min(1),
});

export type FailureClassification = z.infer<typeof FailureClassificationSchema>;

export interface AgentCapability {
  role: AgentRole;
  specialties: AgentSpecialty[];
}

export interface WorkRequest {
  runId: string;
  phaseId: string;
  kind: WorkKind;
  specialty: AgentSpecialty;
  title: string;
  objective: string;
  acceptanceCriteria: string[];
  allowedCommands: string[];
  verificationCommands: string[];
  docsToUpdate: string[];
  context: string[];
  artifactContext: string[];
  attempt: number;
  maxAttempts: number;
  priorEvidence: string[];
}

export interface AgentResult {
  summary: string;
  evidence: string[];
  proposedCommands: string[];
  blockers: string[];
  failureClassification?: FailureClassification;
  phasePlan?: PhasePlan;
  ticketPlan?: TicketPlan;
  rawResponse?: string;
}

export interface Agent {
  id: string;
  name: string;
  provider: AgentProvider;
  capability: AgentCapability;
  run(request: WorkRequest): Promise<AgentResult>;
}

export function roleForWork(kind: WorkKind): AgentRole {
  switch (kind) {
    case "classify_request":
      return "planner";
    case "draft_plan":
      return "planner";
    case "generate_design_doc":
      return "planner";
    case "decompose_tickets":
      return "planner";
    case "classify_failure":
      return "implementer";
    case "implement_phase":
      return "implementer";
    case "review_changes":
      return "reviewer";
    case "run_checks":
      return "tester";
  }
}

export const AgentResultSchema = z.object({
  summary: z.string().min(1),
  evidence: z.array(z.string()),
  proposedCommands: z.array(z.string()),
  blockers: z.array(z.string()),
  failureClassification: FailureClassificationSchema.optional(),
  phasePlan: z.unknown().optional(),
});

export const agentResultJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "evidence", "proposedCommands", "blockers"],
  properties: {
    summary: {
      type: "string",
    },
    evidence: {
      type: "array",
      items: { type: "string" },
    },
    proposedCommands: {
      type: "array",
      items: { type: "string" },
    },
    blockers: {
      type: "array",
      items: { type: "string" },
    },
    failureClassification: {
      type: "object",
      additionalProperties: false,
      required: ["category", "rationale", "nextAction"],
      properties: {
        category: {
          type: "string",
          enum: ["fix_code", "fix_test", "bad_command_plan"],
        },
        rationale: {
          type: "string",
        },
        nextAction: {
          type: "string",
        },
      },
    },
    phasePlan: {
      type: "object",
    },
  },
} as const;
