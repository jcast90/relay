import {
  parseClassificationResult,
  type ClassificationResult,
  type ComplexityTier,
} from "../domain/classification.js";
import type { AgentResult, WorkRequest } from "../domain/agent.js";
import type { HarnessRun } from "../domain/run.js";
import {
  createTracker,
  detectTrackerKind,
  resolveIssue,
  type HarnessIssue,
  type TrackerKind,
} from "../integrations/tracker.js";
import { basename } from "node:path";

const TRIVIAL_PATTERNS = [
  /\b(fix\s+)?typo\b/i,
  /\brename\b/i,
  /\bbump\s+version\b/i,
  /\bupdate\s+(readme|changelog|docs?)\b/i,
  /\bremove\s+unused\b/i,
  /\bconfig\s+change\b/i,
  /\badd\s+comment\b/i,
  /\bformat(ting)?\b/i,
  /\blint\s+fix\b/i,
];

const BUGFIX_PATTERNS = [
  /\bbug\b/i,
  /\bfix(es|ed)?\b/i,
  /\bbroken\b/i,
  /\bcrash(es|ing)?\b/i,
  /\berror\b/i,
  /\bnot\s+working\b/i,
  /\bregression\b/i,
  /\bdebug\b/i,
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
  };
}

/**
 * Pull the tracker-native identifier out of a URL (or bare Linear key).
 * GitHub issues: the numeric issue number (without `#`).
 * Linear issues: the short identifier, e.g. `ABC-123`.
 * Returns null if the shape is unrecognized.
 */
function parseIdentifier(input: string, kind: TrackerKind): string | null {
  const s = input.trim();
  if (kind === "github") {
    const m = s.match(/github\.com\/[^/]+\/[^/]+\/issues\/(\d+)/i);
    if (m) return m[1];
    return null;
  }
  // linear
  const urlMatch = s.match(/linear\.app\/[^/]+\/issue\/([A-Z][A-Z0-9]*-\d+)/i);
  if (urlMatch) return urlMatch[1].toUpperCase();
  if (/^[A-Z][A-Z0-9]*-\d+$/.test(s)) return s;
  return null;
}

/**
 * Build a minimal structural `ProjectConfig` from the harness's `repoRoot`.
 * We deliberately do NOT import AO's `ProjectConfig` here — we rely on
 * structural typing through the `resolveIssue` signature exported by
 * `src/integrations/tracker.ts`, which is the single boundary to AO.
 *
 * For GitHub, we try to recover `owner/repo` from the issue URL itself; for
 * Linear, the plugin ignores project.repo so a placeholder is fine.
 */
function buildProjectConfig(
  repoRoot: string,
  input: string,
  kind: TrackerKind
): {
  name: string;
  repo: string;
  path: string;
  defaultBranch: string;
  sessionPrefix: string;
} {
  let repo = "";
  if (kind === "github") {
    const m = input.match(/github\.com\/([^/]+\/[^/]+?)(?:\/issues\/\d+)/i);
    if (m) repo = m[1];
  }
  const leaf = basename(repoRoot) || "harness";
  return {
    name: repo || leaf,
    repo: repo || leaf,
    path: repoRoot,
    defaultBranch: "main",
    sessionPrefix: leaf,
  };
}

/**
 * If `featureRequest` looks like a tracker issue URL/identifier, fetch the
 * underlying issue and return it. Never throws — on any failure (bad URL,
 * network/auth error, missing creds) logs a warning and returns null so the
 * caller can fall back to classifying the raw string.
 */
async function tryResolveTrackerIssue(
  featureRequest: string,
  repoRoot: string
): Promise<HarnessIssue | null> {
  const kind = detectTrackerKind(featureRequest);
  if (!kind) return null;

  const identifier = parseIdentifier(featureRequest, kind);
  if (!identifier) return null;

  try {
    const tracker = await createTracker(kind);
    const project = buildProjectConfig(repoRoot, featureRequest, kind);
    return await resolveIssue(tracker, identifier, project);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[classifier] Failed to resolve ${kind} issue "${identifier}"; falling back to raw input. ${message}`
    );
    return null;
  }
}

/**
 * Merge a tracker-fetched issue into the raw feature request so downstream
 * heuristics and the LLM prompt see the title + body + labels, not just a
 * bare URL.
 */
function enrichFeatureRequest(featureRequest: string, issue: HarnessIssue): string {
  const labels = issue.labels.length ? `\nLabels: ${issue.labels.join(", ")}` : "";
  const body = issue.body ? `\n\n${issue.body}` : "";
  return `${issue.title}${labels}${body}\n\nSource: ${issue.url}`;
}

export async function classifyRequest(input: {
  run: HarnessRun;
  featureRequest: string;
  repoRoot: string;
  dispatch: (run: HarnessRun, request: Omit<WorkRequest, "runId">) => Promise<AgentResult>;
}): Promise<ClassificationResult> {
  const issue = await tryResolveTrackerIssue(input.featureRequest, input.repoRoot);
  const effectiveRequest = issue
    ? enrichFeatureRequest(input.featureRequest, issue)
    : input.featureRequest;
  const suggestedBranch = issue?.branchName;

  const heuristicTier = classifyByHeuristic(effectiveRequest);

  if (heuristicTier) {
    const result = buildHeuristicClassification(heuristicTier, effectiveRequest);
    return suggestedBranch ? { ...result, suggestedBranch } : result;
  }

  const context: string[] = [
    `Repository root: ${input.repoRoot}`,
    `Feature request: ${effectiveRequest}`,
  ];
  if (issue) {
    context.push(`Tracker: ${issue.url}`);
    if (issue.labels.length) {
      context.push(`Tracker labels: ${issue.labels.join(", ")}`);
    }
  }

  const result = await input.dispatch(input.run, {
    phaseId: "phase_00",
    kind: "classify_request",
    specialty: "general",
    title: "Classify request complexity",
    objective: effectiveRequest,
    acceptanceCriteria: [
      "Classify the request into exactly one complexity tier.",
      "Provide a rationale for the classification.",
      "Estimate the number of parallelizable tickets.",
    ],
    allowedCommands: [],
    verificationCommands: [],
    docsToUpdate: [],
    context,
    artifactContext: [],
    attempt: 1,
    maxAttempts: 2,
    priorEvidence: [],
  });

  try {
    const raw = result.rawResponse ? JSON.parse(result.rawResponse) : {};
    const parsed = parseClassificationResult(raw.classification ?? raw);
    return suggestedBranch ? { ...parsed, suggestedBranch } : parsed;
  } catch {
    const fallback: ClassificationResult = {
      tier: "feature_small",
      rationale: `Defaulted to feature_small after classification parse failure. Agent summary: ${result.summary}`,
      suggestedSpecialties: ["general"],
      estimatedTicketCount: 3,
      needsDesignDoc: false,
      needsUserApproval: false,
    };
    return suggestedBranch ? { ...fallback, suggestedBranch } : fallback;
  }
}
