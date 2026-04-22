import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { ChannelStore } from "../../src/channels/channel-store.js";
import type { CommandInvoker, CommandResult } from "../../src/agents/command-invoker.js";
import { PrPoller, type TrackedPr } from "../../src/integrations/pr-poller.js";
import {
  PrReviewer,
  buildReviewerPrompt,
  isGodAutomergeEnabled,
  parseReviewOutput,
  reviewPullRequest,
  RELAY_AL7_GOD_AUTOMERGE,
} from "../../src/integrations/pr-reviewer.js";

function makeEntry(overrides: Partial<TrackedPr> = {}): TrackedPr {
  return {
    ticketId: overrides.ticketId ?? "T-1",
    channelId: overrides.channelId ?? "ch-1",
    pr: overrides.pr ?? {
      number: 42,
      url: "https://github.com/acme/widgets/pull/42",
      branch: "feat/42",
    },
    repo: overrides.repo ?? { owner: "acme", name: "widgets" },
    openedByAutonomous: overrides.openedByAutonomous,
  };
}

function mockInvoker(stdout: string, exitCode = 0): CommandInvoker {
  return {
    exec: vi.fn(async (): Promise<CommandResult> => ({ stdout, stderr: "", exitCode })),
  };
}

describe("parseReviewOutput", () => {
  it("counts BLOCKING / NIT markers and extracts file refs", () => {
    const out = [
      "Summary: two-liner",
      "BLOCKING: src/foo/bar.ts has a null-deref risk",
      "NIT: src/foo/bar.ts:42 missing doc",
      "NIT: src/baz/qux.tsx could use extractor",
      "OK: test/foo.test.ts passes",
    ].join("\n");
    const parsed = parseReviewOutput(out);
    expect(parsed).not.toBeNull();
    expect(parsed!.blocking).toBe(1);
    expect(parsed!.nits).toBe(2);
    expect(parsed!.files.sort()).toEqual(["src/baz/qux.tsx", "src/foo/bar.ts", "test/foo.test.ts"]);
    expect(parsed!.summary).toBe("two-liner");
  });

  it("returns null when the reviewer output has no markers (inconclusive)", () => {
    const parsed = parseReviewOutput("I looked at the PR and it seemed fine.");
    expect(parsed).toBeNull();
  });

  it("falls back to the first non-empty line when no Summary: line is present", () => {
    const out = ["This is a headline.", "BLOCKING: src/a.ts is wrong"].join("\n");
    const parsed = parseReviewOutput(out);
    expect(parsed).not.toBeNull();
    expect(parsed!.summary).toBe("This is a headline.");
    expect(parsed!.blocking).toBe(1);
  });

  it("is case insensitive and tolerates bullet prefixes", () => {
    const out = ["- blocking: a/b.ts", "* NIT: c/d.ts", "ok: everything else"].join("\n");
    const parsed = parseReviewOutput(out);
    expect(parsed).not.toBeNull();
    expect(parsed!.blocking).toBe(1);
    expect(parsed!.nits).toBe(1);
    expect(parsed!.files.sort()).toEqual(["a/b.ts", "c/d.ts"]);
  });
});

describe("buildReviewerPrompt", () => {
  it("embeds the PR url and trust mode in the prompt body", () => {
    const prompt = buildReviewerPrompt("https://github.com/acme/widgets/pull/7", "supervised");
    expect(prompt).toContain("https://github.com/acme/widgets/pull/7");
    expect(prompt).toContain("supervised");
    expect(prompt).toContain("BLOCKING");
    expect(prompt).toContain("NIT");
  });
});

describe("isGodAutomergeEnabled", () => {
  it("returns false by default and true for the common truthy values", () => {
    expect(isGodAutomergeEnabled({})).toBe(false);
    expect(isGodAutomergeEnabled({ [RELAY_AL7_GOD_AUTOMERGE]: "" })).toBe(false);
    expect(isGodAutomergeEnabled({ [RELAY_AL7_GOD_AUTOMERGE]: "false" })).toBe(false);
    for (const truthy of ["1", "true", "yes", "on", "TRUE", "On"]) {
      expect(isGodAutomergeEnabled({ [RELAY_AL7_GOD_AUTOMERGE]: truthy })).toBe(true);
    }
  });
});

describe("reviewPullRequest", () => {
  it("runs the reviewer, parses output, and posts a feed entry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pr-reviewer-happy-"));
    const store = new ChannelStore(dir);
    try {
      const channel = await store.createChannel({ name: "#pr-rev", description: "" });
      const entry = makeEntry({
        channelId: channel.channelId,
        openedByAutonomous: true,
      });

      const stdout = [
        "Summary: LGTM overall",
        "BLOCKING: src/integrations/pr-reviewer.ts leaks a handle",
        "NIT: test/foo.test.ts missing case",
        "OK: build passes",
      ].join("\n");
      const invoker = mockInvoker(stdout);
      const checkout = vi.fn(async () => {});
      const result = await reviewPullRequest(entry, {
        trustMode: "supervised",
        invoker,
        checkout,
        channelStore: store,
        channelId: channel.channelId,
        clock: () => 1_700_000_000_000,
      });

      expect(result.findings.blocking).toBe(1);
      expect(result.findings.nits).toBe(1);
      expect(result.findings.status).toBe("ready_for_human_ack");
      expect(result.trackedPrStatus).toBe("ready_for_human_ack");
      expect(result.findings.reviewedAt).toBe(new Date(1_700_000_000_000).toISOString());
      expect(checkout).toHaveBeenCalledWith(entry, expect.any(String));
      // invoker should see a claude spawn with -p, the prompt, and the
      // B2 capability-restriction flag keeping the reviewer read-only.
      const call = (invoker.exec as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[0].command).toBe("claude");
      expect(call[0].args[0]).toBe("-p");
      expect(call[0].args[1]).toContain(entry.pr.url);
      expect(call[0].args).toContain("--disallowedTools");
      const disallowedIdx = call[0].args.indexOf("--disallowedTools");
      expect(call[0].args[disallowedIdx + 1]).toBe("Bash,Edit,Write,NotebookEdit");
      // B2: GITHUB_TOKEN / GH_TOKEN are NOT in the reviewer's passEnv.
      // The defaultCheckout helper gets them separately before the
      // reviewer runs; by the time the subprocess spawns they must be
      // out of scope so a jailbroken prompt can't push commits.
      expect(call[0].passEnv).not.toContain("GITHUB_TOKEN");
      expect(call[0].passEnv).not.toContain("GH_TOKEN");

      const feed = await store.readFeed(channel.channelId);
      const reviewerEntry = feed.find((e) => e.fromDisplayName === "pr-reviewer");
      expect(reviewerEntry).toBeDefined();
      expect(reviewerEntry!.content).toContain("1 blocking");
      expect(reviewerEntry!.metadata.reviewStatus).toBe("ready_for_human_ack");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("surfaces an error when gh pr checkout fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pr-reviewer-checkout-fail-"));
    const store = new ChannelStore(dir);
    try {
      const channel = await store.createChannel({ name: "#pr-rev", description: "" });
      const entry = makeEntry({
        channelId: channel.channelId,
        openedByAutonomous: true,
      });
      const invoker = mockInvoker("");
      const checkout = vi.fn(async () => {
        throw new Error("gh: not authenticated");
      });
      const result = await reviewPullRequest(entry, {
        trustMode: "supervised",
        invoker,
        checkout,
        channelStore: store,
        channelId: channel.channelId,
      });
      expect(result.findings.status).toBe("error");
      expect(result.findings.summary).toContain("gh pr checkout failed");
      // Reviewer must NOT have been invoked when checkout failed.
      expect(invoker.exec).not.toHaveBeenCalled();
      const feed = await store.readFeed(channel.channelId);
      const errEntry = feed.find((e) => e.fromDisplayName === "pr-reviewer");
      expect(errEntry).toBeDefined();
      expect(errEntry!.content).toContain("errored");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("marks output inconclusive when no BLOCKING / NIT / OK markers are present", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pr-reviewer-inconclusive-"));
    const store = new ChannelStore(dir);
    try {
      const channel = await store.createChannel({ name: "#pr-rev", description: "" });
      const entry = makeEntry({
        channelId: channel.channelId,
        openedByAutonomous: true,
      });
      const invoker = mockInvoker("I read the PR. It's fine I guess.");
      const checkout = vi.fn(async () => {});
      const result = await reviewPullRequest(entry, {
        trustMode: "supervised",
        invoker,
        checkout,
        channelStore: store,
        channelId: channel.channelId,
      });
      expect(result.findings.status).toBe("inconclusive");
      expect(result.findings.blocking).toBe(0);
      expect(result.findings.nits).toBe(0);
      const feed = await store.readFeed(channel.channelId);
      const inconclusive = feed.find((e) => e.fromDisplayName === "pr-reviewer");
      expect(inconclusive).toBeDefined();
      expect(inconclusive!.content).toContain("inconclusive");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stubs god-mode auto-merge when RELAY_AL7_GOD_AUTOMERGE is set", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pr-reviewer-god-"));
    const store = new ChannelStore(dir);
    const prev = process.env[RELAY_AL7_GOD_AUTOMERGE];
    process.env[RELAY_AL7_GOD_AUTOMERGE] = "1";
    try {
      const channel = await store.createChannel({ name: "#pr-rev-god", description: "" });
      const entry = makeEntry({
        channelId: channel.channelId,
        openedByAutonomous: true,
      });
      const invoker = mockInvoker(
        ["Summary: ok", "BLOCKING: src/a.ts thing", "OK: tests pass"].join("\n")
      );
      const checkout = vi.fn(async () => {});
      const result = await reviewPullRequest(entry, {
        trustMode: "god",
        invoker,
        checkout,
        channelStore: store,
        channelId: channel.channelId,
      });
      // AL-5 contract: god mode records findings but does NOT merge — row
      // gets a distinct tag so AL-7 can pick it up.
      expect(result.findings.status).toBe("ready_for_human_ack");
      expect(result.trackedPrStatus).toBe("god_merge_pending");
    } finally {
      if (prev === undefined) delete process.env[RELAY_AL7_GOD_AUTOMERGE];
      else process.env[RELAY_AL7_GOD_AUTOMERGE] = prev;
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("PrReviewer (poller integration)", () => {
  it("skips PRs that were NOT opened by an autonomous ticket", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pr-reviewer-filter-"));
    const store = new ChannelStore(dir);
    try {
      const channel = await store.createChannel({ name: "#pr-rev-filter", description: "" });
      const reviewFn = vi.fn(async () => ({
        findings: {
          blocking: 0,
          nits: 0,
          files: [],
          summary: "noop",
          status: "ready_for_human_ack" as const,
          reviewedAt: "2026-01-01T00:00:00.000Z",
        },
        trackedPrStatus: "ready_for_human_ack" as const,
      }));
      const reviewer = new PrReviewer({
        trustMode: "supervised",
        onReviewComplete: vi.fn(),
        channelStore: store,
        reviewFn,
      });

      // Manual track (no openedByAutonomous) — reviewer must ignore it.
      reviewer.handleTrack(makeEntry({ channelId: channel.channelId }));
      // Autonomous track — reviewer should pick it up on the next microtask.
      reviewer.handleTrack(
        makeEntry({
          channelId: channel.channelId,
          ticketId: "T-auto",
          openedByAutonomous: true,
        })
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(reviewFn).toHaveBeenCalledTimes(1);
      const calls = reviewFn.mock.calls as unknown as Array<[TrackedPr, unknown]>;
      const firstCall = calls[0];
      expect(firstCall).toBeDefined();
      expect(firstCall![0].ticketId).toBe("T-auto");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stashes findings onto the PrPoller via setReviewFindings", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pr-reviewer-stash-"));
    const store = new ChannelStore(dir);
    try {
      const channel = await store.createChannel({ name: "#pr-rev-stash", description: "" });
      const scm = {
        detectPR: vi.fn(),
        getCiSummary: vi.fn(),
        getReviewDecision: vi.fn(),
        getPendingComments: vi.fn(),
        enrichBatch: vi.fn(async () => new Map()),
      };
      const scheduler = { enqueueFollowUp: vi.fn(async () => "x") };

      const reviewFn = vi.fn(async () => ({
        findings: {
          blocking: 0,
          nits: 2,
          files: ["src/a.ts"],
          summary: "all nits",
          status: "ready_for_human_ack" as const,
          reviewedAt: "2026-01-01T00:00:00.000Z",
        },
        trackedPrStatus: "ready_for_human_ack" as const,
      }));
      const reviewer = new PrReviewer({
        trustMode: "supervised",
        channelStore: store,
        onReviewComplete: (ticketId, findings) => {
          poller.setReviewFindings(ticketId, findings);
        },
        reviewFn,
      });

      const poller = new PrPoller({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        scm: scm as any,
        channelStore: store,
        scheduler,
        onTrack: (e) => reviewer.handleTrack(e),
      });

      poller.track(
        makeEntry({
          channelId: channel.channelId,
          ticketId: "T-stash",
          openedByAutonomous: true,
        })
      );
      await new Promise((resolve) => setTimeout(resolve, 10));

      const snap = poller.listTracked();
      expect(snap).toHaveLength(1);
      expect(snap[0].reviewFindings).not.toBeNull();
      expect(snap[0].reviewFindings!.nits).toBe(2);
      expect(snap[0].openedByAutonomous).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("deduplicates concurrent reviews for the same ticketId", async () => {
    const reviewFn = vi.fn(
      async () =>
        await new Promise<{
          findings: {
            blocking: number;
            nits: number;
            files: string[];
            summary: string;
            status: "ready_for_human_ack";
            reviewedAt: string;
          };
          trackedPrStatus: "ready_for_human_ack";
        }>((resolve) => {
          setTimeout(
            () =>
              resolve({
                findings: {
                  blocking: 0,
                  nits: 0,
                  files: [],
                  summary: "ok",
                  status: "ready_for_human_ack",
                  reviewedAt: "2026-01-01T00:00:00.000Z",
                },
                trackedPrStatus: "ready_for_human_ack",
              }),
            5
          );
        })
    );
    const reviewer = new PrReviewer({
      trustMode: "supervised",
      onReviewComplete: vi.fn(),
      reviewFn,
    });
    const entry = makeEntry({ openedByAutonomous: true, ticketId: "T-dup" });
    reviewer.handleTrack(entry);
    reviewer.handleTrack(entry);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reviewFn).toHaveBeenCalledTimes(1);
  });
});
