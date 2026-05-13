import { describe, expect, it } from "vitest";

import {
  detailFor,
  formatSessionStartContext,
  glyphFor,
  type RepoState,
} from "../../src/crosslink/session-start-hook-content.js";

describe("formatSessionStartContext (Phase 4 Plan 02 Task 1)", () => {
  it("returns empty string for an empty repo list", () => {
    // Empty contract — same shape as `formatActiveSessionsBlock`: callers
    // append-then-skip-on-empty without a separate length check.
    const out = formatSessionStartContext({ channelName: "oauth", repoStates: [] });
    expect(out).toBe("");
  });

  it("renders header + one line per repo for a 3-repo mixed-state channel", () => {
    const repoStates: RepoState[] = [
      { alias: "ui-repo", state: "ready", adminAlias: "atlas-7f2" },
      { alias: "backend-repo", state: "booting", bootingSinceMs: 130_000 },
      { alias: "sdk-repo", state: "disconnected" },
    ];

    const out = formatSessionStartContext({ channelName: "oauth-rollout", repoStates });
    const lines = out.split("\n");

    // Header line + 3 repo lines = 4 total. No feed tail since
    // newFeedEntries was undefined.
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe("[Relay] Channel: oauth-rollout (3 repos)");

    // Per-line predicates — no frozen-string `toEqual` per AGENTS.md
    // "no snapshot tests" rule.
    expect(lines[1]).toContain("●"); // ready glyph
    expect(lines[1]).toContain("ui-repo");
    expect(lines[1]).toContain("ready");
    expect(lines[1]).toContain("(admin: atlas-7f2)");

    expect(lines[2]).toContain("○"); // booting glyph
    expect(lines[2]).toContain("backend-repo");
    expect(lines[2]).toContain("booting");
    // 130_000 ms → 2 minutes (130s → 2.16m → floor to 2m).
    expect(lines[2]).toContain("(since 2m ago)");

    expect(lines[3]).toContain("·"); // disconnected glyph
    expect(lines[3]).toContain("sdk-repo");
    expect(lines[3]).toContain("disconnected");
  });

  it("appends the Feed: tail when newFeedEntries is > 0", () => {
    const out = formatSessionStartContext({
      channelName: "oauth",
      repoStates: [{ alias: "ui", state: "ready" }],
      newFeedEntries: 4,
    });

    const lines = out.split("\n");
    expect(lines.at(-1)).toMatch(/^Feed: 4 new entries since you were last here\./);
    // The hint mentions `rly status` so the agent can drill in.
    expect(lines.at(-1)).toContain("`rly status`");
  });

  it("omits the Feed: tail when newFeedEntries is 0 or undefined", () => {
    // Case A: explicit 0 — "no new entries" is silence, not a "Feed: 0" line.
    const withZero = formatSessionStartContext({
      channelName: "oauth",
      repoStates: [{ alias: "ui", state: "ready" }],
      newFeedEntries: 0,
    });
    expect(withZero).not.toMatch(/^Feed:/m);

    // Case B: undefined — usually means RELAY_SESSION_ID wasn't set and the
    // hook deliberately chose not to compute a count.
    const withUndef = formatSessionStartContext({
      channelName: "oauth",
      repoStates: [{ alias: "ui", state: "ready" }],
    });
    expect(withUndef).not.toMatch(/^Feed:/m);
  });

  it("formats booting detail as `(since 2m ago)` for a bootingSinceMs of 130_000", () => {
    const detail = detailFor({ alias: "x", state: "booting", bootingSinceMs: 130_000 }, 0);
    expect(detail).toBe(" (since 2m ago)");
  });

  it("uses `×` glyph and `stale` state word for stale repos (D-07 emphasis)", () => {
    expect(glyphFor("stale")).toBe("×");

    const out = formatSessionStartContext({
      channelName: "oauth",
      repoStates: [{ alias: "ui-repo", state: "stale" }],
    });
    const repoLine = out.split("\n")[1];
    expect(repoLine).toContain("×");
    // The state word ("stale") is what a downstream parser reads; the
    // glyph is presentational. Both must be present.
    expect(repoLine).toContain("stale");
    expect(repoLine).toContain("(stale)");
  });

  it("contains no imperative prompt-injection-prone language", () => {
    // T-04-04 mitigation (04-PLAN.md threat model). Hook output lands in
    // the agent's first turn — imperatives there bias the model.
    const out = formatSessionStartContext({
      channelName: "oauth-rollout",
      repoStates: [
        { alias: "ui", state: "ready", adminAlias: "atlas-7f2" },
        { alias: "backend", state: "booting", bootingSinceMs: 30_000 },
        { alias: "sdk", state: "stale" },
      ],
      newFeedEntries: 7,
    });

    expect(out).not.toMatch(/\b(MUST|ATTENTION)\b/);
    // Lowercase form is also disallowed — case-insensitive sweep.
    expect(out).not.toMatch(/\b(must|attention)\b/i);
    // The phrase "do not" is also a known injection signal.
    expect(out).not.toMatch(/\bdo not\b/i);
  });

  it("relative-time helper formats seconds, minutes, and hours correctly", () => {
    // Spot-check the three buckets via the booting-state detail wrapper.
    expect(detailFor({ alias: "x", state: "booting", bootingSinceMs: 5_000 }, 0)).toBe(
      " (since 5s ago)"
    );
    expect(detailFor({ alias: "x", state: "booting", bootingSinceMs: 90_000 }, 0)).toBe(
      " (since 1m ago)"
    );
    // 90 minutes → 1h (floors to whole hours).
    expect(detailFor({ alias: "x", state: "booting", bootingSinceMs: 90 * 60_000 }, 0)).toBe(
      " (since 1h ago)"
    );
  });

  it("glyphFor returns expected glyph for each of the 4 states", () => {
    expect(glyphFor("ready")).toBe("●");
    expect(glyphFor("booting")).toBe("○");
    expect(glyphFor("stale")).toBe("×");
    expect(glyphFor("disconnected")).toBe("·");
  });
});
