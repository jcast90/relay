import { ChannelStore } from "../channels/channel-store.js";
import type { RepoAssignment } from "../domain/channel.js";
import { getHarnessStore } from "../storage/factory.js";

/**
 * Result of a `pr_review_start` invocation.
 *
 * `reused` distinguishes "returned an existing DM" (idempotent replay) from
 * "minted a new DM" so callers can decide whether to re-post kickoff context
 * without running `getChannel` first.
 */
export interface StartPrReviewDmResult {
  channelId: string;
  parentChannelId: string | null;
  prUrl: string;
  reused: boolean;
}

export interface StartPrReviewDmInput {
  prUrl: string;
  title?: string;
  /**
   * Injected store — defaults to the process-wide `~/.relay`-backed store.
   * Tests pass a tmp-dir-backed `ChannelStore` to avoid polluting the real
   * channels directory.
   */
  store?: ChannelStore;
}

/**
 * Parse a github.com PR URL into its (owner, name, number) triple.
 * Rejects non-github and non-`/pull/` URLs so the caller gets a structured
 * error rather than silently minting a DM tied to a garbage URL.
 */
export function parseGithubPrUrl(
  url: string
): { owner: string; name: string; number: number; canonicalUrl: string } | null {
  const m = url
    .trim()
    .match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+?)\/pull\/(\d+)(?:[/?#].*)?$/i);
  if (!m) return null;
  const [, owner, name, numStr] = m;
  const number = Number(numStr);
  return {
    owner,
    name,
    number,
    canonicalUrl: `https://github.com/${owner}/${name}/pull/${number}`,
  };
}

/**
 * Locate a `general` channel whose `repoAssignments` reference the supplied
 * repo (by alias matching `repoName`, case-insensitive). Used to decide
 * whether the PR-review DM has a parent to cross-link against. Returns
 * `null` when no match exists — the DM is then standalone, which is the
 * expected shape for PRs against repos the user hasn't registered with Relay.
 */
export async function findGeneralChannelForRepo(
  store: ChannelStore,
  repoName: string
): Promise<{ channelId: string; repoAssignment: RepoAssignment } | null> {
  const active = await store.listChannels("active");
  const normalizedRepo = repoName.toLowerCase();
  for (const c of active) {
    const channelName = c.name.toLowerCase();
    if (channelName !== "general" && channelName !== "#general") continue;
    const match = (c.repoAssignments ?? []).find((r) => r.alias.toLowerCase() === normalizedRepo);
    if (match) return { channelId: c.channelId, repoAssignment: match };
  }
  return null;
}

/**
 * Resolve or create a DM-style review thread for a GitHub pull request.
 *
 * Idempotent by `prUrl`: a second call with the same URL returns the existing
 * DM without posting a duplicate kickoff entry. When the PR's repo has an
 * active `general` channel registered with Relay, the new DM backlinks to it
 * and a cross-link entry is posted there; otherwise the DM is standalone.
 */
export async function startPrReviewDm(input: StartPrReviewDmInput): Promise<StartPrReviewDmResult> {
  const parsed = parseGithubPrUrl(input.prUrl);
  if (!parsed) {
    throw new Error(
      `prUrl must be a github.com pull request URL (got: ${JSON.stringify(input.prUrl)})`
    );
  }

  const store = input.store ?? new ChannelStore(undefined, getHarnessStore());

  const existing = await store.findChannelByPrUrl(parsed.canonicalUrl);
  if (existing) {
    return {
      channelId: existing.channelId,
      parentChannelId: existing.pr?.parentChannelId ?? null,
      prUrl: parsed.canonicalUrl,
      reused: true,
    };
  }

  const parent = await findGeneralChannelForRepo(store, parsed.name);

  const dm = await store.createPrDm({
    pr: {
      url: parsed.canonicalUrl,
      number: parsed.number,
      repo: { owner: parsed.owner, name: parsed.name },
      state: "open",
      title: input.title,
      parentChannelId: parent?.channelId,
    },
    repoAssignment: parent?.repoAssignment,
    workspaceId: parent?.repoAssignment?.workspaceId,
  });

  await store.postEntry(dm.channelId, {
    type: "status_update",
    fromAgentId: null,
    fromDisplayName: "PR Review",
    content: `Reviewing pull request: ${parsed.canonicalUrl}`,
    metadata: {
      prUrl: parsed.canonicalUrl,
      prNumber: parsed.number,
      repoOwner: parsed.owner,
      repoName: parsed.name,
    },
  });

  if (parent) {
    await store.postEntry(parent.channelId, {
      type: "pr_link",
      fromAgentId: null,
      fromDisplayName: "PR Review",
      content: `PR opened: ${parsed.canonicalUrl} — review thread started.`,
      metadata: {
        prUrl: parsed.canonicalUrl,
        prNumber: parsed.number,
        dmChannelId: dm.channelId,
      },
    });
  }

  return {
    channelId: dm.channelId,
    parentChannelId: parent?.channelId ?? null,
    prUrl: parsed.canonicalUrl,
    reused: false,
  };
}
