/**
 * Bridge between the PR poller's `FollowUpDispatcher` interface and the
 * `TicketScheduler.enqueue` surface.
 *
 * The poller produces `FollowUpRequest`s (CI failures, review rework). This
 * dispatcher synthesizes a minimal `TicketDefinition` for each request and
 * hands it to the scheduler, which lands it on the run's ticket ledger and
 * kicks off execution under the existing concurrency cap.
 *
 * Keep the synthesized ticket deliberately small: the scheduler only needs
 * enough shape to dispatch work to whatever agent/worker the run already has
 * configured. Any richer prompting/context should live in the poller.
 */
import type { HarnessRun } from "../domain/run.js";
import type { TicketDefinition } from "../domain/ticket.js";
import type { TicketScheduler } from "../orchestrator/ticket-scheduler.js";
import type {
  FollowUpDispatcher,
  FollowUpRequest
} from "./pr-poller.js";

export interface SchedulerFollowUpDispatcherOptions {
  scheduler: Pick<TicketScheduler, "enqueue">;
  run: HarnessRun;
}

const DEFAULT_RETRY_POLICY = {
  maxAgentAttempts: 2,
  maxTestFixLoops: 2
} as const;

export class SchedulerFollowUpDispatcher implements FollowUpDispatcher {
  private readonly scheduler: Pick<TicketScheduler, "enqueue">;
  private readonly run: HarnessRun;

  constructor(options: SchedulerFollowUpDispatcherOptions) {
    this.scheduler = options.scheduler;
    this.run = options.run;
  }

  async enqueueFollowUp(request: FollowUpRequest): Promise<string> {
    const ticket = this.buildTicket(request);
    await this.scheduler.enqueue(this.run, ticket);
    return ticket.id;
  }

  private buildTicket(request: FollowUpRequest): TicketDefinition {
    return {
      id: buildFollowUpTicketId(request),
      title: request.title,
      objective: request.prompt,
      specialty: "general",
      acceptanceCriteria: [
        request.kind === "fix-ci"
          ? "CI checks on the PR are passing after the follow-up commits."
          : "All reviewer comments on the PR are addressed and resolved."
      ],
      allowedCommands: [],
      verificationCommands: [],
      docsToUpdate: [],
      // Follow-ups are independent executions — they intentionally don't
      // block on the parent ticket, which by this point has already produced
      // a PR and moved on.
      dependsOn: [],
      retryPolicy: DEFAULT_RETRY_POLICY
    };
  }
}

/**
 * Stable id so repeated fires for the same (parent, kind) pair are idempotent
 * from the scheduler's perspective (it de-dupes by ticket id on enqueue).
 */
export function buildFollowUpTicketId(request: FollowUpRequest): string {
  return `followup_${request.kind}_${request.parentTicketId}`;
}
