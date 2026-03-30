import { z } from "zod";

import { AgentSpecialtySchema } from "./specialty.js";

export const RetryPolicySchema = z.object({
  maxAgentAttempts: z.number().int().min(1).max(5),
  maxTestFixLoops: z.number().int().min(1).max(10)
});

export const PhaseDefinitionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  goal: z.string().min(1),
  specialty: AgentSpecialtySchema,
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  allowedCommands: z.array(z.string().min(1)).default([]),
  verificationCommands: z.array(z.string().min(1)).default([]),
  docsToUpdate: z.array(z.string().min(1)).default([]),
  retryPolicy: RetryPolicySchema
});

export const PhasePlanSchema = z.object({
  version: z.literal(1),
  task: z.object({
    title: z.string().min(1),
    featureRequest: z.string().min(1),
    repoRoot: z.string().min(1)
  }),
  phases: z.array(PhaseDefinitionSchema).min(1),
  finalVerification: z.object({
    commands: z.array(z.string().min(1)).default([])
  }),
  docsToUpdate: z.array(z.string().min(1)).default([])
});

export type RetryPolicy = z.infer<typeof RetryPolicySchema>;
export type PhaseDefinition = z.infer<typeof PhaseDefinitionSchema>;
export type PhasePlan = z.infer<typeof PhasePlanSchema>;

export function parsePhasePlan(input: unknown): PhasePlan {
  return PhasePlanSchema.parse(input);
}

export function createSeedPlan(
  featureRequest: string,
  repoRoot: string
): PhasePlan {
  return parsePhasePlan({
    version: 1,
    task: {
      title: "Bootstrap harness scaffolding",
      featureRequest,
      repoRoot
    },
    phases: [
      {
        id: "phase_01",
        title: "Scaffold UI entry points",
        goal: "Create the initial UI-facing surfaces and harness composition root.",
        specialty: "ui",
        acceptanceCriteria: [
          "Create an initial composition root for the harness.",
          "Keep the file layout simple enough for future API wiring."
        ],
        allowedCommands: ["pnpm typecheck"],
        verificationCommands: ["pnpm typecheck"],
        docsToUpdate: ["README.md"],
        retryPolicy: {
          maxAgentAttempts: 2,
          maxTestFixLoops: 2
        }
      },
      {
        id: "phase_02",
        title: "Add business and CRUD seams",
        goal: "Separate orchestration from future provider, storage, and CRUD concerns.",
        specialty: "api_crud",
        acceptanceCriteria: [
          "Create seams for future CRUD and business logic flows.",
          "Keep orchestration independent from provider-specific execution details."
        ],
        allowedCommands: ["pnpm typecheck", "pnpm test"],
        verificationCommands: ["pnpm typecheck", "pnpm test"],
        docsToUpdate: ["README.md"],
        retryPolicy: {
          maxAgentAttempts: 2,
          maxTestFixLoops: 2
        }
      }
    ],
    finalVerification: {
      commands: ["pnpm typecheck", "pnpm test"]
    },
    docsToUpdate: ["README.md"]
  });
}

export const phasePlanJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["version", "task", "phases", "finalVerification", "docsToUpdate"],
  properties: {
    version: {
      type: "integer",
      enum: [1]
    },
    task: {
      type: "object",
      additionalProperties: false,
      required: ["title", "featureRequest", "repoRoot"],
      properties: {
        title: { type: "string" },
        featureRequest: { type: "string" },
        repoRoot: { type: "string" }
      }
    },
    phases: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "title",
          "goal",
          "specialty",
          "acceptanceCriteria",
          "allowedCommands",
          "verificationCommands",
          "docsToUpdate",
          "retryPolicy"
        ],
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          goal: { type: "string" },
          specialty: {
            type: "string",
            enum: ["general", "ui", "business_logic", "api_crud"]
          },
          acceptanceCriteria: {
            type: "array",
            minItems: 1,
            items: { type: "string" }
          },
          allowedCommands: {
            type: "array",
            items: { type: "string" }
          },
          verificationCommands: {
            type: "array",
            items: { type: "string" }
          },
          docsToUpdate: {
            type: "array",
            items: { type: "string" }
          },
          retryPolicy: {
            type: "object",
            additionalProperties: false,
            required: ["maxAgentAttempts", "maxTestFixLoops"],
            properties: {
              maxAgentAttempts: {
                type: "integer",
                minimum: 1,
                maximum: 5
              },
              maxTestFixLoops: {
                type: "integer",
                minimum: 1,
                maximum: 10
              }
            }
          }
        }
      }
    },
    finalVerification: {
      type: "object",
      additionalProperties: false,
      required: ["commands"],
      properties: {
        commands: {
          type: "array",
          items: { type: "string" }
        }
      }
    },
    docsToUpdate: {
      type: "array",
      items: { type: "string" }
    }
  }
} as const;
