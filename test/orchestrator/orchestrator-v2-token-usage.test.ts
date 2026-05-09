import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SessionTrackerPool } from "../../src/budget/session-tracker-pool.js";

const RM_OPTS = { recursive: true, force: true, maxRetries: 3, retryDelay: 50 };

/**
 * RED tests for the orchestrator → tracker pool wiring. PR-1 ships
 * stubs; PR-2 (Task 4) lands the real `OrchestratorV2.dispatch` block
 * that calls `trackerPool.get(...).record(...)` and writes a
 * `kind: "run"` budget line to `~/.relay/sessions/run-<runId>/budget.jsonl`.
 */
describe.todo("OrchestratorV2 dispatch — token-usage wiring", () => {
  let root: string;
  const originalHome = process.env.HOME;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "relay-orch-budget-"));
    process.env.HOME = root;
  });

  afterEach(async () => {
    if (originalHome) process.env.HOME = originalHome;
    else delete process.env.HOME;
    await rm(root, RM_OPTS);
  });

  it("a successful dispatch with tokenUsage records into the pool and writes kind: 'run'", async () => {
    // Drive the public contract through the pool directly — this is the
    // same hot path the orchestrator's dispatch will exercise in PR-2.
    // RED in PR-1 because SessionTrackerPool.get throws.
    const pool = new SessionTrackerPool();
    const tracker = pool.get("run-test-1", 200_000, "run");
    tracker.record(1500, 250);
    await tracker.flush();

    expect(tracker.used).toBeGreaterThan(0);
    const path = join(root, ".relay", "sessions", "run-test-1", "budget.jsonl");
    expect(existsSync(path)).toBe(true);
    const text = await readFile(path, "utf8");
    const lastLine = text.trim().split("\n").filter(Boolean).pop();
    expect(lastLine).toBeDefined();
    const parsed = JSON.parse(lastLine!);
    expect(parsed.cumulativeUsed).toBeGreaterThan(0);
    expect(parsed.kind).toBe("run");
  });

  it("dispatch with an Agent missing capability.model throws a clear error (hidden-assumption fix)", async () => {
    // This test asserts the contract: the orchestrator's dispatch wiring
    // (Task 4) hard-throws when the agent has no model so a session
    // never gets miscalibrated against the default 200_000 ceiling.
    //
    // Phase 1 PR-1: the orchestrator wiring isn't in place yet. The
    // assertion below uses a stub helper that the test re-imports from
    // PR-2's Task 4 work; until then, the test is RED.
    // PR-2's Task 4 lands a `dispatch-token-usage.js` helper that the
    // orchestrator imports for the missing-model hard-throw. PR-1 has
    // not added it yet, so this dynamic import must fail. The grep
    // pattern is the contract.
    let mod: unknown = null;
    try {
      mod = await import(
        // @ts-expect-error PR-2 lands this module; PR-1 stub holds the
        // RED contract that the import does not yet resolve.
        "../../src/orchestrator/dispatch-token-usage.js"
      );
    } catch {
      mod = null;
    }
    expect(mod).not.toBeNull();
    expect(
      (mod as { dispatchTokenUsageOrThrow?: unknown } | null)?.dispatchTokenUsageOrThrow
    ).toBeDefined();
  });
});
