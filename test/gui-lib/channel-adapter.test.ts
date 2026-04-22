import { describe, expect, it } from "vitest";
import {
  humanizeRelative,
  primaryAlias,
  toUiChannel,
  aliasToWorkspaceId,
  workspaceIdToAlias,
} from "../../gui/src/lib/channel";
import type { Channel } from "../../gui/src/types";

const baseChannel: Channel = {
  channelId: "c-1",
  name: "oauth-api-users",
  description: "Topic goes here",
  status: "active",
  members: [
    {
      agentId: "agent-ui",
      displayName: "UI Agent",
      role: "primary",
      provider: "claude",
      status: "idle",
    },
  ],
  pinnedRefs: [],
  repoAssignments: [
    { alias: "UI", workspaceId: "ws-ui", repoPath: "/tmp/ui" },
    { alias: "be", workspaceId: "ws-be", repoPath: "/tmp/be" },
  ],
  primaryWorkspaceId: "ws-be",
  starred: true,
  updatedAt: new Date(Date.now() - 3 * 60 * 1000).toISOString(),
};

describe("primaryAlias", () => {
  it("returns the alias of the primaryWorkspaceId", () => {
    expect(primaryAlias(baseChannel)).toBe("be");
  });

  it("falls back to first assignment when primaryWorkspaceId is unset", () => {
    const c: Channel = { ...baseChannel, primaryWorkspaceId: undefined };
    expect(primaryAlias(c)).toBe("UI");
  });

  it("falls back to first assignment when primaryWorkspaceId references a detached repo", () => {
    const c: Channel = { ...baseChannel, primaryWorkspaceId: "ws-ghost" };
    expect(primaryAlias(c)).toBe("UI");
  });

  it("returns null when there are no repos", () => {
    const c: Channel = { ...baseChannel, repoAssignments: [], primaryWorkspaceId: undefined };
    expect(primaryAlias(c)).toBeNull();
  });
});

describe("toUiChannel", () => {
  it("lowercases aliases so mention lookup is case-insensitive end-to-end", () => {
    const ui = toUiChannel(baseChannel);
    expect(ui.repos).toEqual(["be", "ui"]);
    expect(ui.primaryRepo).toBe("be");
  });

  it("orders repos with primary first", () => {
    const c: Channel = { ...baseChannel, primaryWorkspaceId: "ws-ui" };
    const ui = toUiChannel(c);
    expect(ui.repos[0]).toBe("ui");
  });

  it("projects description to topic and populates humanized activeAt", () => {
    const ui = toUiChannel(baseChannel);
    expect(ui.topic).toBe("Topic goes here");
    expect(ui.activeAt).toMatch(/^\d+[smhdw]$/);
  });

  it("defaults starred to false when the backend omits it", () => {
    // Simulates an older channel JSON that predates the `starred` field.
    // Rust treats missing as false; the TS adapter must do the same even
    // though `Channel.starred` is typed non-optional at runtime.
    const legacy = { ...baseChannel } as Omit<Channel, "starred"> & { starred?: boolean };
    delete legacy.starred;
    const ui = toUiChannel(legacy as unknown as Channel);
    expect(ui.starred).toBe(false);
  });
});

describe("aliasToWorkspaceId / workspaceIdToAlias", () => {
  it("round-trips on attached repos", () => {
    expect(aliasToWorkspaceId(baseChannel, "UI")).toBe("ws-ui");
    expect(workspaceIdToAlias(baseChannel, "ws-ui")).toBe("UI");
  });

  it("returns undefined for unknown aliases / workspace ids", () => {
    expect(aliasToWorkspaceId(baseChannel, "ghost")).toBeUndefined();
    expect(workspaceIdToAlias(baseChannel, "ws-ghost")).toBeUndefined();
  });
});

describe("humanizeRelative", () => {
  const now = new Date("2026-04-22T12:00:00Z");

  it.each([
    [30 * 1000, /^\d+s$/],
    [5 * 60 * 1000, /^5m$/],
    [3 * 60 * 60 * 1000, /^3h$/],
    [2 * 24 * 60 * 60 * 1000, /^2d$/],
    [2 * 7 * 24 * 60 * 60 * 1000, /^2w$/],
  ])("formats %d ms ago within expected bucket", (ms, pattern) => {
    const iso = new Date(now.getTime() - ms).toISOString();
    expect(humanizeRelative(iso, now)).toMatch(pattern);
  });

  it("returns ISO date for anything older than ~4 weeks", () => {
    const iso = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString();
    expect(humanizeRelative(iso, now)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("returns empty string for undefined and malformed input", () => {
    expect(humanizeRelative(undefined)).toBe("");
    expect(humanizeRelative("not-a-date")).toBe("");
  });
});
