import { describe, expect, it } from "vitest";
import {
  formatHoursForTesting,
  formatPctForTesting,
  prettyStateForTesting,
  tokenPctSeverityForTesting,
} from "./AutonomousSessionHeader";

// These helpers encode the AL-10 acceptance-criteria math (tokens %, hours
// remaining, severity tiers). Testing them directly instead of through the
// React tree keeps the assertions stable even if the markup shifts.

describe("AutonomousSessionHeader formatters", () => {
  it("formatPct rounds and appends % for finite numbers", () => {
    expect(formatPctForTesting(0)).toBe("0%");
    expect(formatPctForTesting(24.4)).toBe("24%");
    expect(formatPctForTesting(24.6)).toBe("25%");
    expect(formatPctForTesting(100)).toBe("100%");
  });

  it("formatPct returns em dash for non-finite inputs", () => {
    expect(formatPctForTesting(NaN)).toBe("—");
    expect(formatPctForTesting(Infinity)).toBe("—");
  });

  it("formatHours prefers minutes under an hour", () => {
    expect(formatHoursForTesting(0)).toBe("0m");
    expect(formatHoursForTesting(0.5)).toBe("30m");
    expect(formatHoursForTesting(0.01)).toBe("1m");
  });

  it("formatHours uses Xh Ym for multi-hour durations", () => {
    expect(formatHoursForTesting(1)).toBe("1h");
    expect(formatHoursForTesting(1.5)).toBe("1h 30m");
    expect(formatHoursForTesting(8)).toBe("8h");
    expect(formatHoursForTesting(7.25)).toBe("7h 15m");
  });

  it("formatHours returns em dash for negative or non-finite inputs", () => {
    expect(formatHoursForTesting(-1)).toBe("—");
    expect(formatHoursForTesting(NaN)).toBe("—");
  });

  it("prettyState maps the lifecycle enum to display strings", () => {
    expect(prettyStateForTesting("planning")).toBe("Planning");
    expect(prettyStateForTesting("dispatching")).toBe("Dispatching");
    expect(prettyStateForTesting("winding_down")).toBe("Winding down");
    expect(prettyStateForTesting("audit")).toBe("Audit");
    expect(prettyStateForTesting("done")).toBe("Done");
    expect(prettyStateForTesting("killed")).toBe("Killed");
  });

  it("prettyState passes unknown states through verbatim", () => {
    expect(prettyStateForTesting("future_state_abc")).toBe("future_state_abc");
  });

  it("tokenPctSeverity tiers match AL-1 threshold crossings", () => {
    expect(tokenPctSeverityForTesting(0)).toBe("ok");
    expect(tokenPctSeverityForTesting(59.9)).toBe("ok");
    expect(tokenPctSeverityForTesting(60)).toBe("warn");
    expect(tokenPctSeverityForTesting(84.9)).toBe("warn");
    expect(tokenPctSeverityForTesting(85)).toBe("hot");
    expect(tokenPctSeverityForTesting(99.9)).toBe("hot");
    expect(tokenPctSeverityForTesting(100)).toBe("overrun");
    expect(tokenPctSeverityForTesting(120)).toBe("overrun");
  });
});
