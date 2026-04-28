import { describe, expect, it, vi } from "vitest";

import {
  archiveItem,
  createDraftItem,
  setSingleSelectValue,
  updateDraftIssue,
  type ProjectsClientDeps,
} from "../../src/integrations/github-projects/client.js";

/**
 * PR B draft-item CRUD tests. Stubs `fetch` per-call and asserts on
 * mutation shape + variable forwarding. The two-id-types contract
 * (project-item id vs draft-issue id) is the part most likely to bite
 * future callers, so these tests pin both down explicitly.
 */

interface CapturedRequest {
  body: { query: string; variables: Record<string, unknown> };
}

function stubFetch(responses: Array<unknown>): {
  fetchImpl: typeof fetch;
  calls: CapturedRequest[];
} {
  const calls: CapturedRequest[] = [];
  let i = 0;
  const fetchImpl = vi.fn(async (_url: unknown, init: RequestInit = {}) => {
    const body = JSON.parse(String(init.body ?? "{}"));
    calls.push({ body });
    const payload = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function deps(fetchImpl: typeof fetch): ProjectsClientDeps {
  return { token: "ghp_fake", fetch: fetchImpl };
}

describe("github-projects/draft-items", () => {
  describe("createDraftItem", () => {
    it("returns both the project-item id and the draft-issue id", async () => {
      const { fetchImpl, calls } = stubFetch([
        {
          data: {
            addProjectV2DraftIssue: {
              projectItem: { id: "PVTI_1", content: { id: "DI_1" } },
            },
          },
        },
      ]);
      const out = await createDraftItem(
        { projectId: "P_id", title: "Refactor auth", body: "Details" },
        deps(fetchImpl)
      );
      expect(out.itemId).toBe("PVTI_1");
      expect(out.draftIssueId).toBe("DI_1");
      expect(calls[0].body.query).toMatch(/addProjectV2DraftIssue/);
      expect(calls[0].body.variables).toEqual({
        projectId: "P_id",
        title: "Refactor auth",
        body: "Details",
      });
    });

    it("forwards body=null when omitted (so GraphQL accepts the variable)", async () => {
      const { fetchImpl, calls } = stubFetch([
        {
          data: {
            addProjectV2DraftIssue: {
              projectItem: { id: "PVTI_x", content: { id: "DI_x" } },
            },
          },
        },
      ]);
      await createDraftItem({ projectId: "P", title: "T" }, deps(fetchImpl));
      expect(calls[0].body.variables.body).toBeNull();
    });

    it("throws if the API returns a project item without draft-issue content", async () => {
      const { fetchImpl } = stubFetch([
        {
          data: {
            addProjectV2DraftIssue: { projectItem: { id: "PVTI_orphan", content: null } },
          },
        },
      ]);
      await expect(
        createDraftItem({ projectId: "P", title: "T" }, deps(fetchImpl))
      ).rejects.toThrow(/no draft-issue content/);
    });
  });

  describe("updateDraftIssue", () => {
    it("calls updateProjectV2DraftIssue with both fields when both supplied", async () => {
      const { fetchImpl, calls } = stubFetch([
        { data: { updateProjectV2DraftIssue: { draftIssue: { id: "DI_1" } } } },
      ]);
      const out = await updateDraftIssue(
        { draftIssueId: "DI_1", title: "New title", body: "New body" },
        deps(fetchImpl)
      );
      expect(out.draftIssueId).toBe("DI_1");
      expect(calls[0].body.variables).toEqual({
        draftIssueId: "DI_1",
        title: "New title",
        body: "New body",
      });
    });

    it("forwards null for omitted fields so the mutation is well-typed", async () => {
      const { fetchImpl, calls } = stubFetch([
        { data: { updateProjectV2DraftIssue: { draftIssue: { id: "DI_1" } } } },
      ]);
      await updateDraftIssue({ draftIssueId: "DI_1", title: "T only" }, deps(fetchImpl));
      expect(calls[0].body.variables).toEqual({
        draftIssueId: "DI_1",
        title: "T only",
        body: null,
      });
    });

    it("rejects calls with no fields to update before hitting the network", async () => {
      const { fetchImpl, calls } = stubFetch([{}]);
      await expect(updateDraftIssue({ draftIssueId: "DI_1" }, deps(fetchImpl))).rejects.toThrow(
        /at least one of/
      );
      expect(calls).toHaveLength(0);
    });
  });

  describe("setSingleSelectValue", () => {
    it("calls updateProjectV2ItemFieldValue with the singleSelectOptionId payload", async () => {
      const { fetchImpl, calls } = stubFetch([
        { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_1" } } } },
      ]);
      const out = await setSingleSelectValue(
        {
          projectId: "P_id",
          itemId: "PVTI_1",
          fieldId: "F_status",
          optionId: "OPT_in_progress",
        },
        deps(fetchImpl)
      );
      expect(out.itemId).toBe("PVTI_1");
      expect(calls[0].body.query).toMatch(/updateProjectV2ItemFieldValue/);
      expect(calls[0].body.query).toMatch(/singleSelectOptionId/);
      expect(calls[0].body.variables).toEqual({
        projectId: "P_id",
        itemId: "PVTI_1",
        fieldId: "F_status",
        optionId: "OPT_in_progress",
      });
    });
  });

  describe("archiveItem", () => {
    it("calls archiveProjectV2Item with project + item ids", async () => {
      const { fetchImpl, calls } = stubFetch([
        { data: { archiveProjectV2Item: { item: { id: "PVTI_1" } } } },
      ]);
      const out = await archiveItem({ projectId: "P_id", itemId: "PVTI_1" }, deps(fetchImpl));
      expect(out.itemId).toBe("PVTI_1");
      expect(calls[0].body.query).toMatch(/archiveProjectV2Item/);
      expect(calls[0].body.variables).toEqual({ projectId: "P_id", itemId: "PVTI_1" });
    });
  });
});
