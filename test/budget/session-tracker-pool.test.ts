import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SessionTrackerPool } from "../../src/budget/session-tracker-pool.js";

const RM_OPTS = { recursive: true, force: true, maxRetries: 3, retryDelay: 50 };

/**
 * RED tests for `SessionTrackerPool`. The pool's implementation lands in
 * PR-2 (Task 4); this file ships in PR-1 with `vi.fn`-based assertions so
 * the contract is locked at PR-1 review time. All tests fail at runtime
 * until PR-2 implements the body.
 */
describe("SessionTrackerPool", () => {
  let root: string;
  const originalHome = process.env.HOME;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "relay-pool-"));
    process.env.HOME = root;
  });

  afterEach(async () => {
    if (originalHome) process.env.HOME = originalHome;
    else delete process.env.HOME;
    await rm(root, RM_OPTS);
  });

  it("returns the same TokenTracker instance for the same sessionId", () => {
    const pool = new SessionTrackerPool();
    const a = pool.get("sess-1", 1000);
    const b = pool.get("sess-1", 1000);
    expect(a).toBe(b);
  });

  it("returns distinct trackers for different sessionIds", () => {
    const pool = new SessionTrackerPool();
    const a = pool.get("sess-a", 1000);
    const b = pool.get("sess-b", 1000);
    expect(a).not.toBe(b);
  });

  it("closeAll() flushes all trackers and clears the map", async () => {
    const pool = new SessionTrackerPool();
    pool.get("sess-1", 1000);
    pool.get("sess-2", 1000);
    expect(pool.has("sess-1")).toBe(true);
    expect(pool.has("sess-2")).toBe(true);
    await pool.closeAll();
    expect(pool.has("sess-1")).toBe(false);
    expect(pool.has("sess-2")).toBe(false);
  });

  it("emits an M8 soft-warning when a brand-new sessionId surfaces a non-zero existing budget", async () => {
    // Pre-write a budget.jsonl with non-zero cumulativeUsed under the
    // tmp HOME — when get() is called for this "brand-new" session the
    // pool should warn (Phase 2 handoff 0%-start contract violation).
    const sessionsDir = join(root, ".relay", "sessions", "sess-replay");
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(
      join(sessionsDir, "budget.jsonl"),
      JSON.stringify({
        ts: "2026-05-09T00:00:00Z",
        inputTokens: 100,
        outputTokens: 50,
        cumulativeUsed: 150,
      }) + "\n"
    );

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const pool = new SessionTrackerPool();
      pool.get("sess-replay", 1000);
      const calls = warn.mock.calls.map((c) => String(c[0]));
      expect(calls.some((m) => /\[budget\].*replaying non-zero state/i.test(m))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});
