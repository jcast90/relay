import { z } from "zod";

export const PrStageSchema = z.enum([
  "branch_created",
  "commits_pushed",
  "pr_opened",
  "checks_running",
  "checks_passed",
  "checks_failed",
  "review_requested",
  "changes_requested",
  "approved",
  "merged",
  "closed"
]);

export type PrStage = z.infer<typeof PrStageSchema>;

export const PrEventSchema = z.object({
  stage: PrStageSchema,
  timestamp: z.string(),
  details: z.record(z.string()).default({})
});

export type PrEvent = z.infer<typeof PrEventSchema>;

export const PrLifecycleSchema = z.object({
  runId: z.string(),
  branch: z.string(),
  baseBranch: z.string().default("main"),
  prNumber: z.number().nullable().default(null),
  prUrl: z.string().nullable().default(null),
  currentStage: PrStageSchema,
  events: z.array(PrEventSchema),
  createdAt: z.string(),
  updatedAt: z.string()
});

export type PrLifecycle = z.infer<typeof PrLifecycleSchema>;

export function createPrLifecycle(input: {
  runId: string;
  branch: string;
  baseBranch?: string;
}): PrLifecycle {
  const now = new Date().toISOString();

  return {
    runId: input.runId,
    branch: input.branch,
    baseBranch: input.baseBranch ?? "main",
    prNumber: null,
    prUrl: null,
    currentStage: "branch_created",
    events: [
      {
        stage: "branch_created",
        timestamp: now,
        details: { branch: input.branch }
      }
    ],
    createdAt: now,
    updatedAt: now
  };
}

export function advancePrStage(
  lifecycle: PrLifecycle,
  stage: PrStage,
  details?: Record<string, string>
): PrLifecycle {
  const now = new Date().toISOString();

  return {
    ...lifecycle,
    currentStage: stage,
    prNumber: details?.prNumber ? Number(details.prNumber) : lifecycle.prNumber,
    prUrl: details?.prUrl ?? lifecycle.prUrl,
    events: [
      ...lifecycle.events,
      {
        stage,
        timestamp: now,
        details: details ?? {}
      }
    ],
    updatedAt: now
  };
}

const VALID_TRANSITIONS: Record<PrStage, PrStage[]> = {
  branch_created: ["commits_pushed"],
  commits_pushed: ["pr_opened", "commits_pushed"],
  pr_opened: ["checks_running", "review_requested", "closed"],
  checks_running: ["checks_passed", "checks_failed"],
  checks_passed: ["review_requested", "approved", "merged"],
  checks_failed: ["commits_pushed", "closed"],
  review_requested: ["approved", "changes_requested"],
  changes_requested: ["commits_pushed"],
  approved: ["merged", "checks_running"],
  merged: [],
  closed: []
};

export function canTransition(from: PrStage, to: PrStage): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}
