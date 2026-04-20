/**
 * Thin adapter around AO's Tracker plugins.
 *
 * The AO plugin packages expose a `create(): Tracker` factory and read their
 * credentials from `process.env` (GITHUB_TOKEN / LINEAR_API_KEY). We honor
 * `opts.token` by installing it into the expected env var for the duration of
 * the factory call via a shared serialization primitive so concurrent calls
 * with different tokens cannot observe each other's values.
 *
 * Keep this file as the single boundary: no other module in the harness should
 * import from `@aoagents/*`.
 */
import type { ProjectConfig, Tracker } from "@aoagents/ao-core";
import githubTracker from "@aoagents/ao-plugin-tracker-github";
import linearTracker from "@aoagents/ao-plugin-tracker-linear";

import { withEnvOverride } from "./plugin-env-mutex.js";

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
 * env vars at construction time, so when `opts.token` is provided we overlay
 * the matching env var through `withEnvOverride`, which serializes concurrent
 * callers so they cannot observe each other's tokens.
 *
 * Overloads:
 *  - No-token call returns `Tracker` synchronously; this preserves the legacy
 *    call site in `classifier.ts` (`const tracker = createTracker(kind)`).
 *  - With-token call returns `Promise<Tracker>` because the shared env-mutex
 *    is fundamentally async.
 */
export function createTracker(kind: TrackerKind): Tracker;
export function createTracker(
  kind: TrackerKind,
  opts: { token?: undefined },
): Tracker;
export function createTracker(
  kind: TrackerKind,
  opts: { token: string },
): Promise<Tracker>;
export function createTracker(
  kind: TrackerKind,
  opts: { token?: string } = {},
): Tracker | Promise<Tracker> {
  const build = (): Tracker =>
    kind === "github" ? githubTracker.create() : linearTracker.create();

  if (opts.token === undefined) {
    // No overlay needed — plugin reads whatever is already in env.
    return build();
  }
  return withEnvOverride({ [ENV_VAR[kind]]: opts.token }, build);
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
