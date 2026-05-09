/**
 * Orchestrator-side re-exports for handoff brief types. The synthesizer,
 * render, and validate modules import from here so the import surface
 * stays stable even if the underlying domain types relocate.
 *
 * The single source of truth lives at `src/domain/handoff.ts`.
 */

export { HANDOFF_BRIEF_SCHEMA_VERSION, BRIEF_TOKEN_BUDGETS } from "../../domain/handoff.js";

export type {
  HandoffBrief,
  BriefSection,
  GapFillBlock,
  HandoffPromptPayload,
  BuildBriefOptions,
  BriefTokenBudgets,
} from "../../domain/handoff.js";
