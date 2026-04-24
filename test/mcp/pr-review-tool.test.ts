import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ChannelStore } from "../../src/channels/channel-store.js";
import {
  findGeneralChannelForRepo,
  parseGithubPrUrl,
  startPrReviewDm,
} from "../../src/mcp/pr-review-tool.js";

async function tmpStore(): Promise<{ dir: string; store: ChannelStore }> {
  const dir = await mkdtemp(join(tmpdir(), "pr-review-tool-test-"));
  return { dir, store: new ChannelStore(dir) };
}

describe("parseGithubPrUrl", () => {
  it("accepts canonical URLs and normalizes trailing junk", () => {
    expect(parseGithubPrUrl("https://github.com/acme/widgets/pull/42")).toEqual({
      owner: "acme",
      name: "widgets",
      number: 42,
      canonicalUrl: "https://github.com/acme/widgets/pull/42",
    });
    expect(parseGithubPrUrl("https://www.github.com/acme/widgets/pull/42/files")).toEqual({
      owner: "acme",
      name: "widgets",
      number: 42,
      canonicalUrl: "https://github.com/acme/widgets/pull/42",
    });
  });

  it("rejects non-github and non-/pull/ URLs", () => {
    expect(parseGithubPrUrl("https://gitlab.com/acme/widgets/pull/42")).toBeNull();
    expect(parseGithubPrUrl("https://github.com/acme/widgets/issues/42")).toBeNull();
    expect(parseGithubPrUrl("not a url at all")).toBeNull();
  });
});

describe("findGeneralChannelForRepo", () => {
  it("returns the general channel when an assignment alias matches (case-insensitive)", async () => {
    const { dir, store } = await tmpStore();
    try {
      const general = await store.createChannel({
        name: "general",
        description: "welcome",
        repoAssignments: [
          { alias: "Widgets", workspaceId: "widgets-abc", repoPath: "/tmp/widgets" },
        ],
      });

      const hit = await findGeneralChannelForRepo(store, "widgets");
      expect(hit?.channelId).toBe(general.channelId);
      expect(hit?.repoAssignment.workspaceId).toBe("widgets-abc");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("ignores channels not named general and archived matches", async () => {
    const { dir, store } = await tmpStore();
    try {
      await store.createChannel({
        name: "feature-auth",
        description: "wrong channel",
        repoAssignments: [
          { alias: "widgets", workspaceId: "widgets-abc", repoPath: "/tmp/widgets" },
        ],
      });
      const archivedGeneral = await store.createChannel({
        name: "general",
        description: "archived",
        repoAssignments: [
          { alias: "widgets", workspaceId: "widgets-abc", repoPath: "/tmp/widgets" },
        ],
      });
      await store.archiveChannel(archivedGeneral.channelId);

      const miss = await findGeneralChannelForRepo(store, "widgets");
      expect(miss).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("startPrReviewDm", () => {
  const prUrl = "https://github.com/acme/widgets/pull/42";

  it("mints a DM and posts a kickoff entry when no parent exists", async () => {
    const { dir, store } = await tmpStore();
    try {
      const result = await startPrReviewDm({ prUrl, title: "Add dark-mode toggle", store });

      expect(result.reused).toBe(false);
      expect(result.parentChannelId).toBeNull();
      expect(result.prUrl).toBe(prUrl);

      const dm = await store.getChannel(result.channelId);
      expect(dm?.kind).toBe("dm");
      expect(dm?.pr?.url).toBe(prUrl);
      expect(dm?.pr?.state).toBe("open");

      const feedRaw = await readFile(join(dir, result.channelId, "feed.jsonl"), "utf8");
      const entries = feedRaw
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(entries).toHaveLength(1);
      expect(entries[0].type).toBe("status_update");
      expect(entries[0].content).toContain(prUrl);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("posts a cross-link in the repo's general channel when one exists", async () => {
    const { dir, store } = await tmpStore();
    try {
      const general = await store.createChannel({
        name: "general",
        description: "repo home",
        repoAssignments: [
          { alias: "widgets", workspaceId: "widgets-abc", repoPath: "/tmp/widgets" },
        ],
      });

      const result = await startPrReviewDm({ prUrl, store });
      expect(result.parentChannelId).toBe(general.channelId);

      const dm = await store.getChannel(result.channelId);
      expect(dm?.pr?.parentChannelId).toBe(general.channelId);
      expect(dm?.repoAssignments?.[0]?.workspaceId).toBe("widgets-abc");

      const parentFeedRaw = await readFile(join(dir, general.channelId, "feed.jsonl"), "utf8");
      const parentEntries = parentFeedRaw
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const link = parentEntries.find((e) => e.type === "pr_link");
      expect(link).toBeDefined();
      expect(link.metadata.dmChannelId).toBe(result.channelId);
      expect(link.metadata.prUrl).toBe(prUrl);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("is idempotent: second call with the same URL returns the existing DM and adds no entries", async () => {
    const { dir, store } = await tmpStore();
    try {
      const first = await startPrReviewDm({ prUrl, store });
      const second = await startPrReviewDm({ prUrl, store });

      expect(second.reused).toBe(true);
      expect(second.channelId).toBe(first.channelId);

      const feedRaw = await readFile(join(dir, first.channelId, "feed.jsonl"), "utf8");
      const entries = feedRaw.trim().split("\n").filter(Boolean);
      expect(entries).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects non-github URLs with a descriptive error", async () => {
    const { dir, store } = await tmpStore();
    try {
      await expect(
        startPrReviewDm({ prUrl: "https://gitlab.com/x/y/pull/1", store })
      ).rejects.toThrow(/github.com pull request/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
