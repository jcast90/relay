import { z } from "zod";

import { AgentSpecialtySchema } from "./specialty.js";

export const ComplexityTierSchema = z.enum([
  "trivial",
  "bugfix",
  "feature_small",
  "feature_large",
  "architectural",
  "multi_repo"
]);

export type ComplexityTier = z.infer<typeof ComplexityTierSchema>;

export const ClassificationResultSchema = z.object({
  tier: ComplexityTierSchema,
  rationale: z.string().min(1),
  suggestedSpecialties: z.array(AgentSpecialtySchema),
  estimatedTicketCount: z.number().int().min(1).max(50),
  needsDesignDoc: z.boolean(),
  needsUserApproval: z.boolean(),
  crosslinkRepos: z.array(z.string()).default([]),
  /**
   * Branch name suggested by a tracker plugin (GitHub/Linear) when the request
   * was an issue URL or bare Linear identifier. Purely advisory — callers may
   * use it to seed worktree names for downstream tickets.
   */
  suggestedBranch: z.string().optional()
});

export type ClassificationResult = z.infer<typeof ClassificationResultSchema>;

export function parseClassificationResult(input: unknown): ClassificationResult {
  return ClassificationResultSchema.parse(input);
}

export const classificationResultJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "tier",
    "rationale",
    "suggestedSpecialties",
    "estimatedTicketCount",
    "needsDesignDoc",
    "needsUserApproval"
  ],
  properties: {
    tier: {
      type: "string",
      enum: [
        "trivial",
        "bugfix",
        "feature_small",
        "feature_large",
        "architectural",
        "multi_repo"
      ]
    },
    rationale: { type: "string" },
    suggestedSpecialties: {
      type: "array",
      items: {
        type: "string",
        enum: ["general", "ui", "business_logic", "api_crud", "devops", "testing"]
      }
    },
    estimatedTicketCount: {
      type: "integer",
      minimum: 1,
      maximum: 50
    },
    needsDesignDoc: { type: "boolean" },
    needsUserApproval: { type: "boolean" },
    crosslinkRepos: {
      type: "array",
      items: { type: "string" }
    }
  }
} as const;

export function tierNeedsApproval(tier: ComplexityTier): boolean {
  return tier === "feature_large" || tier === "architectural" || tier === "multi_repo";
}

export function tierNeedsDesignDoc(tier: ComplexityTier): boolean {
  return tier === "architectural";
}

export function tierSkipsPlanning(tier: ComplexityTier): boolean {
  return tier === "trivial";
}
