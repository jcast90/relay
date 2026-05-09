import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ContextWindowBar } from "./ContextWindowBar";

/**
 * RED tests for the `ContextWindowBar` GUI component. PR-1 ships a
 * `() => null` stub so typecheck passes; PR-3 (Task 7) lands the real
 * markup, severity classes, and interactive selection.
 */
describe.todo("ContextWindowBar", () => {
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
});
