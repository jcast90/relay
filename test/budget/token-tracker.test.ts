import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { THRESHOLDS, TokenTracker, type ThresholdEvent } from "../../src/budget/token-tracker.js";

describe("TokenTracker", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "relay-budget-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe("threshold crossings", () => {
    it("emits one event per threshold when crossed in one big record()", async () => {
      const tracker = new TokenTracker("s-big", 1000, { rootDir: root });
      const events: ThresholdEvent[] = [];
      tracker.onThreshold((evt) => events.push(evt));

      // Cross every threshold in a single record.
      tracker.record(1000, 0);
      await tracker.flush();

      expect(events.map((e) => e.threshold)).toEqual([...THRESHOLDS]);
      // Each event reports the post-crossing used/pct state.
      for (const evt of events) {
        expect(evt.sessionId).toBe("s-big");
        expect(evt.used).toBe(1000);
        expect(evt.total).toBe(1000);
        expect(evt.pct).toBe(100);
      }

      await tracker.close();
    });

    it("emits each threshold exactly once across many small increments", async () => {
      const tracker = new TokenTracker("s-small", 1000, { rootDir: root });
      const events: ThresholdEvent[] = [];
      tracker.onThreshold((evt) => events.push(evt));

      // 100 increments of 10 tokens each — 0% -> 100% in small steps.
      for (let i = 0; i < 100; i += 1) {
        tracker.record(5, 5);
      }
      await tracker.flush();

      // One emit per threshold, in ascending order.
      expect(events.map((e) => e.threshold)).toEqual([...THRESHOLDS]);

      await tracker.close();
    });

    it("does not emit when staying below 50%", async () => {
      const tracker = new TokenTracker("s-quiet", 1000, { rootDir: root });
      const events: ThresholdEvent[] = [];
      tracker.onThreshold((evt) => events.push(evt));

      tracker.record(100, 100); // 20%
      tracker.record(100, 100); // 40%
      await tracker.flush();

      expect(events).toEqual([]);

      await tracker.close();
    });

    it("emits the 50% threshold exactly at the boundary and never again", async () => {
      const tracker = new TokenTracker("s-boundary", 1000, { rootDir: root });
      const events: ThresholdEvent[] = [];
      tracker.onThreshold((evt) => events.push(evt));

      tracker.record(500, 0); // exactly 50%
      tracker.record(1, 0); // 50.1% — must not re-emit 50
      tracker.record(10, 0); // still below 85
      await tracker.flush();

      expect(events.map((e) => e.threshold)).toEqual([50]);

      await tracker.close();
    });

    it("unsubscribe stops further events", async () => {
      const tracker = new TokenTracker("s-unsub", 1000, { rootDir: root });
      const events: ThresholdEvent[] = [];
      const off = tracker.onThreshold((evt) => events.push(evt));

      tracker.record(500, 0); // crosses 50
      off();
      tracker.record(500, 0); // would cross 85, 95, 100
      await tracker.flush();

      expect(events.map((e) => e.threshold)).toEqual([50]);

      await tracker.close();
    });
  });

  describe("persistence", () => {
    it("survives restart: next record adds to existing total", async () => {
      const sessionId = "s-restart";

      const first = new TokenTracker(sessionId, 10_000, { rootDir: root });
      first.record(100, 200); // +300 → 300
      first.record(400, 100); // +500 → 800
      await first.close();

      const second = new TokenTracker(sessionId, 10_000, { rootDir: root });
      // Give replay a chance to finish before asserting.
      await second.flush();
      expect(second.used).toBe(800);

      second.record(50, 50); // +100 → 900
      await second.flush();
      expect(second.used).toBe(900);
      await second.close();

      // Confirm the file actually accumulated: two lines pre-restart + one post.
      const contents = await readFile(join(root, "sessions", sessionId, "budget.jsonl"), "utf8");
      const lines = contents.trim().split("\n");
      expect(lines).toHaveLength(3);
      // Last line's cumulativeUsed should reflect the post-restart total.
      const last = JSON.parse(lines[lines.length - 1]);
      expect(last.cumulativeUsed).toBe(900);
    });

    it("does not re-emit already-crossed thresholds after restart", async () => {
      const sessionId = "s-no-reemit";

      const first = new TokenTracker(sessionId, 1000, { rootDir: root });
      first.record(600, 0); // crosses 50
      await first.close();

      const second = new TokenTracker(sessionId, 1000, { rootDir: root });
      const events: ThresholdEvent[] = [];
      second.onThreshold((evt) => events.push(evt));
      await second.flush();

      // Replaying does not re-emit 50.
      expect(events).toEqual([]);

      // But a new crossing (to 85) still emits.
      second.record(300, 0); // now at 900 = 90%
      await second.flush();
      expect(events.map((e) => e.threshold)).toEqual([85]);

      await second.close();
    });

    it("new tracker for a fresh session does not throw on missing file", async () => {
      const tracker = new TokenTracker("s-fresh", 1000, { rootDir: root });
      await tracker.flush();
      expect(tracker.used).toBe(0);
      expect(tracker.pct).toBe(0);
      await tracker.close();
    });

    it("tolerates a torn/malformed final line", async () => {
      const sessionId = "s-torn";
      const first = new TokenTracker(sessionId, 10_000, { rootDir: root });
      first.record(100, 100); // 200
      await first.close();

      // Simulate a truncated append that left a half-line behind.
      const path = join(root, "sessions", sessionId, "budget.jsonl");
      const { appendFile } = await import("node:fs/promises");
      await appendFile(path, '{"ts":"2026-04-21T00:00:00', "utf8");

      const second = new TokenTracker(sessionId, 10_000, { rootDir: root });
      await second.flush();
      expect(second.used).toBe(200); // recovered from the valid line only
      await second.close();
    });
  });

  describe("concurrent writes", () => {
    it("rapid successive record() calls produce a clean file with one line each", async () => {
      const sessionId = "s-concurrent";
      const tracker = new TokenTracker(sessionId, 100_000, { rootDir: root });

      const n = 50;
      for (let i = 0; i < n; i += 1) {
        tracker.record(1, 1);
      }
      await tracker.close();

      const contents = await readFile(join(root, "sessions", sessionId, "budget.jsonl"), "utf8");
      const lines = contents.trim().split("\n");
      expect(lines).toHaveLength(n);
      // Every line must parse cleanly — no interleaved bytes.
      for (const line of lines) {
        const parsed = JSON.parse(line);
        expect(parsed.inputTokens).toBe(1);
        expect(parsed.outputTokens).toBe(1);
      }
      // Last line's cumulativeUsed matches the sum.
      const last = JSON.parse(lines[lines.length - 1]);
      expect(last.cumulativeUsed).toBe(n * 2);
    });
  });

  describe("non-autonomous isolation", () => {
    it("constructing a tracker does not write any file until record() is called", async () => {
      // Guards against a regression where a constructor side-effect would
      // leave `budget.jsonl` files around for every session that ever
      // instantiated a tracker. Non-autonomous sessions never construct
      // one, but belt-and-braces: even if they did, no file.
      const tracker = new TokenTracker("s-noop", 1000, { rootDir: root });
      await tracker.flush();
      await tracker.close();

      await expect(stat(join(root, "sessions", "s-noop", "budget.jsonl"))).rejects.toThrow(
        /ENOENT/
      );
    });

    it("zero-token record is a no-op — no file write, no event", async () => {
      const tracker = new TokenTracker("s-zero", 1000, { rootDir: root });
      const events: ThresholdEvent[] = [];
      tracker.onThreshold((evt) => events.push(evt));
      tracker.record(0, 0);
      await tracker.flush();
      await tracker.close();

      expect(events).toEqual([]);
      await expect(stat(join(root, "sessions", "s-zero", "budget.jsonl"))).rejects.toThrow(
        /ENOENT/
      );
    });
  });

  describe("validation", () => {
    it("rejects empty sessionId", () => {
      expect(() => new TokenTracker("", 1000, { rootDir: root })).toThrow(/sessionId/);
    });

    it("rejects non-positive totalTokens", () => {
      expect(() => new TokenTracker("s", 0, { rootDir: root })).toThrow(/totalTokens/);
      expect(() => new TokenTracker("s", -1, { rootDir: root })).toThrow(/totalTokens/);
      expect(() => new TokenTracker("s", Number.NaN, { rootDir: root })).toThrow(/totalTokens/);
    });

    it("rejects negative token counts at record-time", async () => {
      const tracker = new TokenTracker("s-neg", 1000, { rootDir: root });
      expect(() => tracker.record(-1, 0)).toThrow(/non-negative/);
      expect(() => tracker.record(0, -5)).toThrow(/non-negative/);
      await tracker.close();
    });

    it("record() after close() throws", async () => {
      const tracker = new TokenTracker("s-closed", 1000, { rootDir: root });
      await tracker.close();
      expect(() => tracker.record(1, 1)).toThrow(/after close/);
    });

    it("close() is idempotent", async () => {
      const tracker = new TokenTracker("s-twice", 1000, { rootDir: root });
      tracker.record(10, 10);
      await tracker.close();
      await expect(tracker.close()).resolves.toBeUndefined();
    });
  });
});
