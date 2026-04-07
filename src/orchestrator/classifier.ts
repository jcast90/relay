import {
  parseClassificationResult,
  type ClassificationResult,
  type ComplexityTier
} from "../domain/classification.js";
import type { AgentResult, WorkRequest } from "../domain/agent.js";
import type { HarnessRun } from "../domain/run.js";

const TRIVIAL_PATTERNS = [
  /\b(fix\s+)?typo\b/i,
  /\brename\b/i,
  /\bbump\s+version\b/i,
  /\bupdate\s+(readme|changelog|docs?)\b/i,
  /\bremove\s+unused\b/i,
  /\bconfig\s+change\b/i,
  /\badd\s+comment\b/i,
  /\bformat(ting)?\b/i,
  /\blint\s+fix\b/i
];

const BUGFIX_PATTERNS = [
  /\bbug\b/i,
  /\bfix(es|ed)?\b/i,
  /\bbroken\b/i,
  /\bcrash(es|ing)?\b/i,
  /\berror\b/i,
  /\bnot\s+working\b/i,
  /\bregression\b/i,
  /\bdebug\b/i
];

export function classifyByHeuristic(featureRequest: string): ComplexityTier | null {
  const words = featureRequest.trim().split(/\s+/).length;

  if (words <= 10 && TRIVIAL_PATTERNS.some((pattern) => pattern.test(featureRequest))) {
    return "trivial";
  }

  if (words <= 20 && BUGFIX_PATTERNS.some((pattern) => pattern.test(featureRequest))) {
    return "bugfix";
  }

  return null;
}

export function buildHeuristicClassification(
  tier: ComplexityTier,
  featureRequest: string
): ClassificationResult {
  return {
    tier,
    rationale: `Classified by heuristic pattern match on: "${featureRequest.slice(0, 80)}"`,
    suggestedSpecialties: ["general"],
    estimatedTicketCount: tier === "trivial" ? 1 : 2,
    needsDesignDoc: false,
    needsUserApproval: false,
    crosslinkRepos: []
  };
}

export async function classifyRequest(input: {
  run: HarnessRun;
  featureRequest: string;
  repoRoot: string;
  dispatch: (run: HarnessRun, request: Omit<WorkRequest, "runId">) => Promise<AgentResult>;
}): Promise<ClassificationResult> {
  const heuristicTier = classifyByHeuristic(input.featureRequest);

  if (heuristicTier) {
    return buildHeuristicClassification(heuristicTier, input.featureRequest);
  }

  const result = await input.dispatch(input.run, {
    phaseId: "phase_00",
    kind: "classify_request",
    specialty: "general",
    title: "Classify request complexity",
    objective: input.featureRequest,
    acceptanceCriteria: [
      "Classify the request into exactly one complexity tier.",
      "Provide a rationale for the classification.",
      "Estimate the number of parallelizable tickets."
    ],
    allowedCommands: [],
    verificationCommands: [],
    docsToUpdate: [],
    context: [
      `Repository root: ${input.repoRoot}`,
      `Feature request: ${input.featureRequest}`
    ],
    artifactContext: [],
    attempt: 1,
    maxAttempts: 2,
    priorEvidence: []
  });

  try {
    const raw = result.rawResponse ? JSON.parse(result.rawResponse) : {};
    return parseClassificationResult(raw.classification ?? raw);
  } catch {
    return {
      tier: "feature_small",
      rationale: `Defaulted to feature_small after classification parse failure. Agent summary: ${result.summary}`,
      suggestedSpecialties: ["general"],
      estimatedTicketCount: 3,
      needsDesignDoc: false,
      needsUserApproval: false,
      crosslinkRepos: []
    };
  }
}
