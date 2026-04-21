import { z } from "zod";

import { ClassificationResultSchema, type ClassificationResult } from "./classification.js";
import { RetryPolicySchema } from "./phase-plan.js";
import type { FailureCategory } from "./agent.js";
import { AgentSpecialtySchema, type AgentSpecialty } from "./specialty.js";
import type { VerificationStatus } from "./run.js";

export const TicketStatusSchema = z.enum([
  "pending",
  "blocked",
  "ready",
  "executing",
  "verifying",
  "retry",
  "completed",
  "failed"
]);

export type TicketStatus = z.infer<typeof TicketStatusSchema>;

export const TicketDefinitionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  objective: z.string().min(1),
  specialty: AgentSpecialtySchema,
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  allowedCommands: z.array(z.string()).default([]),
  verificationCommands: z.array(z.string()).default([]),
  docsToUpdate: z.array(z.string()).default([]),
  dependsOn: z.array(z.string()).default([]),
  retryPolicy: RetryPolicySchema
});

export type TicketDefinition = z.infer<typeof TicketDefinitionSchema>;

export const TicketPlanSchema = z.object({
  version: z.literal(1),
  task: z.object({
    title: z.string().min(1),
    featureRequest: z.string().min(1),
    repoRoot: z.string().min(1)
  }),
  classification: ClassificationResultSchema,
  tickets: z.array(TicketDefinitionSchema).min(1),
  finalVerification: z.object({
    commands: z.array(z.string()).default([])
  }),
  docsToUpdate: z.array(z.string()).default([])
});

export type TicketPlan = z.infer<typeof TicketPlanSchema>;

export function parseTicketPlan(input: unknown): TicketPlan {
  return TicketPlanSchema.parse(input);
}

export interface TicketLedgerEntry {
  ticketId: string;
  title: string;
  specialty: AgentSpecialty;
  status: TicketStatus;
  dependsOn: string[];
  assignedAgentId: string | null;
  assignedAgentName: string | null;
  crosslinkSessionId: string | null;
  verification: VerificationStatus;
  lastClassification: {
    category: FailureCategory;
    rationale: string;
    nextAction: string;
  } | null;
  chosenNextAction: string | null;
  attempt: number;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
  /**
   * ID of the orchestrator run that produced this entry; null when the
   * ticket was created directly via chat rather than run decomposition.
   * Set at `initializeTicketLedger` and not rewritten afterward — `upsert`
   * replaces the full entry, so downstream stages that stamp a new runId
   * must do so by re-initializing, not by patching this field in place.
   */
  runId: string | null;
  /**
   * Optional alias of the repo (from `Channel.repoAssignments[].alias`) this
   * ticket should be routed to. When set, the orchestrator / spawner uses
   * the matching repo assignment to pick the target workspace for the
   * ticket's agent. When unset, callers fall back to the channel's primary
   * repo (via `ChannelStore.getPrimaryAssignment`). Optional for back-compat
   * with ticket files written before per-repo routing existed.
   */
  assignedAlias?: string;
}

export function initializeTicketLedger(
  tickets: TicketDefinition[],
  runId: string | null = null
): TicketLedgerEntry[] {
  const now = new Date().toISOString();

  return tickets.map((ticket) => ({
    ticketId: ticket.id,
    title: ticket.title,
    specialty: ticket.specialty,
    status: ticket.dependsOn.length > 0 ? "blocked" as const : "ready" as const,
    dependsOn: ticket.dependsOn,
    assignedAgentId: null,
    assignedAgentName: null,
    crosslinkSessionId: null,
    verification: "pending" as const,
    lastClassification: null,
    chosenNextAction: null,
    attempt: 0,
    startedAt: null,
    completedAt: null,
    updatedAt: now,
    runId
  }));
}

export function getReadyTickets(ledger: TicketLedgerEntry[]): TicketLedgerEntry[] {
  const completedIds = new Set(
    ledger.filter((t) => t.status === "completed").map((t) => t.ticketId)
  );

  return ledger.filter((entry) => {
    if (entry.status !== "ready" && entry.status !== "blocked") {
      return false;
    }

    return entry.dependsOn.every((dep) => completedIds.has(dep));
  });
}

export function validateTicketDag(tickets: TicketDefinition[]): {
  valid: boolean;
  order: string[];
  cycle: string[] | null;
} {
  const ids = new Set(tickets.map((t) => t.id));
  const adjacency = new Map<string, string[]>();
  const inDegree = new Map<string, number>();

  for (const ticket of tickets) {
    adjacency.set(ticket.id, []);
    inDegree.set(ticket.id, 0);
  }

  for (const ticket of tickets) {
    for (const dep of ticket.dependsOn) {
      if (!ids.has(dep)) {
        continue;
      }

      adjacency.get(dep)!.push(ticket.id);
      inDegree.set(ticket.id, (inDegree.get(ticket.id) ?? 0) + 1);
    }
  }

  const queue: string[] = [];

  for (const [id, degree] of inDegree) {
    if (degree === 0) {
      queue.push(id);
    }
  }

  const order: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    order.push(current);

    for (const neighbor of adjacency.get(current) ?? []) {
      const newDegree = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDegree);

      if (newDegree === 0) {
        queue.push(neighbor);
      }
    }
  }

  if (order.length === tickets.length) {
    return { valid: true, order, cycle: null };
  }

  const remaining = tickets
    .filter((t) => !order.includes(t.id))
    .map((t) => t.id);

  return { valid: false, order, cycle: remaining };
}

export function linearizeTickets(tickets: TicketDefinition[]): TicketDefinition[] {
  return tickets.map((ticket, index) => ({
    ...ticket,
    dependsOn: index > 0 ? [tickets[index - 1].id] : []
  }));
}

export const ticketPlanJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["version", "task", "classification", "tickets", "finalVerification", "docsToUpdate"],
  properties: {
    version: { type: "integer", enum: [1] },
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
    classification: {
      type: "object",
      additionalProperties: false,
      required: ["tier", "rationale", "suggestedSpecialties", "estimatedTicketCount", "needsDesignDoc", "needsUserApproval"],
      properties: {
        tier: { type: "string", enum: ["trivial", "bugfix", "feature_small", "feature_large", "architectural", "multi_repo"] },
        rationale: { type: "string" },
        suggestedSpecialties: { type: "array", items: { type: "string" } },
        estimatedTicketCount: { type: "integer", minimum: 1, maximum: 50 },
        needsDesignDoc: { type: "boolean" },
        needsUserApproval: { type: "boolean" }
      }
    },
    tickets: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "title", "objective", "specialty", "acceptanceCriteria", "retryPolicy"],
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          objective: { type: "string" },
          specialty: { type: "string", enum: ["general", "ui", "business_logic", "api_crud", "devops", "testing"] },
          acceptanceCriteria: { type: "array", minItems: 1, items: { type: "string" } },
          allowedCommands: { type: "array", items: { type: "string" } },
          verificationCommands: { type: "array", items: { type: "string" } },
          docsToUpdate: { type: "array", items: { type: "string" } },
          dependsOn: { type: "array", items: { type: "string" } },
          retryPolicy: {
            type: "object",
            additionalProperties: false,
            required: ["maxAgentAttempts", "maxTestFixLoops"],
            properties: {
              maxAgentAttempts: { type: "integer", minimum: 1, maximum: 5 },
              maxTestFixLoops: { type: "integer", minimum: 1, maximum: 10 }
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
        commands: { type: "array", items: { type: "string" } }
      }
    },
    docsToUpdate: { type: "array", items: { type: "string" } }
  }
} as const;
