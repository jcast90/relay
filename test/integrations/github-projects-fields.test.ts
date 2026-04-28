import { describe, expect, it, vi } from "vitest";

import {
  createSingleSelectField,
  defaultFieldOptions,
  ensureCustomFields,
  ensureCustomFieldsWithOptions,
  type ProjectsClientDeps,
} from "../../src/integrations/github-projects/client.js";

/**
 * PR B field-bootstrap tests. The PR A stub (which returned
 * `created: []`) is gone — these tests cover the actual create-missing
 * path plus idempotency and the option-seed contract.
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

function listFieldsResponse(
  fields: Array<{ id: string; name: string; options?: Array<{ id: string; name: string }> }>
): unknown {
  return { data: { node: { fields: { nodes: fields } } } };
}

function createFieldResponse(id: string, name: string): unknown {
  return {
    data: {
      createProjectV2Field: { projectV2Field: { id, name, options: [] } },
    },
  };
}

describe("github-projects/fields", () => {
  describe("defaultFieldOptions", () => {
    it("seeds Status with the four Relay ticket statuses", () => {
      const names = defaultFieldOptions.Status.map((o) => o.name);
      expect(names).toEqual(["backlog", "in_progress", "needs_review", "done"]);
    });

    it("seeds Type with epic and ticket", () => {
      const names = defaultFieldOptions.Type.map((o) => o.name);
      expect(names).toEqual(["epic", "ticket"]);
    });

    it("seeds Priority with low/med/high", () => {
      const names = defaultFieldOptions.Priority.map((o) => o.name);
      expect(names).toEqual(["low", "med", "high"]);
    });

    it("uses valid GH single-select colors and non-empty descriptions", () => {
      const validColors = new Set([
        "GRAY",
        "BLUE",
        "GREEN",
        "YELLOW",
        "ORANGE",
        "RED",
        "PINK",
        "PURPLE",
      ]);
      for (const name of Object.keys(defaultFieldOptions)) {
        for (const opt of defaultFieldOptions[name]) {
          expect(validColors.has(opt.color)).toBe(true);
          expect(opt.description.length).toBeGreaterThan(0);
        }
      }
    });
  });

  describe("createSingleSelectField", () => {
    it("calls createProjectV2Field with SINGLE_SELECT and forwards options", async () => {
      const { fetchImpl, calls } = stubFetch([createFieldResponse("F_status", "Status")]);
      const out = await createSingleSelectField(
        {
          projectId: "P_id",
          name: "Status",
          options: defaultFieldOptions.Status,
        },
        deps(fetchImpl)
      );
      expect(out.id).toBe("F_status");
      expect(out.name).toBe("Status");
      expect(calls[0].body.query).toMatch(/createProjectV2Field/);
      expect(calls[0].body.query).toMatch(/SINGLE_SELECT/);
      expect(calls[0].body.variables.singleSelectOptions).toEqual(defaultFieldOptions.Status);
    });
  });

  describe("ensureCustomFields", () => {
    it("creates exactly the missing fields in a single sweep", async () => {
      const { fetchImpl, calls } = stubFetch([
        // 1) listProjectFields — Status already exists, Type/Priority don't
        listFieldsResponse([{ id: "F_status", name: "Status" }]),
        // 2) createSingleSelectField for Type
        createFieldResponse("F_type", "Type"),
        // 3) createSingleSelectField for Priority
        createFieldResponse("F_priority", "Priority"),
      ]);
      const out = await ensureCustomFields("P_id", ["Status", "Type", "Priority"], deps(fetchImpl));
      expect(out.existing).toEqual(["Status"]);
      expect(out.created).toEqual(["Type", "Priority"]);
      expect(calls).toHaveLength(3);
      expect(calls[1].body.variables.name).toBe("Type");
      expect(calls[1].body.variables.singleSelectOptions).toEqual(defaultFieldOptions.Type);
      expect(calls[2].body.variables.name).toBe("Priority");
    });

    it("creates nothing when all requested fields already exist (idempotent)", async () => {
      const { fetchImpl, calls } = stubFetch([
        listFieldsResponse([
          { id: "F_status", name: "Status" },
          { id: "F_type", name: "Type" },
          { id: "F_priority", name: "Priority" },
        ]),
      ]);
      const out = await ensureCustomFields("P_id", ["Status", "Type", "Priority"], deps(fetchImpl));
      expect(out.existing).toEqual(["Status", "Type", "Priority"]);
      expect(out.created).toEqual([]);
      expect(calls).toHaveLength(1);
    });

    it("rejects names that have no default option seed before any network call", async () => {
      const { fetchImpl, calls } = stubFetch([listFieldsResponse([])]);
      await expect(ensureCustomFields("P_id", ["NotInDefaults"], deps(fetchImpl))).rejects.toThrow(
        /no default option seed for "NotInDefaults"/
      );
      expect(calls).toHaveLength(0);
    });
  });

  describe("ensureCustomFieldsWithOptions", () => {
    it("accepts caller-supplied option lists and creates missing fields", async () => {
      const { fetchImpl, calls } = stubFetch([
        listFieldsResponse([]),
        createFieldResponse("F_specialty", "Specialty"),
      ]);
      const customOptions = [
        { name: "ui", color: "BLUE" as const, description: "UI" },
        { name: "be", color: "GREEN" as const, description: "Backend" },
      ];
      const out = await ensureCustomFieldsWithOptions(
        "P_id",
        [{ name: "Specialty", options: customOptions }],
        deps(fetchImpl)
      );
      expect(out.created).toEqual(["Specialty"]);
      expect(calls[1].body.variables.singleSelectOptions).toEqual(customOptions);
    });

    it("leaves existing fields untouched without reconciling their options", async () => {
      const { fetchImpl, calls } = stubFetch([
        listFieldsResponse([{ id: "F_existing", name: "Specialty" }]),
      ]);
      const out = await ensureCustomFieldsWithOptions(
        "P_id",
        [
          {
            name: "Specialty",
            options: [{ name: "x", color: "GRAY", description: "" }],
          },
        ],
        deps(fetchImpl)
      );
      expect(out.existing).toEqual(["Specialty"]);
      expect(out.created).toEqual([]);
      // No second call — no option reconciliation by design.
      expect(calls).toHaveLength(1);
    });
  });
});
