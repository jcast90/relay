import type { ComplexityTier } from "./classification.js";
import type { ChannelTier } from "./channel.js";

/**
 * Map the orchestrator's 6-variant ComplexityTier to the 5-variant
 * ChannelTier surfaced in the GUI header pill. Architectural / multi-repo
 * collapse to `feature_large` since the header pill doesn't need that fine
 * a distinction — the orchestrator still makes its own routing decisions
 * off the richer `ComplexityTier`. `question` is intentionally unreachable
 * from the classifier: it's a pre-run categorization (kickoff / DM) that
 * the heuristic in harness-data handles.
 */
export function classifierTierToChannelTier(tier: ComplexityTier): ChannelTier {
  switch (tier) {
    case "trivial":
      return "chore";
    case "bugfix":
      return "bugfix";
    case "feature_small":
      return "feature";
    case "feature_large":
    case "architectural":
    case "multi_repo":
      return "feature_large";
  }
}
