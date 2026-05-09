import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handleChatRecordUsageCommand } from "../../src/cli/chat-record-usage.js";
import { SessionBudgetSchema } from "../../src/domain/session-budget.js";

const RM_OPTS = { recursive: true, force: true, maxRetries: 3, retryDelay: 50 };

/**
 * M6 — full-chain integration smoke. Wires the chat-record-usage entry
 * point through to the budget.jsonl on disk, then re-reads it via
 * `SessionBudgetSchema` to confirm the round-trip holds end-to-end.
 *
 * RED in PR-1 (handleChatRecordUsageCommand stub throws). Goes GREEN
 * once PR-4 (Task 10) lands the implementation. The Rust-side reader is
 * covered by `crates/harness-data/src/lib.rs::tests::session_budget_*`
 * (already GREEN from Task 6 in this PR).
 */
describe.todo("Session-budget end-to-end (M6)", () => {
  let root: string;
  const originalHome = process.env.HOME;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "relay-e2e-budget-"));
    process.env.HOME = root;
  });

  afterEach(async () => {
    if (originalHome) process.env.HOME = originalHome;
    else delete process.env.HOME;
    await rm(root, RM_OPTS);
  });

  it("chat record-usage → budget.jsonl → re-read with SessionBudgetSchema yields the expected pct", async () => {
    await handleChatRecordUsageCommand({
      session: "sess-e2e",
      input: 100_000,
      output: 50_000,
      kind: "chat",
      model: "claude-sonnet-4-5",
    });

    const path = join(root, ".relay", "sessions", "sess-e2e", "budget.jsonl");
    expect(existsSync(path)).toBe(true);

    const text = await readFile(path, "utf8");
    const lastLine = text.trim().split("\n").filter(Boolean).pop();
    expect(lastLine).toBeDefined();
    const parsed = JSON.parse(lastLine!);

    expect(parsed.cumulativeUsed).toBe(150_000);
    expect(parsed.kind).toBe("chat");

    // Build a SessionBudget snapshot from the last line and validate the
    // schema. This is the exact shape the Rust reader (Task 6) produces
    // on its side, so this assert pins the cross-language contract.
    const snapshot = SessionBudgetSchema.parse({
      schemaVersion: 1,
      kind: parsed.kind,
      sessionId: "sess-e2e",
      used: parsed.cumulativeUsed,
      total: 200_000,
      pct: (parsed.cumulativeUsed / 200_000) * 100,
      lastUpdated: parsed.ts,
      modelName: "claude-sonnet-4-5",
    });
    expect(snapshot.pct).toBeCloseTo(75, 5);
  });
});
