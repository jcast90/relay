import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PromptModal } from "./PromptModal";

/**
 * Regression coverage for the fix that replaced window.prompt (no-op'd by
 * Tauri v2 WKWebView) with an in-app modal. If any of these fail, the
 * section-create UX is likely broken again for real users.
 */
describe("PromptModal", () => {
  it("renders nothing when closed", () => {
    const { container } = render(
      <PromptModal open={false} title="New section" onSubmit={vi.fn()} onClose={vi.fn()} />
    );
    expect(container.firstChild).toBeNull();
  });

  it("submits trimmed value on Enter and closes", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<PromptModal open title="New section" onSubmit={onSubmit} onClose={onClose} />);

    const input = await screen.findByRole("textbox");
    await user.type(input, "  Billing  ");
    await user.keyboard("{Enter}");

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("Billing"));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("disables submit while value is empty/whitespace", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<PromptModal open title="New section" onSubmit={onSubmit} onClose={vi.fn()} />);

    const submit = screen.getByRole("button", { name: /ok/i });
    expect(submit).toBeDisabled();

    await user.type(await screen.findByRole("textbox"), "   ");
    expect(submit).toBeDisabled();

    await user.click(submit);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("surfaces errors inline without closing on failure", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockRejectedValue(new Error("duplicate name"));
    const onClose = vi.fn();
    render(<PromptModal open title="New section" onSubmit={onSubmit} onClose={onClose} />);

    await user.type(await screen.findByRole("textbox"), "X");
    await user.keyboard("{Enter}");

    await screen.findByText(/duplicate name/i);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes on Escape and calls onClose", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<PromptModal open title="Rename" onSubmit={vi.fn()} onClose={onClose} />);

    // Focus the input before firing Escape — the modal autofocuses on a
    // rAF tick, which isn't guaranteed to fire before user.keyboard().
    const input = await screen.findByRole("textbox");
    input.focus();
    await user.keyboard("{Escape}");

    expect(onClose).toHaveBeenCalled();
  });

  it("seeds input with initialValue (rename flow)", async () => {
    render(
      <PromptModal
        open
        title="Rename section"
        initialValue="Legacy"
        onSubmit={vi.fn()}
        onClose={vi.fn()}
      />
    );

    const input = (await screen.findByRole("textbox")) as HTMLInputElement;
    expect(input.value).toBe("Legacy");
  });
});
