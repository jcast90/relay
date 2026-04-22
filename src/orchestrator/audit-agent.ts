/**
 * AL-6: post-completion audit agent (proposals only).
 *
 * After the autonomous driver drains its last ticket, the audit agent
 * looks at what just shipped — the ticket ledger, the run's decisions,
 * the recent git log — and proposes the next 3–5 tickets the operator
 * should tackle, ranked by user value. Each proposal is persisted as an
 * `audit_proposal` decision entry on the channel so the TUI/GUI can
 * surface it. Auto-creation of Linear / GitHub issues is deferred until
 * god mode (AL-7): today the audit is advisory only.
 *
 * ## Gating
 *
 * Two hard gates before the audit fires:
 *
 *   1. **Ledger is all-green.** Every ticket on the board must be in
 *      `completed` or `verifying` status. A single `failed` / `blocked`
 *      / `retry` entry aborts silently — the operator's attention belongs
 *      on the failure, not on a speculative next-ticket list.
 *   2. **Budget headroom >= 15%.** Passed in by the caller as the
 *      post-drain percentage remaining. The audit call itself consumes
 *      tokens; we refuse to eat headroom the operator might have earmarked
 *      for a retry or follow-up ticket.
 *
 * Both gates produce a "skip" result with an explicit reason so the caller
 * can log it. Neither throws — the post-drain path must remain clean.
 *
 * ## Single-fire per session
 *
 * The driver calls this function exactly once per autonomous session, in
 * the post-drain window before the lifecycle transitions to `killed`.
 * This module does not itself track "already fired" — that invariant
 * belongs to the caller's control flow (one call, then the function
 * returns). Callers that fear re-entry can wrap with an `idempotent`
 * guard, but today the autonomous-loop shape makes re-entry impossible.
 *
 * ## Output contract
 *
 * On success, writes one `audit_proposal` decision per proposed ticket.
 * The decision entry shape:
 *
 *   - `type: "audit_proposal"`
 *   - `title: <proposal title>`
 *   - `description: <one-paragraph pitch>`
 *   - `rationale: <why this ticket, now>`
 *   - `metadata: { title, dependencies, effortEstimate, sessionId }`
 *
 * The redundant `title` in metadata exists because the Rust reader
 * (`crates/harness-data/src/lib.rs`) treats `metadata` as a flat
 * `Record<string, string>`, and downstream TUI/GUI filters key off
 * metadata rather than reparsing the decision. Cost is one extra string;
 * benefit is that dashboards do not have to know the decision-schema
 * gymnastics.
 *
 * ## Why no real agent spawn in the default export
 *
 * The production wiring hands in an `invokeAudit` callback that the
 * autonomous loop constructs from the agent factory (Claude/Codex CLI
 * child process, short-lived). Tests inject a scripted callback. Keeping
 * that boundary sharp means this module stays free of CLI subprocess
 * concerns: its job is gating, prompt building, zod validation of the
 * agent's JSON, and decision-board writes.
 */

import { z } from "zod";

import type { ChannelStore } from "../channels/channel-store.js";
import type { Channel } from "../domain/channel.js";
import type { Decision } from "../domain/decision.js";
import type { TicketLedgerEntry } from "../domain/ticket.js";

/**
 * Effort band the audit agent tags each proposal with. Aligned with the
 * GH-issue size labels the project board already uses so the operator can
 * drop a proposal straight onto the board without relabelling.
 */
export const AuditEffortEstimateSchema = z.enum(["XS", "S", "M", "L", "XL"]);
export type AuditEffortEstimate = z.infer<typeof AuditEffortEstimateSchema>;

/**
 * Shape of one proposal returned by the audit agent. The schema is
 * enforced by zod before any decision is written — a malformed proposal
 * is logged and skipped rather than poisoning the board.
 *
 * `dependencies` is a free-form list of ticket IDs or proposal titles the
 * agent thinks this proposal depends on. We keep it loose (strings) rather
 * than typed-reference because the agent is reasoning over open-ended
 * inputs (in-flight tickets, hypothetical future work) and a rigid
 * reference type would force it to invent IDs.
 */
export const AuditProposalSchema = z.object({
  title: z.string().min(1).max(120),
  rationale: z.string().min(1),
  dependencies: z.array(z.string()).default([]),
  effortEstimate: AuditEffortEstimateSchema,
});
export type AuditProposal = z.infer<typeof AuditProposalSchema>;

/**
 * Agent-returned envelope. A 3..5 count is enforced so an agent that
 * returns 0 / 1 / 20 does not slip through with nothing-or-noise.
 */
export const AuditResponseSchema = z.object({
  proposals: z.array(AuditProposalSchema).min(3).max(5),
});
export type AuditResponse = z.infer<typeof AuditResponseSchema>;

/**
 * Context the audit agent sees. Built by the caller from the current
 * run's state. Kept small — the agent is reasoning over "what just
 * shipped", not over the full session history, so deep run-replay data
 * is intentionally excluded.
 */
export interface AuditRunContext {
  sessionId: string;
  /** Ticket ledger the driver just finished draining. */
  tickets: readonly TicketLedgerEntry[];
  /**
   * Decisions already on the board — coordination messages, session-
   * start audit, any prior `audit_proposal` entries. The agent uses
   * these to avoid proposing what the operator explicitly decided
   * against or what was already proposed.
   */
  decisions: readonly Decision[];
  /**
   * Recent git log lines (subject line only). Caller is responsible
   * for shelling out — audit-agent stays free of shell-exec concerns.
   * An empty array is fine; the prompt tolerates a missing git view.
   */
  recentCommits: readonly string[];
}

/**
 * Callback that actually invokes the underlying LLM / CLI agent. The
 * production binding constructs a short-lived Claude/Codex child via
 * the agent factory; tests inject a scripted function.
 *
 * Contract: given the fully-rendered prompt, return a string that
 * parses as JSON matching {@link AuditResponseSchema}. Rejecting with
 * any error is treated as a skip (no decisions written, reason
 * `agent_error`) rather than letting the driver's teardown throw.
 */
export type AuditInvoker = (prompt: string) => Promise<string>;

/**
 * Result summary returned to the caller so the autonomous-loop's
 * shutdown log has something to print.
 */
export type AuditRunResult =
  | { kind: "fired"; proposalsWritten: number }
  | { kind: "skipped"; reason: AuditSkipReason }
  | { kind: "invalid"; issues: z.ZodIssue[] };

export type AuditSkipReason =
  | "budget_headroom_too_low"
  | "ledger_had_failures"
  | "ledger_empty"
  | "agent_error";

export interface RunPostCompletionAuditOptions {
  /** Channel the session is running against. */
  channel: Channel;
  /** Run context (ticket ledger + decisions + recent commits). */
  run: AuditRunContext;
  /** Channel store — used to write `audit_proposal` decisions. */
  channelStore: Pick<ChannelStore, "recordDecision">;
  /**
   * Post-drain budget headroom, 0..100. Gate: audit fires only when
   * >= 15. Callers that do not have a tracker (e.g. non-autonomous
   * flows) should not call this function at all.
   */
  budgetHeadroomPct: number;
  /** LLM invocation callback. See {@link AuditInvoker}. */
  invokeAudit: AuditInvoker;
}

/**
 * Hard-coded budget-headroom gate. Exported so tests can reference it
 * without duplicating the number, and so a future knob (e.g. making it
 * configurable per-channel) has a single site to revisit.
 */
export const AUDIT_MIN_HEADROOM_PCT = 15;

/**
 * Prompt template. Intentionally a JSDoc constant rather than a separate
 * file — the task spec's "stubs tolerated" section pins this choice so
 * the prompt stays versioned with the code that emits it. Placeholders
 * are replaced at render time.
 *
 * The prompt asks for strict JSON so the response path is a single
 * JSON.parse + zod validation; no free-form markdown stripping.
 */
const AUDIT_PROMPT_TEMPLATE = `You are Relay's post-completion audit agent. A run just finished
draining its ticket board; every ticket landed green. Your job is to
propose the NEXT 3 to 5 tickets the operator should tackle, prioritised
by user value.

## Context

Session: {{sessionId}}
Channel: {{channelName}} ({{channelId}})

### Tickets just completed
{{ticketSummary}}

### Decisions on the board
{{decisionsSummary}}

### Recent commits
{{commitsSummary}}

## Output

Respond with STRICT JSON matching this shape — no markdown fences, no
commentary, nothing outside the braces:

{
  "proposals": [
    {
      "title": "short ticket title",
      "rationale": "why this ticket now, one to three sentences",
      "dependencies": ["ticket title or id this depends on, if any"],
      "effortEstimate": "XS" | "S" | "M" | "L" | "XL"
    }
  ]
}

Rules:
 - Between 3 and 5 proposals.
 - Prioritise by user-visible impact, not internal refactors.
 - Rationale must reference concrete evidence from the context above.
 - Do NOT propose anything that duplicates an existing decision on the
   board.
`;

/**
 * Render the prompt template with the current run context. Kept out of
 * the main function so tests can exercise the substitution logic in
 * isolation and so the template itself is tweakable without changing
 * call-site code.
 */
export function renderAuditPrompt(channel: Channel, run: AuditRunContext): string {
  const ticketSummary =
    run.tickets.length === 0
      ? "(no tickets — this should have been gated before reaching the prompt)"
      : run.tickets
          .map(
            (t) =>
              `- [${t.status}] ${t.ticketId}: ${t.title}` +
              (t.assignedAlias ? ` (repo: ${t.assignedAlias})` : "")
          )
          .join("\n");

  const decisionsSummary =
    run.decisions.length === 0
      ? "(no prior decisions)"
      : run.decisions
          .slice(-20)
          .map((d) => `- [${d.type ?? "general"}] ${d.title}`)
          .join("\n");

  const commitsSummary =
    run.recentCommits.length === 0
      ? "(no recent commits captured)"
      : run.recentCommits
          .slice(0, 20)
          .map((c) => `- ${c}`)
          .join("\n");

  return AUDIT_PROMPT_TEMPLATE.replace("{{sessionId}}", run.sessionId)
    .replace("{{channelName}}", channel.name)
    .replace("{{channelId}}", channel.channelId)
    .replace("{{ticketSummary}}", ticketSummary)
    .replace("{{decisionsSummary}}", decisionsSummary)
    .replace("{{commitsSummary}}", commitsSummary);
}

/**
 * Extract a JSON object from the raw agent response. Tolerates surrounding
 * whitespace and a single pair of markdown fences (triple backticks) — but
 * not free-form prose around the object. The prompt asks for strict JSON;
 * this is a safety net, not a license for the agent to ramble.
 */
function extractJson(raw: string): string {
  const trimmed = raw.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/m.exec(trimmed);
  if (fenced) return fenced[1].trim();
  return trimmed;
}

/**
 * Does the ledger count as "all green"? Every ticket must be in a
 * terminal-green state (`completed`) or a post-spawn PR-opened state
 * (`verifying`). `failed`, `blocked`, `retry` are all red; so is a
 * `pending` / `ready` / `executing` ticket that somehow made it past
 * the drain. An empty ledger is ALSO red — nothing happened this run,
 * so there is no basis for a proposal.
 */
function isLedgerAllGreen(tickets: readonly TicketLedgerEntry[]): boolean {
  if (tickets.length === 0) return false;
  return tickets.every((t) => t.status === "completed" || t.status === "verifying");
}

/**
 * Entry point called by the autonomous-loop driver (AL-4 or,
 * pre-AL-4, `autonomous-loop.ts` directly). Gates, prompts, validates,
 * writes decisions. Never throws — the post-drain path must exit
 * cleanly regardless of audit outcome.
 */
export async function runPostCompletionAudit(
  opts: RunPostCompletionAuditOptions
): Promise<AuditRunResult> {
  const { channel, run, channelStore, budgetHeadroomPct, invokeAudit } = opts;

  if (budgetHeadroomPct < AUDIT_MIN_HEADROOM_PCT) {
    return { kind: "skipped", reason: "budget_headroom_too_low" };
  }

  if (run.tickets.length === 0) {
    return { kind: "skipped", reason: "ledger_empty" };
  }
  if (!isLedgerAllGreen(run.tickets)) {
    return { kind: "skipped", reason: "ledger_had_failures" };
  }

  const prompt = renderAuditPrompt(channel, run);
  let rawResponse: string;
  try {
    rawResponse = await invokeAudit(prompt);
  } catch (err) {
    console.warn(
      `[audit-agent] invoker threw: ${err instanceof Error ? err.message : String(err)}`
    );
    return { kind: "skipped", reason: "agent_error" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(rawResponse));
  } catch (err) {
    console.warn(
      `[audit-agent] response was not valid JSON: ${err instanceof Error ? err.message : String(err)}`
    );
    return {
      kind: "invalid",
      issues: [
        {
          code: "custom",
          path: [],
          message: `Non-JSON response: ${String(err).slice(0, 200)}`,
        } as z.ZodIssue,
      ],
    };
  }

  const validation = AuditResponseSchema.safeParse(parsed);
  if (!validation.success) {
    console.warn(`[audit-agent] response failed zod validation: ${validation.error.message}`);
    return { kind: "invalid", issues: validation.error.issues };
  }

  let written = 0;
  for (const proposal of validation.data.proposals) {
    try {
      await channelStore.recordDecision(channel.channelId, {
        runId: null,
        ticketId: null,
        title: proposal.title,
        description: proposal.rationale,
        rationale: proposal.rationale,
        alternatives: [],
        decidedBy: "audit-agent",
        decidedByName: "Audit Agent (AL-6)",
        linkedArtifacts: [],
        type: "audit_proposal",
        metadata: {
          title: proposal.title,
          dependencies: proposal.dependencies,
          effortEstimate: proposal.effortEstimate,
          sessionId: run.sessionId,
        },
      });
      written += 1;
    } catch (err) {
      console.warn(
        `[audit-agent] failed to persist proposal "${proposal.title}": ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  return { kind: "fired", proposalsWritten: written };
}
