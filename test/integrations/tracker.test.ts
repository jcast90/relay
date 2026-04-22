import { describe, expect, it, vi } from "vitest";

import { createTracker, detectTrackerKind, resolveIssue } from "../../src/integrations/tracker.js";

// Mock the AO GitHub tracker so its `create()` throws when invoked. We use
// plain `vi.mock` here — no seam in tracker.ts was needed, since tracker.ts
// imports the plugin via the standard default export and `vi.mock` hoists
// ahead of the module-graph resolution.
vi.mock("@aoagents/ao-plugin-tracker-github", () => ({
  default: {
    manifest: {
      name: "tracker-github",
      slot: "tracker" as const,
      description: "mocked",
      version: "0.0.0-test",
    },
    create: () => {
      throw new Error("boom from mocked plugin create()");
    },
  },
}));

describe("detectTrackerKind", () => {
  const cases: Array<{ input: string; expected: "github" | "linear" | null; why: string }> = [
    {
      input: "https://github.com/acme/widgets/issues/42",
      expected: "github",
      why: "GitHub issue URL",
    },
    {
      input: "https://linear.app/acme/issue/ABC-123/some-title",
      expected: "linear",
      why: "Linear issue URL",
    },
    {
      input: "ABC-123",
      expected: "linear",
      why: "bare Linear identifier",
    },
    {
      input: "build me a new auth system",
      expected: null,
      why: "plain text",
    },
    {
      input: "",
      expected: null,
      why: "empty string",
    },
    {
      input: "   ",
      expected: null,
      why: "whitespace only",
    },
    {
      input: "https://github.com/acme/widgets/pull/42",
      expected: null,
      why: "GitHub PR URL, not an issue",
    },
  ];

  for (const { input, expected, why } of cases) {
    it(`returns ${expected} for ${why}`, () => {
      expect(detectTrackerKind(input)).toBe(expected);
    });
  }
});

describe("resolveIssue", () => {
  it("maps AO Issue into HarnessIssue and preserves issue.branchName when present", async () => {
    const fakeIssue = {
      id: "iss-1",
      title: "Fix the thing",
      description: "Body text describes the bug.",
      url: "https://github.com/acme/widgets/issues/42",
      state: "open",
      labels: ["bug", "p1"],
      branchName: "issue/42-fix-the-thing",
    };

    const tracker = {
      name: "github",
      getIssue: async () => fakeIssue,
      isCompleted: async () => false,
      issueUrl: () => fakeIssue.url,
      branchName: () => "fallback-should-not-be-used",
      generatePrompt: async () => "prompt",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const project = {
      name: "acme/widgets",
      repo: "acme/widgets",
      path: "/tmp",
      defaultBranch: "main",
      sessionPrefix: "widgets",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const harnessIssue = await resolveIssue(tracker, "42", project);

    expect(harnessIssue).toEqual({
      id: "iss-1",
      title: "Fix the thing",
      body: "Body text describes the bug.",
      url: "https://github.com/acme/widgets/issues/42",
      labels: ["bug", "p1"],
      branchName: "issue/42-fix-the-thing",
    });
  });

  it("falls back to tracker.branchName when issue.branchName is absent", async () => {
    const fakeIssue = {
      id: "iss-2",
      title: "Another",
      description: "No branch on issue.",
      url: "https://linear.app/acme/issue/ABC-123",
      state: "open",
      labels: [],
      // no branchName
    };

    let branchNameCalledWith: { identifier?: string } = {};
    const tracker = {
      name: "linear",
      getIssue: async () => fakeIssue,
      isCompleted: async () => false,
      issueUrl: () => fakeIssue.url,
      branchName: (identifier: string) => {
        branchNameCalledWith = { identifier };
        return "abc-123-another";
      },
      generatePrompt: async () => "prompt",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const project = {
      name: "ws/proj",
      repo: "ws/proj",
      path: "/tmp",
      defaultBranch: "main",
      sessionPrefix: "proj",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const harnessIssue = await resolveIssue(tracker, "ABC-123", project);

    expect(harnessIssue.branchName).toBe("abc-123-another");
    expect(branchNameCalledWith.identifier).toBe("ABC-123");
    // labels defaults to [] when the AO issue has no labels defined
    expect(harnessIssue.labels).toEqual([]);
  });

  it("defaults labels to [] when AO issue has no labels field", async () => {
    const fakeIssue = {
      id: "iss-3",
      title: "No labels",
      description: "",
      url: "https://github.com/acme/widgets/issues/7",
      state: "open",
      branchName: "issue/7",
      // labels omitted
    };

    const tracker = {
      name: "github",
      getIssue: async () => fakeIssue,
      isCompleted: async () => false,
      issueUrl: () => fakeIssue.url,
      branchName: () => "ignored",
      generatePrompt: async () => "p",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const project = {
      name: "acme/widgets",
      repo: "acme/widgets",
      path: "/tmp",
      defaultBranch: "main",
      sessionPrefix: "widgets",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const harnessIssue = await resolveIssue(tracker, "7", project);
    expect(harnessIssue.labels).toEqual([]);
  });
});

describe("createTracker — env restoration when plugin create() throws", () => {
  it("restores process.env.GITHUB_TOKEN to undefined (variable absent) when prior was unset and create() throws", async () => {
    // Save whatever the real env had so we leave the process clean.
    const prior = process.env.GITHUB_TOKEN;
    // Force the "prior was undefined" branch to exercise deletion-on-restore.
    delete process.env.GITHUB_TOKEN;

    try {
      expect(process.env.GITHUB_TOKEN).toBeUndefined();
      expect("GITHUB_TOKEN" in process.env).toBe(false);

      await expect(createTracker("github", { token: "throwaway" })).rejects.toThrow(
        /boom from mocked plugin create\(\)/
      );

      // After the throw propagates, the env var must be gone again — matching
      // its prior undefined / absent state, not a lingering "throwaway".
      expect(process.env.GITHUB_TOKEN).toBeUndefined();
      expect("GITHUB_TOKEN" in process.env).toBe(false);
    } finally {
      if (prior === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = prior;
    }
  });

  it("restores process.env.GITHUB_TOKEN to its prior defined value when create() throws", async () => {
    const prior = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "original-token";

    try {
      await expect(createTracker("github", { token: "throwaway" })).rejects.toThrow(
        /boom from mocked plugin create\(\)/
      );

      expect(process.env.GITHUB_TOKEN).toBe("original-token");
    } finally {
      if (prior === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = prior;
    }
  });
});
