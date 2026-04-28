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
import {
  getProjectItemContext,
  type ProjectItemContext,
  type ProjectsClientDeps,
} from "../integrations/github-projects/client.js";
import {
  parseGithubProjectsUrl,
  PROJECT_ONLY_DEFERRED_MESSAGE,
  type GitHubProjectsUrl,
} from "../integrations/github-projects/url-parser.js";
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

/**
 * Same idea as `enrichFeatureRequest` but for a GitHub Projects v2 item.
 * Includes the parent epic title (so the planner sees channel/epic
 * context) and any wrapped Issue/PR link, which downstream agents can
 * follow when deeper context is needed.
 */
function enrichFromProjectItem(item: ProjectItemContext, originalUrl: string): string {
  const parts: string[] = [];
  parts.push(item.title || "(untitled draft item)");
  if (item.parent && item.parent.title) {
    parts.push(`\nParent epic: ${item.parent.title}`);
  }
  parts.push(`\nProject: ${item.project.title}`);
  if (item.body) {
    parts.push(`\n\n${item.body}`);
  }
  if (item.content) {
    parts.push(`\n\nLinked ${item.content.kind}: ${item.content.url}`);
  }
  parts.push(`\n\nSource: ${originalUrl}`);
  return parts.join("");
}

/**
 * Build a `ProjectsClientDeps` from a caller-supplied bag, falling back
 * to `process.env.GITHUB_TOKEN` only at this single boundary. New code
 * should accept a deps bag rather than reaching into env.
 */
function resolveProjectsDeps(
  caller: Partial<ProjectsClientDeps> | undefined
): ProjectsClientDeps | null {
  const token = caller?.token ?? process.env.GITHUB_TOKEN ?? "";
  if (!token) return null;
  return { token, fetch: caller?.fetch, apiUrl: caller?.apiUrl };
}

/**
 * If `featureRequest` is a Projects v2 URL, resolve item context (or
 * surface the project-only deferred error). Returns null when the input
 * is not a Projects v2 URL at all so the caller can fall through to
 * the existing tracker path.
 */
type ProjectsResolution =
  | { kind: "item"; context: ProjectItemContext; parsed: GitHubProjectsUrl }
  | { kind: "deferred"; message: string; parsed: GitHubProjectsUrl };

async function tryResolveProjectsUrl(
  featureRequest: string,
  projectsDeps: Partial<ProjectsClientDeps> | undefined
): Promise<ProjectsResolution | null> {
  const parsed = parseGithubProjectsUrl(featureRequest);
  if (!parsed) return null;

  if (parsed.kind === "project") {
    return { kind: "deferred", message: PROJECT_ONLY_DEFERRED_MESSAGE, parsed };
  }

  const deps = resolveProjectsDeps(projectsDeps);
  if (!deps) {
    return {
      kind: "deferred",
      message:
        "GITHUB_TOKEN not available; cannot resolve GitHub Projects item context. " +
        "Pass a token via `projectsDeps` or set GITHUB_TOKEN.",
      parsed,
    };
  }

  try {
    const context = await getProjectItemContext(parsed.itemId, deps);
    return { kind: "item", context, parsed };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[classifier] Failed to resolve GitHub Projects item ${parsed.itemId}; ` +
        `falling back to raw input. ${message}`
    );
    return { kind: "deferred", message, parsed };
  }
}

export async function classifyRequest(input: {
  run: HarnessRun;
  featureRequest: string;
  repoRoot: string;
  dispatch: (run: HarnessRun, request: Omit<WorkRequest, "runId">) => Promise<AgentResult>;
  /**
   * Optional GitHub Projects client deps. When the feature request looks
   * like a Projects v2 item URL we use this to resolve channel/epic
   * context. Tests pass a stubbed `fetch`; CLI callers pass a token.
   * Falls back to `process.env.GITHUB_TOKEN` if `token` is omitted.
   */
  projectsDeps?: Partial<ProjectsClientDeps>;
}): Promise<ClassificationResult> {
  // Projects v2 URL takes precedence: it overlaps with `github.com` host
  // but uses /(users|orgs)/.../projects/<n>, which the existing tracker
  // detector does NOT match — so the two paths can't fight. We only
  // fall through to tracker resolution if the input was not a Projects
  // URL at all.
  const projectsResolution = await tryResolveProjectsUrl(input.featureRequest, input.projectsDeps);

  if (projectsResolution?.kind === "deferred") {
    // Project-only URL OR API/auth failure. Surface a clear rationale so
    // the user sees why the paste didn't enrich. We deliberately do not
    // throw — the orchestrator UX prefers a returned classification with
    // an explanatory rationale to a hard failure.
    const fallback: ClassificationResult = {
      tier: "feature_small",
      rationale: projectsResolution.message,
      suggestedSpecialties: ["general"],
      estimatedTicketCount: 1,
      needsDesignDoc: false,
      needsUserApproval: true,
    };
    return fallback;
  }

  if (projectsResolution?.kind === "item") {
    return classifyEnrichedRequest({
      run: input.run,
      originalRequest: input.featureRequest,
      effectiveRequest: enrichFromProjectItem(
        projectsResolution.context,
        projectsResolution.parsed.url
      ),
      contextLines: [
        `GitHub Project: ${projectsResolution.context.project.title} (${projectsResolution.context.project.url})`,
        ...(projectsResolution.context.parent && projectsResolution.context.parent.title
          ? [`Parent epic: ${projectsResolution.context.parent.title}`]
          : []),
      ],
      suggestedBranch: undefined,
      repoRoot: input.repoRoot,
      dispatch: input.dispatch,
    });
  }

  const issue = await tryResolveTrackerIssue(input.featureRequest, input.repoRoot);
  const effectiveRequest = issue
    ? enrichFeatureRequest(input.featureRequest, issue)
    : input.featureRequest;
  const suggestedBranch = issue?.branchName;

  const trackerContext: string[] = [];
  if (issue) {
    trackerContext.push(`Tracker: ${issue.url}`);
    if (issue.labels.length) {
      trackerContext.push(`Tracker labels: ${issue.labels.join(", ")}`);
    }
  }

  return classifyEnrichedRequest({
    run: input.run,
    originalRequest: input.featureRequest,
    effectiveRequest,
    contextLines: trackerContext,
    suggestedBranch,
    repoRoot: input.repoRoot,
    dispatch: input.dispatch,
  });
}

/**
 * Heuristic + dispatch tail of the classifier. Factored out so both the
 * existing tracker-issue path and the new Projects v2 item path can
 * share it without duplicating the LLM-prompt construction.
 */
async function classifyEnrichedRequest(args: {
  run: HarnessRun;
  /** Raw input the user actually pasted; kept for log/audit context. */
  originalRequest: string;
  /** Enriched objective fed to the heuristics + LLM. */
  effectiveRequest: string;
  /** Extra context lines (tracker labels, project info, etc.). */
  contextLines: string[];
  /** Optional branch hint from the tracker plugin. */
  suggestedBranch: string | undefined;
  repoRoot: string;
  dispatch: (run: HarnessRun, request: Omit<WorkRequest, "runId">) => Promise<AgentResult>;
}): Promise<ClassificationResult> {
  const heuristicTier = classifyByHeuristic(args.effectiveRequest);
  if (heuristicTier) {
    const result = buildHeuristicClassification(heuristicTier, args.effectiveRequest);
    return args.suggestedBranch ? { ...result, suggestedBranch: args.suggestedBranch } : result;
  }

  const context: string[] = [
    `Repository root: ${args.repoRoot}`,
    `Feature request: ${args.effectiveRequest}`,
    ...args.contextLines,
  ];

  const result = await args.dispatch(args.run, {
    phaseId: "phase_00",
    kind: "classify_request",
    specialty: "general",
    title: "Classify request complexity",
    objective: args.effectiveRequest,
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
    return args.suggestedBranch ? { ...parsed, suggestedBranch: args.suggestedBranch } : parsed;
  } catch {
    const fallback: ClassificationResult = {
      tier: "feature_small",
      rationale: `Defaulted to feature_small after classification parse failure. Agent summary: ${result.summary}`,
      suggestedSpecialties: ["general"],
      estimatedTicketCount: 3,
      needsDesignDoc: false,
      needsUserApproval: false,
    };
    return args.suggestedBranch ? { ...fallback, suggestedBranch: args.suggestedBranch } : fallback;
  }
}
