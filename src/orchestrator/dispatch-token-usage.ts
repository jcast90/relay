import type { Agent, AgentResult } from "../domain/agent.js";
import { resolveContextWindow } from "../domain/model-context-windows.js";
import { SessionTrackerPool } from "../budget/session-tracker-pool.js";

/**
 * Wire `agent.run()`'s `tokenUsage` into the per-session tracker pool for
 * orchestrator dispatches. Best-effort EXCEPT for the missing-model
 * assertion: that throws so an Opus 4.7 session never gets miscalibrated
 * against the default 200_000 ceiling (an Opus 4.7 session has a 1M-token
 * window — defaulting to 200k would mis-render the bar by 5x, and AGENTS.md
 * explicitly flags silent type drift as a class to refuse).
 *
 * Lives in its own module so:
 *   1. The orchestrator-v2 dispatch site stays small (one import + one
 *      conditional call).
 *   2. The Phase 1 RED test
 *      (`test/orchestrator/orchestrator-v2-token-usage.test.ts`) can
 *      assert the file exists and exports `dispatchTokenUsageOrThrow` —
 *      that contract was stamped in PR-1 as the locked surface.
 *
 * Returns void — the tracker.record() call is fire-and-forget against the
 * tracker's internal write chain. Callers that need to know the write hit
 * disk should await `pool.closeAll()` (the orchestrator does this in its
 * run-completion drain).
 */
export function dispatchTokenUsageOrThrow(input: {
  pool: SessionTrackerPool;
  agent: Agent;
  result: AgentResult;
  runId: string;
}): void {
  const { pool, agent, result, runId } = input;
  if (!result.tokenUsage) return;

  // Hidden-assumption fix (Phase 1, plan revision iteration 2): hard-throw
  // when the agent has no model. The legacy fallback to 200_000 would
  // silently misrender Opus 4.7's 1M window as 5x usage; we'd rather a
  // loud failure than a wrong bar. Both fields are checked because
  // CliAgentBase exposes the model on `protected this.model` (not on the
  // public Agent interface) — `agent.capability.model` is the canonical
  // surface, but some legacy adapters store it as `agent.model` directly.
  const cap = agent.capability as { model?: string } | undefined;
  const model = cap?.model ?? (agent as unknown as { model?: string }).model;
  if (!model) {
    throw new Error(
      `[budget] missing model on agent capability (agentId=${agent.id ?? "unknown"}); ` +
        `cannot resolve context-window ceiling for runId=${runId}.`
    );
  }

  const sessionId = `run-${runId}`;
  const ceiling = resolveContextWindow(model);
  const tracker = pool.get(sessionId, ceiling, "run");
  // `inputTokens` already includes cache-read + cache-write per the
  // adapter normalizers (research Q3). Pass them as-is — the tracker
  // sums input + output for cumulative and doesn't care about the
  // breakdown.
  tracker.record(result.tokenUsage.inputTokens, result.tokenUsage.outputTokens);
}
