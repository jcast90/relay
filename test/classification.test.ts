import { describe, expect, it } from "vitest";

import {
  parseClassificationResult,
  tierNeedsApproval,
  tierNeedsDesignDoc,
  tierSkipsPlanning
} from "../src/domain/classification.js";
import {
  classifyByHeuristic,
  buildHeuristicClassification
} from "../src/orchestrator/classifier.js";

describe("classification domain", () => {
  it("parses a valid classification result", () => {
    const result = parseClassificationResult({
      tier: "feature_large",
      rationale: "Complex multi-component feature.",
      suggestedSpecialties: ["ui", "api_crud"],
      estimatedTicketCount: 5,
      needsDesignDoc: false,
      needsUserApproval: true
    });

    expect(result.tier).toBe("feature_large");
    expect(result.suggestedSpecialties).toContain("ui");
    expect(result.needsUserApproval).toBe(true);
  });

  it("rejects invalid tier", () => {
    expect(() =>
      parseClassificationResult({
        tier: "unknown_tier",
        rationale: "Test",
        suggestedSpecialties: [],
        estimatedTicketCount: 1,
        needsDesignDoc: false,
        needsUserApproval: false
      })
    ).toThrow();
  });

  it("tier helpers return correct values", () => {
    expect(tierNeedsApproval("feature_large")).toBe(true);
    expect(tierNeedsApproval("architectural")).toBe(true);
    expect(tierNeedsApproval("multi_repo")).toBe(true);
    expect(tierNeedsApproval("trivial")).toBe(false);
    expect(tierNeedsApproval("feature_small")).toBe(false);

    expect(tierNeedsDesignDoc("architectural")).toBe(true);
    expect(tierNeedsDesignDoc("feature_large")).toBe(false);

    expect(tierSkipsPlanning("trivial")).toBe(true);
    expect(tierSkipsPlanning("bugfix")).toBe(false);
  });
});

describe("classifier heuristics", () => {
  it("classifies trivial requests by pattern", () => {
    expect(classifyByHeuristic("Fix typo in README")).toBe("trivial");
    expect(classifyByHeuristic("Rename variable")).toBe("trivial");
    expect(classifyByHeuristic("Bump version")).toBe("trivial");
    expect(classifyByHeuristic("lint fix")).toBe("trivial");
  });

  it("classifies bugfix requests by pattern", () => {
    expect(classifyByHeuristic("Fix the login bug")).toBe("bugfix");
    expect(classifyByHeuristic("The app is crashing on startup")).toBe("bugfix");
    expect(classifyByHeuristic("Debug the authentication error")).toBe("bugfix");
  });

  it("returns null for complex requests", () => {
    expect(classifyByHeuristic("Add a complete user management system with RBAC")).toBeNull();
    expect(classifyByHeuristic("Implement real-time collaboration")).toBeNull();
  });

  it("builds heuristic classification with correct defaults", () => {
    const result = buildHeuristicClassification("trivial", "Fix typo");

    expect(result.tier).toBe("trivial");
    expect(result.estimatedTicketCount).toBe(1);
    expect(result.needsUserApproval).toBe(false);
    expect(result.needsDesignDoc).toBe(false);
  });
});
