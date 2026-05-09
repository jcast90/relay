/**
 * Handoff brief domain types.
 *
 * Phase 2 introduces the cross-provider session handoff feature: a
 * deterministic synthesizer joins channel artifacts (`feed.jsonl`,
 * `tickets.json`, `decisions/`, `runs.json`) into a structured markdown
 * brief, the departing agent fills four working-memory slots via the
 * `channel_handoff_finalize` MCP tool, and the resulting brief seeds a
 * fresh session in the destination provider.
 *
 * See `.planning/notes/handoff-feature-design.md` for the locked design
 * decisions (D-01 through D-09) and `docs/design/handoff-brief.md` (added
 * in Wave 5) for the full reference.
 */

/**
 * Schema version for `~/.relay/channels/<id>/handoffs/<briefId>.{md,gap.json}`
 * artifacts. First versioned `~/.relay/` artifact — see CONCERNS.md and
 * `.planning/notes/handoff-feature-design.md` D-05. Future bumps require a
 * coordinated change across the synthesizer, the MCP tool's Zod schema, and
 * the disk-read layer (`readLatestGapFill`); both fail closed on
 * `schemaVersion !== 1` (M9).
 */
export const HANDOFF_BRIEF_SCHEMA_VERSION = 1 as const;

export interface BriefSection {
  heading: string;
  body: string;
  estimatedTokens: number;
  truncated?: boolean;
}

export interface HandoffBrief {
  schemaVersion: typeof HANDOFF_BRIEF_SCHEMA_VERSION;
  /** `brief-<unix-ms>-<6-char-base36>` — see `buildBriefId` / `assertValidBriefId`. */
  briefId: string;
  channelId: string;
  channelName: string;
  /** ISO timestamp; pure-over-declared-inputs — passed in via `BuildBriefOptions.now`. */
  generatedAt: string;
  fromProvider: string | null;
  fromSessionId: string | null;
  /** Free-text label for the destination, rendered in the header. */
  toHint: string | null;
  /** Set when `--resume` is used (M7). The render layer adds a `**Resumed from:**` header line. */
  resumedFrom?: { briefId: string; originalGeneratedAt: string };
  sections: {
    statusSnapshot: BriefSection;
    mission: BriefSection;
    ticketDag: BriefSection;
    recentDecisions: BriefSection;
    filesTouched: BriefSection;
    workingMemory: BriefSection;
  };
  /** Sum of `section.estimatedTokens` across all six sections. */
  tokenEstimate: number;
}

export interface GapFillBlock {
  schemaVersion: typeof HANDOFF_BRIEF_SCHEMA_VERSION;
  briefId: string;
  channelId: string;
  /**
   * ISO timestamp the departing agent authored this block. Used for
   * staleness gating: `readLatestGapFill` returns `null` when the newest
   * record is older than `maxAgeMs` (default 1h). RESEARCH Pitfall 3.
   */
  capturedAt: string;
  capturedBySessionId: string | null;
  currentLineOfAttack: string;
  activeHypothesis: string;
  abandonedApproaches: string[];
  openQuestions: string[];
}

/**
 * Payload for an `ApprovalKind = "handoff-prompt"` approval (added by
 * Wave 3 / PR-3). `thresholdPct` is the parsed-NUMBER form of Phase 1's
 * STRING `metadata.threshold` — conversion happens exactly once at the
 * threshold-listener boundary (M1). The interface deliberately has NO
 * `entryId` field: cross-restart dedup is by `(sessionId, thresholdPct)`
 * per D-03 (H1 fix); the in-memory entryId set is for same-process
 * polling only and does not need to round-trip through this payload.
 */
export interface HandoffPromptPayload {
  schemaVersion: 1;
  channelId: string;
  sessionId: string;
  thresholdPct: number;
  used: number;
  total: number;
  /** Optional pre-rendered nudge for the dashboard. */
  promptText?: string;
}

// Local type imports kept here so `BuildBriefOptions` doesn't pull
// `ChannelStore` into every consumer of the domain types. The synthesizer
// imports the runtime classes directly.
import type { ChannelStore } from "../channels/channel-store.js";
import type { LocalArtifactStore } from "../execution/artifact-store.js";

/**
 * Per-section token budgets (D-04). Encoded as constants here so the
 * synthesizer, validator, and tests share one source of truth. The
 * orchestrator-side re-export lives at
 * `src/orchestrator/handoff/types.ts` (Wave 0+1).
 *
 * TODO(post-launch tuning): measure on real channels and tighten — see
 * RESEARCH Q2/A3 and `02-SUMMARY.md` follow-ups.
 */
export const BRIEF_TOKEN_BUDGETS = {
  statusSnapshot: 200,
  mission: 300,
  ticketDag: 600,
  recentDecisions: 1500,
  filesTouched: 400,
  workingMemory: 1500,
  totalSoftCap: 4000,
  totalHardCap: 8000,
} as const;

export type BriefTokenBudgets = typeof BRIEF_TOKEN_BUDGETS;

export interface BuildBriefOptions {
  channelId: string;
  /** Pure-over-declared-inputs: `now` is passed in, never read from `Date.now()`. */
  now: Date;
  channelStore?: ChannelStore;
  artifactStore?: LocalArtifactStore;
  gapFill?: GapFillBlock | null;
  tokenBudget?: BriefTokenBudgets;
  /** Repos to scan for `git log`-based files-touched enrichment (D-02). */
  repoCwds?: string[];
  /**
   * Optional label attached to the `**To:**` header line; informational
   * only — destination resolution happens in the CLI layer.
   */
  toHint?: string | null;
  fromProvider?: string | null;
  fromSessionId?: string | null;
  /**
   * Disable git-log enrichment for strict bit-identicality tests (M3).
   * Default `true`. When `false`, `getFilesTouchedByTicket` returns `[]`
   * with no spawn at all and the rendered Files-touched section reads
   * `(no files-touched data)`.
   */
  gitLogEnabled?: boolean;
  /** Set when `--resume` is used (M7); rendered as a header line. */
  resumedFrom?: { briefId: string; originalGeneratedAt: string };
}
