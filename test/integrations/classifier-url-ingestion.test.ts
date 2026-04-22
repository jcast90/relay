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
