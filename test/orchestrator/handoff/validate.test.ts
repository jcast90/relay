import { describe, expect, it } from "vitest";

import { validateBrief } from "../../../src/orchestrator/handoff/validate.js";
import type { HandoffBrief } from "../../../src/orchestrator/handoff/types.js";

function makeBrief(overrides: Partial<HandoffBrief> = {}): HandoffBrief {
  const base: HandoffBrief = {
    schemaVersion: 1,
    briefId: "brief-1746789000000-abc123",
    channelId: "ch-fixmin-0001",
    channelName: "fixture-min",
    generatedAt: "2026-05-09T12:00:00.000Z",
    fromProvider: "claude",
    fromSessionId: "sess-fixsrc-0001",
    toHint: null,
    sections: {
      statusSnapshot: { heading: "Status snapshot", body: "ok", estimatedTokens: 1 },
      mission: { heading: "Mission", body: "ok", estimatedTokens: 1 },
      ticketDag: { heading: "Ticket DAG", body: "ok", estimatedTokens: 1 },
      recentDecisions: { heading: "Recent decisions", body: "ok", estimatedTokens: 1 },
      filesTouched: { heading: "Files touched", body: "ok", estimatedTokens: 1 },
      workingMemory: { heading: "Working memory", body: "ok", estimatedTokens: 1 },
    },
    tokenEstimate: 6,
  };
  return { ...base, ...overrides };
}

describe("validateBrief — STRICT mode", () => {
  it("returns ok:true when under cap and all sections present", () => {
    const result = validateBrief(makeBrief(), { mode: "strict" });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("flags when total tokenEstimate exceeds the hard cap", () => {
    const brief = makeBrief({ tokenEstimate: 9000 });
    const result = validateBrief(brief, { mode: "strict" });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /hard cap/i.test(e))).toBe(true);
  });

  it("respects an overridden maxTokens", () => {
    const result = validateBrief(makeBrief({ tokenEstimate: 100 }), {
      mode: "strict",
      maxTokens: 50,
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/hard cap.*100.*50/);
  });

  it("flags missing required sections", () => {
    const brief = makeBrief();
    // simulate a missing section
    (brief.sections as unknown as Record<string, unknown>).mission = {
      heading: "",
      body: "",
      estimatedTokens: 0,
    };
    const result = validateBrief(brief, { mode: "strict" });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /Required section.*mission/i.test(e))).toBe(true);
  });

  it("rejects a brief whose body matches the AWS access-key pattern (no --force override)", () => {
    const brief = makeBrief();
    brief.sections.statusSnapshot.body =
      "Note: AKIAIOSFODNN7EXAMPLE was the example key from old docs.";
    const result = validateBrief(brief, { mode: "strict" });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /AWS access key/.test(e))).toBe(true);
    // Critical: matched substring is NEVER returned (defense in depth — T-02-04).
    expect(result.errors.some((e) => /AKIAIOSFODNN7EXAMPLE/.test(e))).toBe(false);
  });

  it("rejects a PEM private key block in any section", () => {
    const brief = makeBrief();
    brief.sections.workingMemory.body =
      "We tried pasting -----BEGIN RSA PRIVATE KEY----- as a placeholder.";
    const result = validateBrief(brief, { mode: "strict" });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /PEM private key/.test(e))).toBe(true);
  });

  it("emits a soft-cap warning when above 4000 but below the hard cap", () => {
    const result = validateBrief(makeBrief({ tokenEstimate: 5000 }), { mode: "strict" });
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => /soft cap/i.test(w))).toBe(true);
  });

  it("warns on truncated sections", () => {
    const brief = makeBrief();
    brief.sections.recentDecisions.truncated = true;
    const result = validateBrief(brief, { mode: "strict" });
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => /truncated/i.test(w))).toBe(true);
  });
});

describe("validateBrief — PERMISSIVE mode (M2)", () => {
  it("accepts a too-long brief without errors (token-cap demoted to warning)", () => {
    const result = validateBrief(makeBrief({ tokenEstimate: 9000 }), { mode: "permissive" });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings.some((w) => /cap/i.test(w))).toBe(true);
  });

  it("accepts a brief with a missing required section (skipped in PERMISSIVE)", () => {
    const brief = makeBrief();
    (brief.sections as unknown as Record<string, unknown>).mission = {
      heading: "",
      body: "",
      estimatedTokens: 0,
    };
    const result = validateBrief(brief, { mode: "permissive" });
    expect(result.ok).toBe(true);
  });

  it("STILL rejects a secret-pattern body (secret-pattern is HARD in BOTH modes — D-09)", () => {
    const brief = makeBrief();
    brief.sections.statusSnapshot.body = "key=AKIAIOSFODNN7EXAMPLE";
    const result = validateBrief(brief, { mode: "permissive" });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /AWS access key/.test(e))).toBe(true);
  });

  it("STILL rejects a key=value secret in permissive mode", () => {
    const brief = makeBrief();
    brief.sections.workingMemory.body = "config snippet: password=hunter2hunter2";
    const result = validateBrief(brief, { mode: "permissive" });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /Generic key=value/i.test(e))).toBe(true);
  });
});
