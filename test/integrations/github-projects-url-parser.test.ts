import { describe, expect, it } from "vitest";

import {
  PROJECT_ONLY_DEFERRED_MESSAGE,
  parseGithubProjectsUrl,
} from "../../src/integrations/github-projects/url-parser.js";

/**
 * Pure-parser tests. No network — `parseGithubProjectsUrl` does no IO.
 * Asserts on every shape from Decision 5 of
 * docs/design/tracker-projects-mapping.md, plus the negatives that must
 * NOT match (issue URLs, GHES, gist, malformed itemId).
 */
describe("parseGithubProjectsUrl", () => {
  describe("item-scoped URLs", () => {
    it("parses the long user-owned shape (views/<v> + pane=issue + itemId)", () => {
      const url = "https://github.com/users/jcast90/projects/3/views/1?pane=issue&itemId=PVTI_lADO";
      const out = parseGithubProjectsUrl(url);
      expect(out).toEqual({
        kind: "item",
        ownerType: "user",
        owner: "jcast90",
        projectNumber: 3,
        itemId: "PVTI_lADO",
        url,
      });
    });

    it("parses the short org-owned shape (no /views, just ?itemId)", () => {
      const url = "https://github.com/orgs/acme/projects/12?itemId=PVTI_kwAOAB";
      const out = parseGithubProjectsUrl(url);
      expect(out).toEqual({
        kind: "item",
        ownerType: "organization",
        owner: "acme",
        projectNumber: 12,
        itemId: "PVTI_kwAOAB",
        url,
      });
    });

    it("tolerates trailing slashes on the path", () => {
      const out = parseGithubProjectsUrl(
        "https://github.com/users/jcast90/projects/3/?itemId=PVTI_abc"
      );
      expect(out).not.toBeNull();
      expect(out!.kind).toBe("item");
    });

    it("tolerates the www. prefix", () => {
      const out = parseGithubProjectsUrl("https://www.github.com/orgs/acme/projects/1?itemId=I_x");
      expect(out).not.toBeNull();
      expect(out!.kind).toBe("item");
      expect(out!.owner).toBe("acme");
    });

    it("tolerates whitespace around the URL", () => {
      const out = parseGithubProjectsUrl(
        "  https://github.com/orgs/acme/projects/7?itemId=PVTI_z  "
      );
      expect(out?.kind).toBe("item");
      expect(out?.url).toBe("https://github.com/orgs/acme/projects/7?itemId=PVTI_z");
    });

    it("rejects an empty itemId value as non-item (falls through to project)", () => {
      // `?itemId=` with an empty value — not a valid item paste; fall back.
      const out = parseGithubProjectsUrl("https://github.com/users/jcast90/projects/3?itemId=");
      // searchParams.get returns "" which is falsy — treated as no itemId.
      expect(out?.kind).toBe("project");
    });

    it("rejects malformed itemId characters (returns null, not project)", () => {
      const out = parseGithubProjectsUrl(
        "https://github.com/users/jcast90/projects/3?itemId=bad%20id"
      );
      // Decoded value contains a space — fails the [A-Za-z0-9_-] guard.
      expect(out).toBeNull();
    });
  });

  describe("project-only URLs", () => {
    it("parses a user-owned project URL (no itemId)", () => {
      const url = "https://github.com/users/jcast90/projects/3";
      const out = parseGithubProjectsUrl(url);
      expect(out).toEqual({
        kind: "project",
        ownerType: "user",
        owner: "jcast90",
        projectNumber: 3,
        url,
      });
    });

    it("parses an org-owned project URL", () => {
      const out = parseGithubProjectsUrl("https://github.com/orgs/acme/projects/9");
      expect(out?.kind).toBe("project");
      expect(out?.ownerType).toBe("organization");
      expect(out?.projectNumber).toBe(9);
    });

    it("treats a /views/ URL with no itemId as project-scoped", () => {
      // The Projects UI redirects you to /views/<v> on first open even
      // without selecting a card; the user's paste should still be
      // detected as project-scoped (deferred).
      const out = parseGithubProjectsUrl("https://github.com/orgs/acme/projects/9/views/1");
      expect(out?.kind).toBe("project");
    });
  });

  describe("non-matches (no false positives)", () => {
    it("returns null for a GitHub Issue URL", () => {
      expect(parseGithubProjectsUrl("https://github.com/acme/widgets/issues/42")).toBeNull();
    });

    it("returns null for a GitHub PR URL", () => {
      expect(parseGithubProjectsUrl("https://github.com/acme/widgets/pull/42")).toBeNull();
    });

    it("returns null for a Linear URL", () => {
      expect(parseGithubProjectsUrl("https://linear.app/acme/issue/ABC-123")).toBeNull();
    });

    it("returns null for a bare Linear key", () => {
      expect(parseGithubProjectsUrl("ABC-123")).toBeNull();
    });

    it("returns null for a non-github host", () => {
      expect(
        parseGithubProjectsUrl("https://example.com/users/jcast90/projects/3?itemId=PVTI_x")
      ).toBeNull();
    });

    it("returns null for a github sub-host like gist.github.com", () => {
      expect(parseGithubProjectsUrl("https://gist.github.com/users/x/projects/1")).toBeNull();
    });

    it("returns null for empty/malformed/missing-segment inputs", () => {
      expect(parseGithubProjectsUrl("")).toBeNull();
      expect(parseGithubProjectsUrl("   ")).toBeNull();
      expect(parseGithubProjectsUrl("not-a-url")).toBeNull();
      expect(parseGithubProjectsUrl("github.com/users/x/projects/1")).toBeNull();
      expect(parseGithubProjectsUrl("https://github.com/users/jcast90/projects/0")).toBeNull();
      expect(parseGithubProjectsUrl("https://github.com/users/jcast90/repos/relay")).toBeNull();
    });
  });

  describe("PROJECT_ONLY_DEFERRED_MESSAGE", () => {
    it("mentions itemId so the user knows what to paste", () => {
      expect(PROJECT_ONLY_DEFERRED_MESSAGE).toMatch(/itemId/);
      expect(PROJECT_ONLY_DEFERRED_MESSAGE).toMatch(/deferred/);
    });
  });
});
