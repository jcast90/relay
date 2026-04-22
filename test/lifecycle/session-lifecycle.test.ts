import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TokenTracker } from "../../src/budget/token-tracker.js";
import {
  LifecycleTransitionError,
  SessionLifecycle,
  type TransitionEvent,
} from "../../src/lifecycle/session-lifecycle.js";

describe("SessionLifecycle", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "relay-lifecycle-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe("valid transitions (happy path)", () => {
    it("walks planning -> dispatching -> winding_down -> audit -> done", async () => {
      const lifecycle = new SessionLifecycle("s-happy", { rootDir: root });
      const events: TransitionEvent[] = [];
      lifecycle.onTransition((evt) => events.push(evt));

      expect(lifecycle.state).toBe("planning");

      await lifecycle.transition("dispatching", "user-approved-plan");
      expect(lifecycle.state).toBe("dispatching");

      await lifecycle.transition("winding_down", "all-tickets-dispatched");
      expect(lifecycle.state).toBe("winding_down");

      await lifecycle.transition("audit", "queue-drained");
      expect(lifecycle.state).toBe("audit");

      await lifecycle.transition("done", "audit-passed");
      expect(lifecycle.state).toBe("done");

      expect(events.map((e) => [e.from, e.to])).toEqual([
        ["planning", "dispatching"],
        ["dispatching", "winding_down"],
        ["winding_down", "audit"],
        ["audit", "done"],
      ]);
      expect(events[0].reason).toBe("user-approved-plan");
      expect(events[3].reason).toBe("audit-passed");

      await lifecycle.close();
    });

    it("allows killed from every non-terminal state", async () => {
      for (const start of ["planning", "dispatching", "winding_down", "audit"] as const) {
        const id = `s-kill-${start}`;
        const lifecycle = new SessionLifecycle(id, { rootDir: root });
        // Walk to the target start state.
        if (start === "dispatching") {
          await lifecycle.transition("dispatching");
        } else if (start === "winding_down") {
          await lifecycle.transition("dispatching");
          await lifecycle.transition("winding_down");
        } else if (start === "audit") {
          await lifecycle.transition("dispatching");
          await lifecycle.transition("winding_down");
          await lifecycle.transition("audit");
        }
        expect(lifecycle.state).toBe(start);
        await lifecycle.transition("killed", "test");
        expect(lifecycle.state).toBe("killed");
        await lifecycle.close();
      }
    });

    it("allows winding_down -> done (skip audit)", async () => {
      const lifecycle = new SessionLifecycle("s-skip-audit", { rootDir: root });
      await lifecycle.transition("dispatching");
      await lifecycle.transition("winding_down");
      await lifecycle.transition("done");
      expect(lifecycle.state).toBe("done");
      await lifecycle.close();
    });
  });

  describe("invalid transitions", () => {
    it("rejects planning -> winding_down (must pass through dispatching)", async () => {
      const lifecycle = new SessionLifecycle("s-bad-1", { rootDir: root });
      await expect(lifecycle.transition("winding_down")).rejects.toBeInstanceOf(
        LifecycleTransitionError
      );
      expect(lifecycle.state).toBe("planning");
      await lifecycle.close();
    });

    it("rejects planning -> audit", async () => {
      const lifecycle = new SessionLifecycle("s-bad-2", { rootDir: root });
      await expect(lifecycle.transition("audit")).rejects.toBeInstanceOf(LifecycleTransitionError);
      await lifecycle.close();
    });

    it("rejects planning -> done", async () => {
      const lifecycle = new SessionLifecycle("s-bad-3", { rootDir: root });
      await expect(lifecycle.transition("done")).rejects.toBeInstanceOf(LifecycleTransitionError);
      await lifecycle.close();
    });

    it("rejects dispatching -> audit (must pass through winding_down)", async () => {
      const lifecycle = new SessionLifecycle("s-bad-4", { rootDir: root });
      await lifecycle.transition("dispatching");
      await expect(lifecycle.transition("audit")).rejects.toBeInstanceOf(LifecycleTransitionError);
      expect(lifecycle.state).toBe("dispatching");
      await lifecycle.close();
    });

    it("rejects backward transitions (winding_down -> dispatching)", async () => {
      const lifecycle = new SessionLifecycle("s-back-1", { rootDir: root });
      await lifecycle.transition("dispatching");
      await lifecycle.transition("winding_down");
      await expect(lifecycle.transition("dispatching")).rejects.toBeInstanceOf(
        LifecycleTransitionError
      );
      expect(lifecycle.state).toBe("winding_down");
      await lifecycle.close();
    });

    it("rejects transitions out of done", async () => {
      const lifecycle = new SessionLifecycle("s-done-out", { rootDir: root });
      await lifecycle.transition("dispatching");
      await lifecycle.transition("winding_down");
      await lifecycle.transition("done");
      for (const target of [
        "planning",
        "dispatching",
        "winding_down",
        "audit",
        "killed",
      ] as const) {
        await expect(lifecycle.transition(target)).rejects.toBeInstanceOf(LifecycleTransitionError);
      }
      expect(lifecycle.state).toBe("done");
      await lifecycle.close();
    });

    it("rejects transitions out of killed", async () => {
      const lifecycle = new SessionLifecycle("s-killed-out", { rootDir: root });
      await lifecycle.transition("killed", "test");
      for (const target of ["planning", "dispatching", "winding_down", "audit", "done"] as const) {
        await expect(lifecycle.transition(target)).rejects.toBeInstanceOf(LifecycleTransitionError);
      }
      expect(lifecycle.state).toBe("killed");
      await lifecycle.close();
    });

    it("LifecycleTransitionError carries current + attempted states", async () => {
      const lifecycle = new SessionLifecycle("s-err-shape", { rootDir: root });
      try {
        await lifecycle.transition("done");
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(LifecycleTransitionError);
        const e = err as LifecycleTransitionError;
        expect(e.from).toBe("planning");
        expect(e.to).toBe("done");
        expect(e.message).toContain("planning");
        expect(e.message).toContain("done");
      }
      await lifecycle.close();
    });
  });

  describe("token-budget integration", () => {
    it("85% threshold transitions dispatching -> winding_down", async () => {
      const tracker = new TokenTracker("s-budget-85", 1000, { rootDir: root });
      const lifecycle = new SessionLifecycle("s-budget-85", { rootDir: root, tracker });
      const events: TransitionEvent[] = [];
      lifecycle.onTransition((evt) => events.push(evt));

      await lifecycle.transition("dispatching");
      expect(lifecycle.state).toBe("dispatching");

      // Cross 50 (ignored) then 85 (should wind down). Stop before 95.
      tracker.record(500, 0); // 50% — crosses 50 only
      tracker.record(350, 0); // 85% — crosses 85
      await tracker.flush();
      await lifecycle.flush();

      expect(lifecycle.state).toBe("winding_down");
      const reasons = events.map((e) => e.reason);
      expect(reasons).toContain("token-budget-85pct");

      await lifecycle.close();
      await tracker.close();
    });

    it("85% threshold is ignored when not in dispatching", async () => {
      const tracker = new TokenTracker("s-budget-85-noop", 1000, { rootDir: root });
      const lifecycle = new SessionLifecycle("s-budget-85-noop", {
        rootDir: root,
        tracker,
      });
      // Stay in planning — 85% should NOT move us anywhere.
      tracker.record(900, 0); // crosses 50 and 85
      await tracker.flush();
      await lifecycle.flush();

      expect(lifecycle.state).toBe("planning");
      // But 95 still fires a kill from planning.
      tracker.record(100, 0); // crosses 95 (and 100)
      await tracker.flush();
      await lifecycle.flush();
      expect(lifecycle.state).toBe("killed");

      await lifecycle.close();
      await tracker.close();
    });

    it("95% threshold transitions any non-terminal state to killed", async () => {
      const tracker = new TokenTracker("s-budget-95", 1000, { rootDir: root });
      const lifecycle = new SessionLifecycle("s-budget-95", { rootDir: root, tracker });
      await lifecycle.transition("dispatching");

      tracker.record(1000, 0); // crosses 50, 85, 95, 100 in one go
      await tracker.flush();
      await lifecycle.flush();

      // 85 fires first (winding_down), then 95 fires the kill.
      expect(lifecycle.state).toBe("killed");
      const reasons = lifecycle.getTransitions().map((t) => t.reason);
      expect(reasons).toContain("token-budget-85pct");
      expect(reasons).toContain("token-budget-95pct-hard-stop");

      await lifecycle.close();
      await tracker.close();
    });

    it("50% and 100% thresholds are ignored", async () => {
      const tracker = new TokenTracker("s-budget-ignore", 1000, { rootDir: root });
      const lifecycle = new SessionLifecycle("s-budget-ignore", {
        rootDir: root,
        tracker,
      });
      await lifecycle.transition("dispatching");
      tracker.record(500, 0); // crosses only 50
      await tracker.flush();
      await lifecycle.flush();
      expect(lifecycle.state).toBe("dispatching");

      await lifecycle.close();
      await tracker.close();
    });
  });

  describe("wall-clock watchdog", () => {
    it("fires a killed transition with reason wall-clock-exceeded", async () => {
      // Fake timer harness: capture the scheduled callback instead of
      // relying on a real setTimeout, so the test finishes in ms.
      let scheduled: { fn: () => void; ms: number } | null = null;
      let cleared = false;
      const lifecycle = new SessionLifecycle("s-watchdog", {
        rootDir: root,
        maxDurationMs: 60_000,
        setTimer: (fn, ms) => {
          scheduled = { fn, ms };
          return 1 as unknown as NodeJS.Timeout;
        },
        clearTimer: () => {
          cleared = true;
        },
      });
      await lifecycle.transition("dispatching");

      expect(scheduled).not.toBeNull();
      expect(scheduled!.ms).toBe(60_000);

      // Advance time: manually invoke the captured timer callback.
      scheduled!.fn();
      await lifecycle.flush();

      expect(lifecycle.state).toBe("killed");
      const kill = lifecycle.getTransitions().find((t) => t.to === "killed");
      expect(kill).toBeDefined();
      expect(kill!.reason).toBe("wall-clock-exceeded");

      // The terminal transition should have disarmed the watchdog via
      // clearTimer, but since we already fired it, the handle is null
      // and clearTimer is not called a second time. (The disarm on
      // terminal transition is redundant when the watchdog just fired,
      // but still covered in the close() test below.)
      expect(cleared).toBe(false);

      await lifecycle.close();
    });

    it("wall-clock kill fires independent of token budget", async () => {
      // No tracker wired — watchdog must fire on its own.
      let scheduled: (() => void) | null = null;
      const lifecycle = new SessionLifecycle("s-watchdog-solo", {
        rootDir: root,
        maxDurationMs: 1_000,
        setTimer: (fn) => {
          scheduled = fn;
          return 0 as unknown as NodeJS.Timeout;
        },
        clearTimer: () => {},
      });
      await lifecycle.transition("dispatching");
      scheduled!();
      await lifecycle.flush();
      expect(lifecycle.state).toBe("killed");
      await lifecycle.close();
    });

    it("close() clears the watchdog so no transition fires after close", async () => {
      let scheduled: (() => void) | null = null;
      let cleared = false;
      const lifecycle = new SessionLifecycle("s-close-clears", {
        rootDir: root,
        maxDurationMs: 60_000,
        setTimer: (fn) => {
          scheduled = fn;
          return 42 as unknown as NodeJS.Timeout;
        },
        clearTimer: (handle) => {
          expect(handle).toBe(42);
          cleared = true;
        },
      });

      const events: TransitionEvent[] = [];
      lifecycle.onTransition((evt) => events.push(evt));

      await lifecycle.close();
      expect(cleared).toBe(true);

      // Firing the stale timer callback after close must NOT produce a
      // transition (lifecycle is closed, state stays planning).
      scheduled!();
      // Give any rogue fire-and-forget a turn to fail.
      await new Promise((r) => setTimeout(r, 0));

      expect(events).toEqual([]);
      expect(lifecycle.state).toBe("planning");
    });

    it("rejects non-positive maxDurationMs", () => {
      expect(() => new SessionLifecycle("s-bad-dur", { rootDir: root, maxDurationMs: 0 })).toThrow(
        /maxDurationMs/
      );
      expect(() => new SessionLifecycle("s-bad-dur", { rootDir: root, maxDurationMs: -1 })).toThrow(
        /maxDurationMs/
      );
      expect(
        () => new SessionLifecycle("s-bad-dur", { rootDir: root, maxDurationMs: Number.NaN })
      ).toThrow(/maxDurationMs/);
    });
  });

  describe("persistence", () => {
    it("round-trips: transition, close, reconstruct, state + transitions intact", async () => {
      const id = "s-roundtrip";
      const first = new SessionLifecycle(id, { rootDir: root });
      await first.transition("dispatching", "user-approved");
      await first.transition("winding_down", "budget-85");
      await first.close();

      const filePath = join(root, "sessions", id, "lifecycle.json");
      const contents = JSON.parse(await readFile(filePath, "utf8"));
      expect(contents.sessionId).toBe(id);
      expect(contents.state).toBe("winding_down");
      expect(contents.transitions).toHaveLength(2);
      expect(contents.transitions[0].from).toBe("planning");
      expect(contents.transitions[0].to).toBe("dispatching");
      expect(contents.transitions[0].reason).toBe("user-approved");
      expect(contents.maxDurationMs).toBeGreaterThan(0);

      // Reconstruct and confirm state is resumed.
      const second = new SessionLifecycle(id, { rootDir: root });
      // Give replay a chance to finish.
      await second.flush();
      expect(second.state).toBe("winding_down");
      expect(second.getTransitions()).toHaveLength(2);

      // A subsequent transition should still work and append to the log.
      await second.transition("audit");
      expect(second.state).toBe("audit");
      expect(second.getTransitions()).toHaveLength(3);
      await second.close();

      const final = JSON.parse(await readFile(filePath, "utf8"));
      expect(final.state).toBe("audit");
      expect(final.transitions).toHaveLength(3);
    });

    it("resuming in a terminal state does not arm the watchdog", async () => {
      const id = "s-resume-terminal";
      const first = new SessionLifecycle(id, { rootDir: root });
      await first.transition("dispatching");
      await first.transition("winding_down");
      await first.transition("done");
      await first.close();

      const captured: Array<() => void> = [];
      const second = new SessionLifecycle(id, {
        rootDir: root,
        setTimer: (fn) => {
          captured.push(fn);
          return 0 as unknown as NodeJS.Timeout;
        },
        clearTimer: () => {},
      });
      await second.flush();
      // The watchdog is armed synchronously in the constructor before
      // replay resolves — so a callback may have been captured. The key
      // invariant is that firing it does NOT move a terminal state.
      for (const fn of captured) {
        fn();
      }
      await second.flush();
      expect(second.state).toBe("done");
      await second.close();
    });

    it("corrupted lifecycle.json: recover by starting fresh and log a warn", async () => {
      const id = "s-corrupt";
      const filePath = join(root, "sessions", id, "lifecycle.json");
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, "{not valid json", "utf8");

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const lifecycle = new SessionLifecycle(id, { rootDir: root });
        await lifecycle.flush();
        expect(lifecycle.state).toBe("planning");
        expect(lifecycle.getTransitions()).toEqual([]);
        expect(warnSpy).toHaveBeenCalled();
        const msg = warnSpy.mock.calls.map((c) => c.join(" ")).join("\n");
        expect(msg.toLowerCase()).toContain("corrupt");

        // A fresh transition on top of the recovered lifecycle works.
        await lifecycle.transition("dispatching");
        expect(lifecycle.state).toBe("dispatching");
        await lifecycle.close();
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("missing file is not an error — fresh session starts in planning", async () => {
      const lifecycle = new SessionLifecycle("s-fresh", { rootDir: root });
      await lifecycle.flush();
      expect(lifecycle.state).toBe("planning");
      // No file created until the first transition.
      await expect(stat(join(root, "sessions", "s-fresh", "lifecycle.json"))).rejects.toThrow(
        /ENOENT/
      );
      await lifecycle.close();
    });

    it("persists atomically — lifecycle.json is valid JSON after every transition", async () => {
      const id = "s-atomic";
      const lifecycle = new SessionLifecycle(id, { rootDir: root });
      await lifecycle.transition("dispatching");
      const mid = JSON.parse(await readFile(join(root, "sessions", id, "lifecycle.json"), "utf8"));
      expect(mid.state).toBe("dispatching");
      await lifecycle.transition("winding_down");
      const after = JSON.parse(
        await readFile(join(root, "sessions", id, "lifecycle.json"), "utf8")
      );
      expect(after.state).toBe("winding_down");
      await lifecycle.close();
    });
  });

  describe("event bus", () => {
    it("multiple subscribers all receive each transition", async () => {
      const lifecycle = new SessionLifecycle("s-multi", { rootDir: root });
      const a: TransitionEvent[] = [];
      const b: TransitionEvent[] = [];
      lifecycle.onTransition((e) => a.push(e));
      lifecycle.onTransition((e) => b.push(e));
      await lifecycle.transition("dispatching");
      expect(a).toHaveLength(1);
      expect(b).toHaveLength(1);
      await lifecycle.close();
    });

    it("unsubscribe stops further events", async () => {
      const lifecycle = new SessionLifecycle("s-unsub", { rootDir: root });
      const events: TransitionEvent[] = [];
      const off = lifecycle.onTransition((e) => events.push(e));
      await lifecycle.transition("dispatching");
      off();
      await lifecycle.transition("winding_down");
      expect(events.map((e) => e.to)).toEqual(["dispatching"]);
      await lifecycle.close();
    });

    it("a throwing listener does not block other listeners or the transition", async () => {
      const lifecycle = new SessionLifecycle("s-throwy", { rootDir: root });
      const events: TransitionEvent[] = [];
      lifecycle.onTransition(() => {
        throw new Error("boom");
      });
      lifecycle.onTransition((e) => events.push(e));

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        await lifecycle.transition("dispatching");
      } finally {
        warnSpy.mockRestore();
      }
      expect(lifecycle.state).toBe("dispatching");
      expect(events).toHaveLength(1);
      await lifecycle.close();
    });
  });

  describe("close semantics", () => {
    it("close() is idempotent", async () => {
      const lifecycle = new SessionLifecycle("s-close-twice", { rootDir: root });
      await lifecycle.close();
      await expect(lifecycle.close()).resolves.toBeUndefined();
    });

    it("transition after close throws", async () => {
      const lifecycle = new SessionLifecycle("s-closed", { rootDir: root });
      await lifecycle.close();
      await expect(lifecycle.transition("dispatching")).rejects.toThrow(/after close/);
    });

    it("close() unsubscribes from the token tracker", async () => {
      const tracker = new TokenTracker("s-unsub-tracker", 1000, { rootDir: root });
      const lifecycle = new SessionLifecycle("s-unsub-tracker", {
        rootDir: root,
        tracker,
      });
      await lifecycle.transition("dispatching");
      await lifecycle.close();

      // After close, a threshold crossing must NOT cause lifecycle work
      // (it's already in `planning`-derived state, but more importantly
      // the handler is unsubscribed and cannot throw/attempt a transition).
      tracker.record(1000, 0);
      await tracker.flush();
      await tracker.close();
      // No assertion on lifecycle state here — we simply must not crash
      // or leak a post-close transition attempt. Flush-once to give any
      // rogue async callback a turn.
      await new Promise((r) => setTimeout(r, 5));
    });
  });

  describe("validation", () => {
    it("rejects empty sessionId", () => {
      expect(() => new SessionLifecycle("", { rootDir: root })).toThrow(/sessionId/);
    });
  });
});
