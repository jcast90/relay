import { describe, expect, it, vi, beforeEach } from "vitest";

// --- Mock the tracker module (the single AO boundary) so no network is hit. ---

const mocks = vi.hoisted(() => ({
  createTracker: vi.fn(),
  resolveIssue: vi.fn(),
  // detectTrackerKind uses the real implementation — only URL pattern sniffing.
  detectTrackerKindReal: (input: string): "github" | "linear" | null => {
    const s = input.trim();
    if (!s) return null;
    if (/^https?:\/\/(?:www\.)?github\.com\/[^/]+\/[^/]+\/issues\/\d+/i.test(s)) return "github";
    if (/^https?:\/\/(?:www\.)?linear\.app\/[^/]+\/issue\/[A-Z][A-Z0-9]*-\d+/i.test(s))
      return "linear";
    if (/^[A-Z][A-Z0-9]*-\d+$/.test(s)) return "linear";
    return null;
  },
}));

vi.mock("../../src/integrations/tracker.js", () => ({
  createTracker: mocks.createTracker,
  resolveIssue: mocks.resolveIssue,
  detectTrackerKind: (input: string) => mocks.detectTrackerKindReal(input),
}));

import { classifyRequest } from "../../src/orchestrator/classifier.js";
import type { AgentResult, WorkRequest } from "../../src/domain/agent.js";
import type { HarnessRun } from "../../src/domain/run.js";

function buildRun(featureRequest: string): HarnessRun {
  const now = new Date().toISOString();
  return {
    id: "run-test",
    featureRequest,
    state: "CLASSIFYING",
    startedAt: now,
    updatedAt: now,
    completedAt: null,
    channelId: null,
    classification: null,
    plan: null,
    ticketPlan: null,
    events: [],
    evidence: [],
    artifacts: [],
    phaseLedger: [],
    phaseLedgerPath: null,
    ticketLedger: [],
    ticketLedgerPath: null,
    runIndexPath: null,
  };
}

describe("classifyRequest — tracker URL ingestion", () => {
  beforeEach(() => {
    mocks.createTracker.mockReset();
    mocks.resolveIssue.mockReset();
  });

  it("enriches the feature request and emits suggestedBranch when the tracker resolves", async () => {
    const url = "https://github.com/acme/widgets/issues/42";

    const fakeTracker = { name: "github" };
    mocks.createTracker.mockReturnValue(fakeTracker);
    mocks.resolveIssue.mockResolvedValue({
      id: "iss-42",
      title: "Add a complete user management system with RBAC",
      body: "We need RBAC with org scoping and row-level policies.",
      url,
      labels: ["feature", "backend"],
      branchName: "42-add-user-management",
    });

    // Dispatch receives the enriched feature request; capture and respond.
    let captured: Omit<WorkRequest, "runId"> | null = null;
    const dispatch = vi.fn(async (_run: HarnessRun, req: Omit<WorkRequest, "runId">) => {
      captured = req;
      const result: AgentResult = {
        summary: "Classified",
        evidence: [],
        proposedCommands: [],
        blockers: [],
        rawResponse: JSON.stringify({
          classification: {
            tier: "feature_large",
            rationale: "Large cross-cutting feature.",
            suggestedSpecialties: ["api_crud", "ui"],
            estimatedTicketCount: 5,
            needsDesignDoc: false,
            needsUserApproval: true,
          },
        }),
      };
      return result;
    });

    const classification = await classifyRequest({
      run: buildRun(url),
      featureRequest: url,
      repoRoot: "/tmp/fake-repo",
      dispatch,
    });

    // Tracker seam was exercised with parsed identifier "42".
    expect(mocks.createTracker).toHaveBeenCalledWith("github");
    expect(mocks.resolveIssue).toHaveBeenCalledTimes(1);
    expect(mocks.resolveIssue.mock.calls[0][1]).toBe("42");

    // Classifier dispatched with enriched objective (title + labels + body).
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(captured).not.toBeNull();
    const req = captured as unknown as Omit<WorkRequest, "runId">;
    expect(req.objective).toContain("Add a complete user management system with RBAC");
    expect(req.objective).toContain("Labels: feature, backend");
    expect(req.objective).toContain("org scoping and row-level policies");
    expect(req.context.some((c) => c.includes(url))).toBe(true);

    // Classification result carries suggestedBranch from the tracker.
    expect(classification.tier).toBe("feature_large");
    expect(classification.suggestedBranch).toBe("42-add-user-management");
  });

  it("applies heuristic classification on enriched text (trivial) and still emits suggestedBranch", async () => {
    const url = "https://github.com/acme/widgets/issues/7";
    mocks.createTracker.mockReturnValue({ name: "github" });
    mocks.resolveIssue.mockResolvedValue({
      id: "iss-7",
      title: "Fix typo in README",
      body: "Small docs fix.",
      url,
      labels: [],
      branchName: "7-fix-typo",
    });

    // Heuristic should short-circuit — dispatch must NOT be called.
    const dispatch = vi.fn(async () => ({
      summary: "",
      evidence: [],
      proposedCommands: [],
      blockers: [],
    }));

    const result = await classifyRequest({
      run: buildRun(url),
      featureRequest: url,
      repoRoot: "/tmp/fake-repo",
      dispatch,
    });

    expect(dispatch).not.toHaveBeenCalled();
    expect(result.tier).toBe("trivial");
    expect(result.suggestedBranch).toBe("7-fix-typo");
  });

  it("gracefully degrades when the tracker throws: no crash, no suggestedBranch", async () => {
    const url = "https://github.com/acme/widgets/issues/99";
    mocks.createTracker.mockImplementation(() => {
      throw new Error("GITHUB_TOKEN not set");
    });

    const dispatch = vi.fn(async (_run: HarnessRun, _req: Omit<WorkRequest, "runId">) => ({
      summary: "ok",
      evidence: [],
      proposedCommands: [],
      blockers: [],
      rawResponse: JSON.stringify({
        classification: {
          tier: "feature_small",
          rationale: "Modest feature.",
          suggestedSpecialties: ["general"],
          estimatedTicketCount: 2,
          needsDesignDoc: false,
          needsUserApproval: false,
        },
      }),
    }));

    const classification = await classifyRequest({
      run: buildRun(url),
      featureRequest: url,
      repoRoot: "/tmp/fake-repo",
      dispatch,
    });

    // Classification still returned, and the original URL text was fed straight to dispatch.
    expect(classification.tier).toBe("feature_small");
    expect(classification.suggestedBranch).toBeUndefined();

    // Dispatch was called with the raw URL (no enrichment happened).
    expect(dispatch).toHaveBeenCalledTimes(1);
    const req = dispatch.mock.calls[0][1];
    expect(req.objective).toBe(url);
  });
});

/**
 * Projects v2 URL ingestion. The new code path goes through
 * `src/integrations/github-projects/client.ts` (not the AO tracker
 * module mocked above), so we stub the network with an injected
 * `fetch` on `projectsDeps`. The tracker mock above stays in place
 * because the classifier still calls `detectTrackerKind` for inputs
 * that aren't Projects URLs.
 */
describe("classifyRequest — GitHub Projects v2 URL ingestion", () => {
  beforeEach(() => {
    mocks.createTracker.mockReset();
    mocks.resolveIssue.mockReset();
  });

  function projectItemFetchStub(): typeof fetch {
    // Single-call stub returning a populated ProjectV2Item with a parent
    // epic and a containing project.
    return vi.fn(async () => {
      return new Response(
        JSON.stringify({
          data: {
            node: {
              id: "PVTI_lADO",
              project: {
                id: "PVT_xyz",
                title: "relay-core-ui",
                number: 3,
                url: "https://github.com/users/jcast90/projects/3",
              },
              parent: {
                id: "PVTI_parent",
                content: { __typename: "DraftIssue", title: "Q4 launch readiness" },
              },
              content: {
                __typename: "DraftIssue",
                title: "Wire approval-gate hook into TUI",
                body: "Long-form description of the ticket goes here.",
              },
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as unknown as typeof fetch;
  }

  it("enriches the feature request from a user-owned item URL via stubbed fetch", async () => {
    const url = "https://github.com/users/jcast90/projects/3/views/1?pane=issue&itemId=PVTI_lADO";

    let captured: Omit<WorkRequest, "runId"> | null = null;
    const dispatch = vi.fn(async (_run: HarnessRun, req: Omit<WorkRequest, "runId">) => {
      captured = req;
      const result: AgentResult = {
        summary: "Classified",
        evidence: [],
        proposedCommands: [],
        blockers: [],
        rawResponse: JSON.stringify({
          classification: {
            tier: "feature_small",
            rationale: "Modest feature.",
            suggestedSpecialties: ["general"],
            estimatedTicketCount: 2,
            needsDesignDoc: false,
            needsUserApproval: false,
          },
        }),
      };
      return result;
    });

    const fetchStub = projectItemFetchStub();
    const classification = await classifyRequest({
      run: buildRun(url),
      featureRequest: url,
      repoRoot: "/tmp/fake-repo",
      dispatch,
      projectsDeps: { token: "ghp_fake", fetch: fetchStub },
    });

    // The AO-tracker boundary was NEVER touched — this is a Projects URL,
    // not an Issue URL.
    expect(mocks.createTracker).not.toHaveBeenCalled();
    expect(mocks.resolveIssue).not.toHaveBeenCalled();

    // Item context flowed into the classifier prompt.
    expect(dispatch).toHaveBeenCalledTimes(1);
    const req = captured as unknown as Omit<WorkRequest, "runId">;
    expect(req.objective).toContain("Wire approval-gate hook into TUI");
    expect(req.objective).toContain("Parent epic: Q4 launch readiness");
    expect(req.objective).toContain("Project: relay-core-ui");
    expect(req.objective).toContain(url);

    // Project + parent surfaced as separate context lines too.
    expect(req.context.some((c) => c.includes("relay-core-ui"))).toBe(true);
    expect(req.context.some((c) => c.includes("Q4 launch readiness"))).toBe(true);

    expect(classification.tier).toBe("feature_small");
  });

  it("returns the deferred-error result for a project-only URL without hitting the network", async () => {
    const url = "https://github.com/users/jcast90/projects/3";

    const fetchStub = vi.fn(
      async () => new Response("{}", { status: 200 })
    ) as unknown as typeof fetch;
    const dispatch = vi.fn(async () => ({
      summary: "should not be called",
      evidence: [],
      proposedCommands: [],
      blockers: [],
    }));

    const result = await classifyRequest({
      run: buildRun(url),
      featureRequest: url,
      repoRoot: "/tmp/fake-repo",
      dispatch,
      projectsDeps: { token: "ghp_fake", fetch: fetchStub },
    });

    // No fetch, no dispatch — deferred message returned synchronously.
    expect(fetchStub).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(result.tier).toBe("feature_small");
    expect(result.rationale).toMatch(/deferred/);
    expect(result.needsUserApproval).toBe(true);
  });

  it("falls back gracefully when the GraphQL call fails", async () => {
    const url = "https://github.com/orgs/acme/projects/9?itemId=PVTI_bad";

    const fetchStub = vi.fn(
      async () => new Response("internal error", { status: 500 })
    ) as unknown as typeof fetch;
    const dispatch = vi.fn(async () => ({
      summary: "should not be called for deferred",
      evidence: [],
      proposedCommands: [],
      blockers: [],
    }));

    const result = await classifyRequest({
      run: buildRun(url),
      featureRequest: url,
      repoRoot: "/tmp/fake-repo",
      dispatch,
      projectsDeps: { token: "ghp_fake", fetch: fetchStub },
    });

    expect(fetchStub).toHaveBeenCalledTimes(1);
    // Deferred fallback path: no LLM dispatch, classification still returned.
    expect(dispatch).not.toHaveBeenCalled();
    expect(result.tier).toBe("feature_small");
    expect(result.rationale).toMatch(/HTTP 500/);
  });

  it("does NOT regress GitHub Issue URL parsing — still flows through the AO tracker boundary", async () => {
    // Issue URLs must keep going through the existing path; the new
    // Projects parser should return null on this shape.
    const url = "https://github.com/acme/widgets/issues/42";

    mocks.createTracker.mockReturnValue({ name: "github" });
    mocks.resolveIssue.mockResolvedValue({
      id: "iss-42",
      title: "Add user management",
      body: "Body",
      url,
      labels: ["feature"],
      branchName: "42-add-user-management",
    });

    const dispatch = vi.fn(async (_run: HarnessRun, _req: Omit<WorkRequest, "runId">) => ({
      summary: "Classified",
      evidence: [],
      proposedCommands: [],
      blockers: [],
      rawResponse: JSON.stringify({
        classification: {
          tier: "feature_small",
          rationale: "Modest feature.",
          suggestedSpecialties: ["general"],
          estimatedTicketCount: 2,
          needsDesignDoc: false,
          needsUserApproval: false,
        },
      }),
    }));

    // We pass `projectsDeps` to be sure the new code path gracefully
    // ignores Issue URLs (no calls into the stubbed fetch).
    const fetchStub = vi.fn(
      async () => new Response("{}", { status: 200 })
    ) as unknown as typeof fetch;

    const result = await classifyRequest({
      run: buildRun(url),
      featureRequest: url,
      repoRoot: "/tmp/fake-repo",
      dispatch,
      projectsDeps: { token: "ghp_fake", fetch: fetchStub },
    });

    expect(fetchStub).not.toHaveBeenCalled();
    expect(mocks.createTracker).toHaveBeenCalledWith("github");
    expect(mocks.resolveIssue).toHaveBeenCalledTimes(1);
    expect(result.suggestedBranch).toBe("42-add-user-management");
  });
});
