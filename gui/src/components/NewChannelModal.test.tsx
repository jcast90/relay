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

describe("NewChannelModal — kickoff session plumbing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Provide a workspace so the user can advance past step 2.
    (api.listWorkspaces as ReturnType<typeof vi.fn>).mockResolvedValue([
      { workspaceId: "ws-1", repoPath: "/tmp/repo-one" },
    ]);
    // listSections needs to resolve at least once for the modal to mount;
    // share the same fixture across calls so reopening the modal works.
    (api.listSections as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  });

  /** Drive the modal through steps 1+2 and return when the kickoff field is mounted. */
  async function advanceToStep3(user: ReturnType<typeof userEvent.setup>) {
    await user.type(screen.getByPlaceholderText(/oauth-api-users/i), "test-channel");
    await user.click(screen.getByRole("button", { name: /next/i }));
    // Step 2: pick the workspace, mark primary.
    await user.click(await screen.findByRole("checkbox"));
    await user.click(screen.getByRole("radio"));
    await user.click(screen.getByRole("button", { name: /next/i }));
  }

  it("passes the kickoff session id to onCreated when a first message is provided", async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    (api.createChannel as ReturnType<typeof vi.fn>).mockResolvedValue({ channelId: "ch-42" });
    (api.spawnAgent as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (api.createSession as ReturnType<typeof vi.fn>).mockResolvedValue({ sessionId: "sess-99" });
    (api.startChat as ReturnType<typeof vi.fn>).mockResolvedValue({});

    render(<NewChannelModal open onClose={vi.fn()} onCreated={onCreated} />);
    await waitFor(() => expect(api.listSections).toHaveBeenCalled());
    await advanceToStep3(user);

    await user.type(
      screen.getByRole("textbox", { name: /first message/i }),
      "investigate something"
    );
    await user.click(screen.getByRole("button", { name: /create & post/i }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("ch-42", "sess-99"));
  });

  it("passes null kickoffSessionId when the first message is empty", async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    (api.createChannel as ReturnType<typeof vi.fn>).mockResolvedValue({ channelId: "ch-43" });
    (api.spawnAgent as ReturnType<typeof vi.fn>).mockResolvedValue({});

    render(<NewChannelModal open onClose={vi.fn()} onCreated={onCreated} />);
    await waitFor(() => expect(api.listSections).toHaveBeenCalled());
    await advanceToStep3(user);

    // No first-message text — submit straight away.
    await user.click(screen.getByRole("button", { name: /create & post/i }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("ch-43", null));
    expect(api.createSession).not.toHaveBeenCalled();
    expect(api.startChat).not.toHaveBeenCalled();
  });

  it("passes null when the kickoff createSession throws so the warning path doesn't promise a session that never started", async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    (api.createChannel as ReturnType<typeof vi.fn>).mockResolvedValue({ channelId: "ch-44" });
    (api.spawnAgent as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (api.createSession as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"));

    render(<NewChannelModal open onClose={vi.fn()} onCreated={onCreated} />);
    await waitFor(() => expect(api.listSections).toHaveBeenCalled());
    await advanceToStep3(user);

    await user.type(screen.getByRole("textbox", { name: /first message/i }), "this will fail");
    await user.click(screen.getByRole("button", { name: /create & post/i }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("ch-44", null));
  });
});
