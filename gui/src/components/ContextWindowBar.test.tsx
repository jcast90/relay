import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ContextWindowBar } from "./ContextWindowBar";

/**
 * Phase 1 PR-3 (Task 7): GREEN tests for `ContextWindowBar`. PR-1
 * shipped a `() => null` stub; this PR lands the real markup,
 * severity classes, and edge-case behavior (zero usage hides the
 * bar; overrun caps the rail fill at 100% but preserves the literal
 * pct in the label).
 */
describe("ContextWindowBar", () => {
  it("renders 'ctx 75%' for used 150_000 / total 200_000 with metric--tokens-warn class", () => {
    const { container } = render(
      <ContextWindowBar used={150_000} total={200_000} sessionId="sess-1" model="Sonnet 4.5" />
    );
    expect(screen.getByText(/ctx\s*75%/i)).toBeDefined();
    expect(container.querySelector(".metric--tokens-warn")).toBeTruthy();
  });

  it("uses metric--tokens-hot for pct >= 90", () => {
    const { container } = render(
      <ContextWindowBar used={185_000} total={200_000} sessionId="sess-1" />
    );
    expect(container.querySelector(".metric--tokens-hot")).toBeTruthy();
  });

  it("uses metric--tokens-overrun for pct >= 100", () => {
    const { container } = render(
      <ContextWindowBar used={210_000} total={200_000} sessionId="sess-1" />
    );
    expect(container.querySelector(".metric--tokens-overrun")).toBeTruthy();
  });

  it("returns null when used is 0 (no budget.jsonl line yet)", () => {
    const { container } = render(<ContextWindowBar used={0} total={200_000} sessionId="sess-1" />);
    expect(container.firstChild).toBeNull();
  });

  it("clamps the rail fill at 100% width but preserves the literal pct label on overrun", () => {
    const { container } = render(
      <ContextWindowBar used={226_000} total={200_000} sessionId="sess-1" />
    );
    expect(screen.getByText(/ctx\s*113%/i)).toBeDefined();
    const fill = container.querySelector(".context-window-bar__fill") as HTMLElement | null;
    expect(fill).toBeTruthy();
    // Rail width caps at 100% even though the pct reads 113%.
    expect(fill?.style.width).toBe("100%");
  });

  it("includes the sessionId in a tooltip title for hover-disambiguation", () => {
    const { container } = render(
      <ContextWindowBar used={150_000} total={200_000} sessionId="sess-tooltip" />
    );
    const root = container.querySelector(".context-window-bar") as HTMLElement | null;
    expect(root?.getAttribute("title")).toBe("session sess-tooltip");
  });
});
