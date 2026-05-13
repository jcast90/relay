import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";

import type { Channel } from "../types";

// Mock the api module. ChannelHeader calls api.loadRepoAdminStates on
// mount; jsdom has no Tauri bridge so we stub with vitest mocks.
vi.mock("../api", () => ({
  api: {
    loadRepoAdminStates: vi.fn(),
    setChannelStarred: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../lib/appearance", () => ({
  useAppearance: () => [{ avatarStyle: "glyph" }, vi.fn()],
}));

import { ChannelHeader } from "./ChannelHeader";
import { api } from "../api";

const baseChannel: Channel = {
  channelId: "c-1",
  name: "oauth-rollout",
  description: "",
  status: "active",
  members: [],
  pinnedRefs: [],
  repoAssignments: [
    { alias: "ui", workspaceId: "ws-ui", repoPath: "/tmp/ui" },
    { alias: "be", workspaceId: "ws-be", repoPath: "/tmp/be" },
  ],
  starred: false,
};

describe("ChannelHeader repo-state badges", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders one badge per repo with the correct state-* class", async () => {
    vi.mocked(api.loadRepoAdminStates).mockResolvedValue([
      ["ui", "ready"],
      ["be", "booting"],
    ]);

    const { container } = render(
      <ChannelHeader
        channel={baseChannel}
        tab="chat"
        onTabChange={() => {}}
        rightRailOpen={false}
        onToggleRail={() => {}}
        onOpenSettings={() => {}}
        onRefresh={() => {}}
      />
    );

    await waitFor(() => {
      const badges = container.querySelectorAll(".repo-state-badge");
      expect(badges.length).toBe(2);
    });

    expect(container.querySelector(".repo-state-badge.state-ready")).toBeTruthy();
    expect(container.querySelector(".repo-state-badge.state-booting")).toBeTruthy();
  });

  it("renders no badge stack when the Tauri command returns []", async () => {
    vi.mocked(api.loadRepoAdminStates).mockResolvedValue([]);

    const { container } = render(
      <ChannelHeader
        channel={baseChannel}
        tab="chat"
        onTabChange={() => {}}
        rightRailOpen={false}
        onToggleRail={() => {}}
        onOpenSettings={() => {}}
        onRefresh={() => {}}
      />
    );

    // Settle effect — the stack must not render when there's nothing
    // to show (avoids an empty flex container under the header).
    await waitFor(() => {
      expect(api.loadRepoAdminStates).toHaveBeenCalledWith("c-1");
    });
    expect(container.querySelector(".repo-state-stack")).toBeNull();
  });

  it("renders all four D-07 state classes for the four wire-format states", async () => {
    vi.mocked(api.loadRepoAdminStates).mockResolvedValue([
      ["a", "ready"],
      ["b", "booting"],
      ["c", "stale"],
      ["d", "disconnected"],
    ]);

    const channelWithFour: Channel = {
      ...baseChannel,
      repoAssignments: [
        { alias: "a", workspaceId: "ws-a", repoPath: "/tmp/a" },
        { alias: "b", workspaceId: "ws-b", repoPath: "/tmp/b" },
        { alias: "c", workspaceId: "ws-c", repoPath: "/tmp/c" },
        { alias: "d", workspaceId: "ws-d", repoPath: "/tmp/d" },
      ],
    };

    const { container } = render(
      <ChannelHeader
        channel={channelWithFour}
        tab="chat"
        onTabChange={() => {}}
        rightRailOpen={false}
        onToggleRail={() => {}}
        onOpenSettings={() => {}}
        onRefresh={() => {}}
      />
    );

    await waitFor(() => {
      expect(container.querySelectorAll(".repo-state-badge").length).toBe(4);
    });
    expect(container.querySelector(".state-ready")).toBeTruthy();
    expect(container.querySelector(".state-booting")).toBeTruthy();
    expect(container.querySelector(".state-stale")).toBeTruthy();
    expect(container.querySelector(".state-disconnected")).toBeTruthy();
  });
});
