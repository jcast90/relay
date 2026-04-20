import { describe, expect, it, vi } from "vitest";

import { wrapScm, type HarnessPR } from "../../src/integrations/scm.js";

function makePr(overrides: Partial<HarnessPR> = {}): HarnessPR {
  return {
    number: overrides.number ?? 7,
    url: overrides.url ?? "https://github.com/acme/widgets/pull/7",
    branch: overrides.branch ?? "feat/seven"
  };
}

const projectDescriptor = {
  owner: "acme",
  name: "widgets",
  path: "/tmp/repo",
  defaultBranch: "main"
};

describe("wrapScm — facade delegation", () => {
  it("detectPR passes branch via stub session and maps PRInfo to HarnessPR", async () => {
    const detectPR = vi.fn(async () => ({
      number: 7,
      url: "https://github.com/acme/widgets/pull/7",
      branch: "feat/seven",
      title: "feat: seven",
      owner: "acme",
      repo: "widgets",
      baseBranch: "main",
      isDraft: false
    }));

    const scm = { name: "gh", detectPR } as any;

    const wrapped = wrapScm(scm, projectDescriptor);
    const res = await wrapped.detectPR("feat/seven", { owner: "acme", name: "widgets" });

    expect(res).toEqual({
      number: 7,
      url: "https://github.com/acme/widgets/pull/7",
      branch: "feat/seven"
    });
    const firstCall = detectPR.mock.calls[0] as unknown as [
      { branch: string },
      unknown
    ] | undefined;
    expect(firstCall).toBeDefined();
    expect(firstCall![0].branch).toBe("feat/seven");
  });

  it("getCiSummary, getReviewDecision, getPendingComments call through", async () => {
    const scm = {
      name: "gh",
      getCISummary: vi.fn(async () => "failing" as const),
      getReviewDecision: vi.fn(async () => "changes_requested" as const),
      getPendingComments: vi.fn(async () => [
        {
          id: "c1",
          author: "alice",
          body: "nit: rename",
          path: "src/a.ts",
          line: 10,
          isResolved: false,
          createdAt: new Date(),
          url: "https://github.com/acme/widgets/pull/7#c1"
        }
      ])
    } as any;

    const wrapped = wrapScm(scm, projectDescriptor);
    const pr = makePr();

    expect(await wrapped.getCiSummary(pr)).toBe("failing");
    expect(await wrapped.getReviewDecision(pr)).toBe("changes_requested");

    const comments = await wrapped.getPendingComments(pr);
    expect(comments).toEqual([
      { id: "c1", author: "alice", body: "nit: rename", path: "src/a.ts", line: 10 }
    ]);

    expect(scm.getCISummary).toHaveBeenCalledTimes(1);
    const ciCall = scm.getCISummary.mock.calls[0] as unknown as [
      { number: number; owner: string; repo: string }
    ] | undefined;
    expect(ciCall).toBeDefined();
    expect(ciCall![0].number).toBe(7);
    expect(ciCall![0].owner).toBe("acme");
    expect(ciCall![0].repo).toBe("widgets");
  });

  it("enrichBatch prefers scm.enrichSessionsPRBatch when available", async () => {
    const scm = {
      name: "gh",
      enrichSessionsPRBatch: vi.fn(async () =>
        new Map([
          [
            "acme/widgets#7",
            {
              state: "open" as const,
              ciStatus: "passing" as const,
              reviewDecision: "approved" as const,
              mergeable: true
            }
          ]
        ])
      ),
      // Fallback methods should NOT be called when the batch method exists.
      getPRState: vi.fn(),
      getCISummary: vi.fn(),
      getReviewDecision: vi.fn()
    } as any;

    const wrapped = wrapScm(scm, projectDescriptor);
    const result = await wrapped.enrichBatch([makePr()]);

    expect(scm.enrichSessionsPRBatch).toHaveBeenCalledTimes(1);
    expect(scm.getPRState).not.toHaveBeenCalled();
    expect(scm.getCISummary).not.toHaveBeenCalled();
    expect(scm.getReviewDecision).not.toHaveBeenCalled();

    expect(result.get("acme/widgets#7")).toEqual({
      ci: "passing",
      review: "approved",
      prState: "open"
    });
  });
});

describe("wrapScm — enrichBatch fallback", () => {
  it("falls back to per-PR getPRState/getCISummary/getReviewDecision and keys correctly", async () => {
    const scm = {
      name: "gh",
      // no enrichSessionsPRBatch defined
      getPRState: vi.fn(async () => "open" as const),
      getCISummary: vi.fn(async () => "failing" as const),
      getReviewDecision: vi.fn(async () => "pending" as const)
    } as any;

    const wrapped = wrapScm(scm, projectDescriptor);
    const prs = [
      makePr({ number: 1, url: "u1", branch: "b1" }),
      makePr({ number: 2, url: "u2", branch: "b2" })
    ];
    const result = await wrapped.enrichBatch(prs);

    expect(result.size).toBe(2);
    expect(result.get("acme/widgets#1")).toEqual({
      prState: "open",
      ci: "failing",
      review: "pending"
    });
    expect(result.get("acme/widgets#2")).toEqual({
      prState: "open",
      ci: "failing",
      review: "pending"
    });

    // Per-PR calls: 2 PRs × 3 methods
    expect(scm.getPRState).toHaveBeenCalledTimes(2);
    expect(scm.getCISummary).toHaveBeenCalledTimes(2);
    expect(scm.getReviewDecision).toHaveBeenCalledTimes(2);
  });
});
