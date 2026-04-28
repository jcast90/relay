/**
 * Pure parser for GitHub Projects v2 URLs. No network, no env reads.
 * Three shapes are recognised, mirroring Decision 5 of
 * docs/design/tracker-projects-mapping.md: item-scoped user/org URLs and
 * project-only (deferred in v0.2). GitHub Issue URLs are intentionally
 * NOT handled here — they live in src/integrations/tracker.ts and
 * continue to flow through the AO Tracker plugin. Returning null means
 * "not a Projects v2 URL"; the classifier falls through.
 */

export type GitHubOwnerType = "user" | "organization";

/** Item-scoped paste. */
export interface ProjectItemUrl {
  kind: "item";
  ownerType: GitHubOwnerType;
  owner: string;
  projectNumber: number;
  itemId: string;
  /** Original input, trimmed. */
  url: string;
}

/** Project-scoped paste. The v0.2 deferred case (no item context). */
export interface ProjectOnlyUrl {
  kind: "project";
  ownerType: GitHubOwnerType;
  owner: string;
  projectNumber: number;
  url: string;
}

export type GitHubProjectsUrl = ProjectItemUrl | ProjectOnlyUrl;

const PROJECT_PATH_RE =
  /^\/(users|orgs)\/([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/projects\/(\d+)(?:\/[^?#]*)?$/;

/**
 * Parse `input` as a GitHub Projects v2 URL. Returns null for anything
 * that is not github.com, is not under /(users|orgs)/.../projects/<n>,
 * or carries a malformed itemId. Trailing slashes, missing query params,
 * and any ordering of pane/itemId are tolerated.
 */
export function parseGithubProjectsUrl(input: string): GitHubProjectsUrl | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  // Lock the host to github.com (tolerate `www.` since users paste it).
  // GHES, gist.github.com, raw.githubusercontent.com, etc. are rejected.
  const host = parsed.host.toLowerCase();
  if (host !== "github.com" && host !== "www.github.com") {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return null;
  }

  const normalisedPath = parsed.pathname.replace(/\/+$/, "") || parsed.pathname;
  const match = normalisedPath.match(PROJECT_PATH_RE);
  if (!match) return null;

  const ownerType: GitHubOwnerType = match[1] === "orgs" ? "organization" : "user";
  const owner = match[2];
  const projectNumber = Number(match[3]);
  if (!Number.isFinite(projectNumber) || projectNumber <= 0) {
    return null;
  }

  const itemId = parsed.searchParams.get("itemId");
  if (itemId) {
    // Project item node ids today begin with `PVTI_` but we accept any
    // non-empty [A-Za-z0-9_-] token to stay forward-compatible if GitHub
    // ever rolls a new prefix. The lookup will fail loudly if the id is
    // bogus.
    if (!/^[A-Za-z0-9_-]+$/.test(itemId)) {
      return null;
    }
    return {
      kind: "item",
      ownerType,
      owner,
      projectNumber,
      itemId,
      url: trimmed,
    };
  }

  return {
    kind: "project",
    ownerType,
    owner,
    projectNumber,
    url: trimmed,
  };
}

/**
 * Human-readable message surfaced when the user pastes a project-only
 * URL (no `itemId`). The "sync the whole project" flow is deferred per
 * Decision 5.
 */
export const PROJECT_ONLY_DEFERRED_MESSAGE =
  "Project-scoped URL paste is deferred to a later PR; paste an item URL " +
  "(open the card in the Projects UI and copy the URL - it should contain " +
  "`itemId=PVTI_...`) instead.";
