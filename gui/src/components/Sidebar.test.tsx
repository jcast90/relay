import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Mock the api + dialogs modules. Sidebar reaches both at render time;
// jsdom has no Tauri bridge so we stub with vitest mocks.
vi.mock("../api", () => ({
  api: {
    listWorkspaces: vi.fn().mockResolvedValue([]),
    listSections: vi.fn().mockResolvedValue([]),
    createSection: vi.fn().mockResolvedValue({
      sectionId: "sec-new",
      name: "Billing",
      createdAt: "2026-04-23T00:00:00Z",
    }),
    renameSection: vi.fn().mockResolvedValue(undefined),
    decommissionSection: vi.fn().mockResolvedValue(undefined),
    deleteSection: vi.fn().mockResolvedValue(undefined),
    setChannelStarred: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../lib/dialogs", () => ({
  confirmAction: vi.fn().mockResolvedValue(true),
  notifyError: vi.fn().mockResolvedValue(undefined),
}));

import { Sidebar } from "./Sidebar";
import { api } from "../api";

function baseProps() {
  return {
    channels: [],
    selectedId: null,
    includeArchived: false,
    sessionCounts: {},
    runningStreams: 0,
    onSelect: vi.fn(),
    onNewChannel: vi.fn(),
    onNewDm: vi.fn(),
    onToggleIncludeArchived: vi.fn(),
    onOpenSettings: vi.fn(),
    onRefresh: vi.fn(),
  };
}

describe("Sidebar unified + menu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows the '+ New' button, not the old window.prompt-driven controls", async () => {
    render(<Sidebar {...baseProps()} />);
    const newBtn = await screen.findByRole("button", { name: /create new/i });
    expect(newBtn).toBeInTheDocument();
    // Neither of the old affordances should exist anymore.
    expect(screen.queryByText(/\+ new section/i)).not.toBeInTheDocument();
  });

  it("clicking + New opens menu with New channel and New section", async () => {
    const user = userEvent.setup();
    render(<Sidebar {...baseProps()} />);

    await user.click(await screen.findByRole("button", { name: /create new/i }));

    expect(screen.getByRole("menuitem", { name: /new channel/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /new section/i })).toBeInTheDocument();
  });

  it("selecting New channel calls onNewChannel(null) and closes menu", async () => {
    const user = userEvent.setup();
    const props = baseProps();
    render(<Sidebar {...props} />);

    await user.click(await screen.findByRole("button", { name: /create new/i }));
    await user.click(screen.getByRole("menuitem", { name: /new channel/i }));

    expect(props.onNewChannel).toHaveBeenCalledWith(null);
    expect(screen.queryByRole("menuitem", { name: /new channel/i })).not.toBeInTheDocument();
  });

  it("selecting New section opens PromptModal and creates on submit", async () => {
    const user = userEvent.setup();
    render(<Sidebar {...baseProps()} />);

    await user.click(await screen.findByRole("button", { name: /create new/i }));
    await user.click(screen.getByRole("menuitem", { name: /new section/i }));

    // PromptModal should render with a text input
    const input = await screen.findByRole("textbox");
    await user.type(input, "Billing");
    await user.keyboard("{Enter}");

    await waitFor(() => expect(api.createSection).toHaveBeenCalledWith("Billing"));
  });
});
