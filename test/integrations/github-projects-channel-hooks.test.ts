import { describe, expect, it, vi } from "vitest";

import {
  archiveEpicForChannel,
  provisionEpicForChannel,
  renameEpicForChannel,
} from "../../src/integrations/github-projects/channel-hooks.js";
import type { ProjectsClientDeps } from "../../src/integrations/github-projects/client.js";

/**
 * Tests for the high-level channel↔epic orchestration. The lower-level
 * client + draft-items + fields modules are already covered by their
 * own tests; here we pin down the call **sequence** so future edits to
 * `provisionEpicForChannel` don't silently reorder the steps in a way
 * that breaks the channel/project contract (e.g. trying to set
 * Type=epic before fields exist).
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

// --- Canned response builders for the multi-step provision flow ---

function findProjectExisting(projectId: string, number: number, title: string): unknown {
  return {
    data: {
      user: {
        projectsV2: { nodes: [{ id: projectId, title, number, url: `u/${number}` }] },
      },
    },
  };
}

function listFieldsResponse(
  fields: Array<{ id: string; name: string; options?: Array<{ id: string; name: string }> }>
): unknown {
  return { data: { node: { fields: { nodes: fields } } } };
}

function addDraftIssueResponse(itemId: string, draftId: string): unknown {
  return {
    data: {
      addProjectV2DraftIssue: {
        projectItem: { id: itemId, content: { id: draftId } },
      },
    },
  };
}

function setFieldValueResponse(itemId: string): unknown {
  return {
    data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: itemId } } },
  };
}

describe("github-projects/channel-hooks", () => {
  describe("provisionEpicForChannel", () => {
    it("runs the full sequence and returns a complete tracker link", async () => {
      const typeFieldOptions = [
        { id: "OPT_epic", name: "epic" },
        { id: "OPT_ticket", name: "ticket" },
      ];
      const allFields = [
        { id: "F_status", name: "Status" },
        { id: "F_type", name: "Type", options: typeFieldOptions },
        { id: "F_priority", name: "Priority" },
      ];

      const { fetchImpl, calls } = stubFetch([
        // 1. resolveProject → findProjectByTitle (existing match)
        findProjectExisting("PVT_p1", 7, "relay-core-ui"),
        // 2. ensureCustomFields → listProjectFields (all already present, no creates)
        listFieldsResponse(allFields),
        // 3. createDraftItem
        addDraftIssueResponse("PVTI_e1", "DI_e1"),
        // 4. listProjectFields (re-read so we can find the Type field id + epic option)
        listFieldsResponse(allFields),
        // 5. setSingleSelectValue Type=epic
        setFieldValueResponse("PVTI_e1"),
      ]);

      const out = await provisionEpicForChannel(
        {
          channelName: "ui-refactor",
          channelDescription: "Refactor the UI auth flow",
          ownerRef: { owner: "jcast90", ownerType: "user" },
          projectTitle: "relay-core-ui",
        },
        deps(fetchImpl)
      );

      expect(out).toEqual({
        projectId: "PVT_p1",
        projectNumber: 7,
        projectUrl: "u/7",
        epicItemId: "PVTI_e1",
        epicDraftIssueId: "DI_e1",
      });

      // Pin the call sequence — order matters for correctness.
      expect(calls).toHaveLength(5);
      expect(calls[0].body.query).toMatch(/projectsV2\(first: 20/);
      expect(calls[1].body.query).toMatch(/fields\(first: 50\)/);
      expect(calls[2].body.query).toMatch(/addProjectV2DraftIssue/);
      expect(calls[3].body.query).toMatch(/fields\(first: 50\)/);
      expect(calls[4].body.query).toMatch(/updateProjectV2ItemFieldValue/);

      // The epic stamp uses the Type field id and the `epic` option id we
      // surfaced from the field listing — not hard-coded ids.
      expect(calls[4].body.variables).toMatchObject({
        itemId: "PVTI_e1",
        fieldId: "F_type",
        optionId: "OPT_epic",
      });
    });

    it("creates missing fields before creating the epic", async () => {
      const { fetchImpl, calls } = stubFetch([
        // resolveProject
        findProjectExisting("PVT_p1", 1, "relay"),
        // ensureCustomFields → list (Status only present)
        listFieldsResponse([{ id: "F_status", name: "Status" }]),
        // ensureCustomFields → create Type
        {
          data: {
            createProjectV2Field: {
              projectV2Field: {
                id: "F_type_new",
                name: "Type",
                options: [
                  { id: "OPT_epic", name: "epic" },
                  { id: "OPT_ticket", name: "ticket" },
                ],
              },
            },
          },
        },
        // ensureCustomFields → create Priority
        {
          data: {
            createProjectV2Field: {
              projectV2Field: { id: "F_priority_new", name: "Priority", options: [] },
            },
          },
        },
        // createDraftItem
        addDraftIssueResponse("PVTI_e1", "DI_e1"),
        // listProjectFields again (to find Type field id)
        listFieldsResponse([
          { id: "F_status", name: "Status" },
          {
            id: "F_type_new",
            name: "Type",
            options: [
              { id: "OPT_epic", name: "epic" },
              { id: "OPT_ticket", name: "ticket" },
            ],
          },
          { id: "F_priority_new", name: "Priority" },
        ]),
        // setSingleSelectValue
        setFieldValueResponse("PVTI_e1"),
      ]);

      await provisionEpicForChannel(
        {
          channelName: "ch",
          ownerRef: { owner: "jcast90", ownerType: "user" },
          projectTitle: "relay",
        },
        deps(fetchImpl)
      );

      // Field creates must precede draft creation.
      expect(calls[2].body.query).toMatch(/createProjectV2Field/);
      expect(calls[3].body.query).toMatch(/createProjectV2Field/);
      expect(calls[4].body.query).toMatch(/addProjectV2DraftIssue/);
    });

    it("succeeds without stamping Type when the user customized fields away", async () => {
      const { fetchImpl, calls } = stubFetch([
        findProjectExisting("PVT_p1", 1, "relay"),
        // First field listing (used by ensureCustomFields) — Status/Type/Priority all present
        listFieldsResponse([
          { id: "F_status", name: "Status" },
          { id: "F_type", name: "Type", options: [{ id: "OPT_other", name: "story" }] },
          { id: "F_priority", name: "Priority" },
        ]),
        addDraftIssueResponse("PVTI_e1", "DI_e1"),
        // Second listing — same shape: Type exists but `epic` option is missing
        listFieldsResponse([
          { id: "F_status", name: "Status" },
          { id: "F_type", name: "Type", options: [{ id: "OPT_other", name: "story" }] },
          { id: "F_priority", name: "Priority" },
        ]),
      ]);

      const out = await provisionEpicForChannel(
        {
          channelName: "ch",
          ownerRef: { owner: "jcast90", ownerType: "user" },
          projectTitle: "relay",
        },
        deps(fetchImpl)
      );

      expect(out.epicItemId).toBe("PVTI_e1");
      // No setSingleSelectValue call.
      expect(calls.every((c) => !/updateProjectV2ItemFieldValue/.test(c.body.query))).toBe(true);
      // Pin call count too — a regression that adds a stray field-write
      // between createDraftItem and the final list would otherwise slip
      // through silently. Expected: resolveProject + listFields(ensure)
      // + createDraft + listFields(re-read) = 4 calls.
      expect(calls).toHaveLength(4);
    });
  });

  describe("renameEpicForChannel", () => {
    it("calls updateProjectV2DraftIssue with the new title", async () => {
      const { fetchImpl, calls } = stubFetch([
        { data: { updateProjectV2DraftIssue: { draftIssue: { id: "DI_e1" } } } },
      ]);

      await renameEpicForChannel(
        {
          projectId: "PVT_p1",
          projectNumber: 1,
          projectUrl: "u",
          epicItemId: "PVTI_e1",
          epicDraftIssueId: "DI_e1",
        },
        "renamed",
        deps(fetchImpl)
      );

      expect(calls[0].body.query).toMatch(/updateProjectV2DraftIssue/);
      expect(calls[0].body.variables).toMatchObject({
        draftIssueId: "DI_e1",
        title: "renamed",
      });
    });
  });

  describe("archiveEpicForChannel", () => {
    it("calls archiveProjectV2Item with the project + epic item ids", async () => {
      const { fetchImpl, calls } = stubFetch([
        { data: { archiveProjectV2Item: { item: { id: "PVTI_e1" } } } },
      ]);

      await archiveEpicForChannel(
        {
          projectId: "PVT_p1",
          projectNumber: 1,
          projectUrl: "u",
          epicItemId: "PVTI_e1",
          epicDraftIssueId: "DI_e1",
        },
        deps(fetchImpl)
      );

      expect(calls[0].body.query).toMatch(/archiveProjectV2Item/);
      expect(calls[0].body.variables).toEqual({
        projectId: "PVT_p1",
        itemId: "PVTI_e1",
      });
    });
  });
});
