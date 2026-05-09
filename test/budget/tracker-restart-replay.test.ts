import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { THRESHOLDS, TokenTracker } from "../../src/budget/token-tracker.js";

const RM_OPTS = { recursive: true, force: true, maxRetries: 3, retryDelay: 50 };

/**
 * Survives-restart property — automated proof for the must-have truth
 * "Telemetry survives a process restart" (Task 12 step 7 #1, M-fix).
 *
 * RED in PR-1 because Phase 1 widens THRESHOLDS to include `75` (D-01) —
 * the assertion "firedThresholds includes [50, 60, 75]" can only hold once
 * Task 2 widens the canonical list. Until PR-2 lands the wider THRESHOLDS,
 * the resumed tracker reports `[50, 60]` and this test fails.
 */
describe("TokenTracker restart-replay (D-01 survives-restart property)", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "relay-restart-"));
  });

  afterEach(async () => {
    await rm(root, RM_OPTS);
  });

  it("THRESHOLDS includes the 7-element [50, 60, 75, 85, 90, 95, 100] list (D-01)", () => {
    // RED until PR-2 / Task 2 widens THRESHOLDS to include 75 + 90.
    expect([...THRESHOLDS]).toEqual([50, 60, 75, 85, 90, 95, 100]);
  });

  it("resumes cumulative usage AND already-fired thresholds across a process restart", async () => {
    const sessionId = "sess-restart";
    const ceiling = 200_000;

    // Phase 1: record up to 75% (150_000 / 200_000).
    const t1 = new TokenTracker(sessionId, ceiling, { rootDir: root });
    t1.record(150_000, 0);
    await t1.flush();
    await t1.close();

    // Phase 2: new tracker over the same on-disk file. Should resume
    // cumulative usage AND mark every crossed threshold (50, 60, 75) as
    // already-fired so they do NOT re-emit.
    const captured: number[] = [];
    const t2 = new TokenTracker(sessionId, ceiling, { rootDir: root });
    t2.onThreshold((evt) => captured.push(evt.threshold));
    // Wait for the constructor's replay to drain.
    await t2.flush();

    expect(t2.used).toBe(150_000);

    // Now record enough additional tokens to cross 85% (170_000 / 200_000).
    // This triggers the threshold check loop. With the widened (D-01)
    // threshold list, 75 is already fired from replay so it does NOT
    // re-emit; only 85 should fire. With the pre-D-01 list (no 75),
    // replay would not have marked 75 as fired (it's not in the list),
    // and 85 would still fire — but the assertion below also checks
    // that 75 is NOT among the fired thresholds, which only holds once
    // the wider list is in place AND replay marks 75 from history.
    t2.record(20_000, 0);
    await t2.flush();

    expect(captured).toContain(85);
    // 75 must NOT re-fire — D-01 widens the list AND replay marks it.
    expect(captured).not.toContain(75);
    await t2.close();
  });
});
