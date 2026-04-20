/**
 * Thin adapter around AO's Tracker plugins.
 *
 * The AO plugin packages expose a `create(): Tracker` factory and read their
 * credentials from `process.env` (GITHUB_TOKEN / LINEAR_API_KEY). We honor
 * `opts.token` by installing it into the expected env var for the duration of
 * the factory call, then restoring the previous value.
 *
 * Keep this file as the single boundary: no other module in the harness should
 * import from `@aoagents/*`.
 */
import type { ProjectConfig, Tracker } from "@aoagents/ao-core";
import githubTracker from "@aoagents/ao-plugin-tracker-github";
import linearTracker from "@aoagents/ao-plugin-tracker-linear";

export type TrackerKind = "github" | "linear";

/** Narrow shape used by the rest of the harness. Decoupled from AO's `Issue`. */
export interface HarnessIssue {
  id: string;
  title: string;
  body: string;
  url: string;
  labels: string[];
  branchName: string;
}

const ENV_VAR: Record<TrackerKind, string> = {
  github: "GITHUB_TOKEN",
  linear: "LINEAR_API_KEY",
};

/**
 * Build a configured Tracker. The AO plugin factories consume their token from
 * env vars at construction time, so we temporarily overlay `opts.token` into
 * the matching var if provided.
 */
export function createTracker(
  kind: TrackerKind,
  opts: { token?: string } = {},
): Tracker {
  const envVar = ENV_VAR[kind];
  const previous = process.env[envVar];
  if (opts.token !== undefined) {
    process.env[envVar] = opts.token;
  }
  try {
    return kind === "github" ? githubTracker.create() : linearTracker.create();
  } finally {
    if (opts.token !== undefined) {
      if (previous === undefined) delete process.env[envVar];
      else process.env[envVar] = previous;
    }
  }
}

/**
 * Fetch an issue via the AO Tracker and project it into the harness's
 * narrower `HarnessIssue` shape.
 */
export async function resolveIssue(
  tracker: Tracker,
  identifier: string,
  project: ProjectConfig,
): Promise<HarnessIssue> {
  const issue = await tracker.getIssue(identifier, project);
  const branchName =
    issue.branchName ?? tracker.branchName(identifier, project);
  return {
    id: issue.id,
    title: issue.title,
    body: issue.description,
    url: issue.url,
    labels: issue.labels ?? [],
    branchName,
  };
}

// GitHub issue URL: https://github.com/<owner>/<repo>/issues/<number>
const GITHUB_ISSUE_URL = /^https?:\/\/(?:www\.)?github\.com\/[^/]+\/[^/]+\/issues\/\d+(?:[/?#].*)?$/i;
// Linear issue URL: https://linear.app/<workspace>/issue/ABC-123(/...)
const LINEAR_URL = /^https?:\/\/(?:www\.)?linear\.app\/[^/]+\/issue\/[A-Z][A-Z0-9]*-\d+/i;
// Bare Linear identifier: ABC-123
const LINEAR_BARE = /^[A-Z][A-Z0-9]*-\d+$/;

/**
 * Sniff a URL or identifier and guess which tracker it belongs to.
 * Returns null when the input doesn't match any known pattern.
 */
export function detectTrackerKind(input: string): TrackerKind | null {
  const s = input.trim();
  if (!s) return null;
  if (GITHUB_ISSUE_URL.test(s)) return "github";
  if (LINEAR_URL.test(s)) return "linear";
  if (LINEAR_BARE.test(s)) return "linear";
  return null;
}
