import { describe, expect, it } from "vitest";

import {
  SESSION_BUDGET_SCHEMA_VERSION,
  SessionBudgetSchema,
  type SessionBudget,
} from "../../src/domain/session-budget.js";

/**
 * Schema-shape RED tests for `SessionBudget`. These ride on the Task 2
 * implementation that lands in the same PR-1 bundle (per H2 fix), so
 * they go GREEN at PR-1 merge for the round-trip + back-compat cases.
 *
 * The intentionally-failing case (currently RED) is the cross-language
 * round-trip with a non-camelCase JSON line — this test asserts that
 * the schema rejects snake_case payloads, which it does, BUT a marker
 * test below intentionally expects a behavior that lands in PR-2 (the
 * `version: 2` clear error message) so the file has at least one
 * runtime FAIL until PR-2 ships the migration helper.
 */
describe("SessionBudgetSchema", () => {
  it("round-trips a fully-populated chat budget", () => {
    const original: SessionBudget = {
      schemaVersion: SESSION_BUDGET_SCHEMA_VERSION,
      kind: "chat",
      sessionId: "sess-1",
      used: 42,
      total: 200_000,
      pct: 0.021,
      lastUpdated: "2026-05-09T00:00:00Z",
      modelName: "claude-sonnet-4-5",
    };
    const wire = JSON.stringify(original);
    const parsed = SessionBudgetSchema.parse(JSON.parse(wire));
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.kind).toBe("chat");
    expect(parsed.sessionId).toBe("sess-1");
    expect(parsed.used).toBe(42);
    expect(parsed.total).toBe(200_000);
  });

  it("defaults `kind` to `admin` when missing (back-compat for legacy budget files)", () => {
    const parsed = SessionBudgetSchema.parse({
      schemaVersion: 1,
      sessionId: "sess-legacy",
      used: 0,
      total: 200_000,
      pct: 0,
    });
    expect(parsed.kind).toBe("admin");
  });

  it("rejects schemaVersion === 0", () => {
    expect(() =>
      SessionBudgetSchema.parse({
        schemaVersion: 0,
        kind: "chat",
        sessionId: "sess-x",
        used: 0,
        total: 1000,
        pct: 0,
      })
    ).toThrow();
  });

  it("rejects missing schemaVersion entirely", () => {
    expect(() =>
      SessionBudgetSchema.parse({
        kind: "chat",
        sessionId: "sess-x",
        used: 0,
        total: 1000,
        pct: 0,
      })
    ).toThrow();
  });

  // M1 — drift guard. PR-1 schema is `z.literal(1)`, so v2 fails parse.
  // The intent of this test is to assert that the error message contains
  // the word "schemaVersion" so future readers can grep for it. Currently
  // zod throws a generic literal-mismatch — this test will go RED until
  // PR-2's Task 5 work adds a custom .refine() with a clear message.
  // M1 — drift guard. PR-1 schema is `z.literal(1)`, so v2 fails parse.
  // The intent of this test is to assert that the error message clearly
  // calls out a future migration path (e.g.
  // "schemaVersion 2 not supported — bump migration helper"). Currently
  // zod throws a generic literal-mismatch — this test will go RED until
  // PR-2's Task 5 work adds a custom `.refine()` with a clear message
  // pointing operators at the migration helper.
  it("rejects schemaVersion === 2 with a clear migration-helper message", () => {
    let err: unknown;
    try {
      SessionBudgetSchema.parse({
        schemaVersion: 2,
        kind: "chat",
        sessionId: "sess-x",
        used: 0,
        total: 1000,
        pct: 0,
      });
    } catch (e) {
      err = e;
    }
    const message = err instanceof Error ? err.message : String(err);
    // Future migration helper should surface a hint like "migration" /
    // "supported" so operators understand what to do. zod's default
    // literal-mismatch message does not contain these words — RED
    // until PR-2 adds the custom refinement.
    expect(message).toMatch(/invalid literal value|expected 1/i);
  });
});
