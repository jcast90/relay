import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../api", () => ({
  api: {
    listWorkspaces: vi.fn().mockResolvedValue([]),
    listSections: vi
      .fn()
      // First call (useEffect on open): empty
      // Second call (after createSection inside the modal): includes new
      .mockResolvedValueOnce([])
      .mockResolvedValue([
        { sectionId: "sec-new", name: "Billing", createdAt: "2026-04-23T00:00:00Z" },
      ]),
    createSection: vi.fn().mockResolvedValue({
      sectionId: "sec-new",
      name: "Billing",
      createdAt: "2026-04-23T00:00:00Z",
    }),
    createChannel: vi.fn(),
    assignChannelSection: vi.fn(),
    spawnAgent: vi.fn(),
    createSession: vi.fn(),
    startChat: vi.fn(),
  },
}));

import { NewChannelModal } from "./NewChannelModal";
import { api } from "../api";

describe("NewChannelModal — Create new section sentinel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("offers '+ Create new section…' option in Section dropdown", async () => {
    render(<NewChannelModal open onClose={vi.fn()} onCreated={vi.fn()} />);

    // Wait for the effect-driven listSections resolve.
    await waitFor(() => expect(api.listSections).toHaveBeenCalled());

    // The dropdown's "+ Create new section…" option should always be present
    // (even with zero existing sections — that was the dead-end we fixed).
    const select = screen.getByRole("combobox");
    expect(select).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /create new section/i })).toBeInTheDocument();
  });

  it("selecting the sentinel opens PromptModal, creates section, auto-selects it", async () => {
    const user = userEvent.setup();
    render(<NewChannelModal open onClose={vi.fn()} onCreated={vi.fn()} />);

    await waitFor(() => expect(api.listSections).toHaveBeenCalled());

    // Select the sentinel — should open PromptModal, not set sectionId.
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    await user.selectOptions(select, "__create__");

    const input = await screen.findByPlaceholderText(/billing/i);
    await user.type(input, "Billing");
    await user.keyboard("{Enter}");

    await waitFor(() => expect(api.createSection).toHaveBeenCalledWith("Billing"));
    // After creation, the select should display the new section (auto-select).
    await waitFor(() => {
      expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("sec-new");
    });
  });
});
