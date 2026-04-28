import { describe, expect, it, vi } from "vitest";

import {
  createProject,
  ensureCustomFields,
  findProjectByTitle,
  getOwnerId,
  githubProjectsGraphql,
  listProjectFields,
  resolveProject,
  type ProjectsClientDeps,
} from "../../src/integrations/github-projects/client.js";

/**
 * PR A scope: GraphQL client + project resolver. No real network in the
 * default tier — every call goes through an injected `fetch` stub so we
 * can assert on the request shape and feed deterministic responses.
 *
 * The `describe.skip` tier at the bottom is the live-network smoke test;
 * a maintainer flips it on locally with `HARNESS_LIVE=1` and a real
 * token. Per AGENTS.md it must stay skipped in default CI.
 */

interface CapturedRequest {
  url: string;
  init: RequestInit;
  body: { query: string; variables: Record<string, unknown> };
}

function stubFetch(
  responses: Array<unknown>,
  options: { status?: number; rawBody?: string } = {}
): { fetchImpl: typeof fetch; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  let i = 0;
  const fetchImpl = vi.fn(async (input: unknown, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    const body = JSON.parse(String(init.body ?? "{}"));
    calls.push({ url, init, body });
    const payload = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return new Response(options.rawBody ?? JSON.stringify(payload), {
      status: options.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function deps(fetchImpl: typeof fetch): ProjectsClientDeps {
  return { token: "ghp_fake", fetch: fetchImpl };
}

describe("github-projects/client", () => {
  describe("githubProjectsGraphql", () => {
    it("posts to the configured endpoint with bearer auth and returns data", async () => {
      const { fetchImpl, calls } = stubFetch([{ data: { ok: true } }]);
      const out = await githubProjectsGraphql<{ ok: boolean }>(
        "query { ok }",
        { x: 1 },
        deps(fetchImpl)
      );
      expect(out.ok).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe("https://api.github.com/graphql");
      expect(calls[0].init.method).toBe("POST");
      const headers = calls[0].init.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer ghp_fake");
      expect(headers["Content-Type"]).toBe("application/json");
      expect(calls[0].body.variables).toEqual({ x: 1 });
    });

    it("respects the apiUrl override so tests can target a recorded fixture host", async () => {
      const { fetchImpl, calls } = stubFetch([{ data: { ok: true } }]);
      await githubProjectsGraphql(
        "query { ok }",
        {},
        { token: "t", fetch: fetchImpl, apiUrl: "https://example.test/graphql" }
      );
      expect(calls[0].url).toBe("https://example.test/graphql");
    });

    it("throws on non-2xx HTTP so callers never silently drop the response", async () => {
      const { fetchImpl } = stubFetch([null], { status: 401, rawBody: "bad credentials" });
      await expect(githubProjectsGraphql("query { ok }", {}, deps(fetchImpl))).rejects.toThrow(
        /HTTP 401/
      );
    });

    it("surfaces GraphQL errors instead of returning partial data", async () => {
      const { fetchImpl } = stubFetch([{ errors: [{ message: "Field 'foo' doesn't exist" }] }]);
      await expect(githubProjectsGraphql("query { foo }", {}, deps(fetchImpl))).rejects.toThrow(
        /Field 'foo' doesn't exist/
      );
    });

    it("throws when the response has no data and no errors", async () => {
      const { fetchImpl } = stubFetch([{}]);
      await expect(githubProjectsGraphql("query { ok }", {}, deps(fetchImpl))).rejects.toThrow(
        /no data/
      );
    });
  });

  describe("getOwnerId", () => {
    it("queries the user root for ownerType=user", async () => {
      const { fetchImpl, calls } = stubFetch([{ data: { user: { id: "U_kg1" } } }]);
      const id = await getOwnerId({ owner: "jcast90", ownerType: "user" }, deps(fetchImpl));
      expect(id).toBe("U_kg1");
      expect(calls[0].body.query).toMatch(/user\(login:/);
      expect(calls[0].body.variables).toEqual({ login: "jcast90" });
    });

    it("queries the organization root for ownerType=organization", async () => {
      const { fetchImpl, calls } = stubFetch([{ data: { organization: { id: "O_kg1" } } }]);
      const id = await getOwnerId({ owner: "acme", ownerType: "organization" }, deps(fetchImpl));
      expect(id).toBe("O_kg1");
      expect(calls[0].body.query).toMatch(/organization\(login:/);
    });

    it("throws a targeted error when the owner does not exist", async () => {
      const { fetchImpl } = stubFetch([{ data: { user: null } }]);
      await expect(
        getOwnerId({ owner: "ghost", ownerType: "user" }, deps(fetchImpl))
      ).rejects.toThrow(/user not found: ghost/);
    });
  });

  describe("findProjectByTitle", () => {
    it("returns the project when GitHub's fuzzy search includes an exact match", async () => {
      const { fetchImpl } = stubFetch([
        {
          data: {
            user: {
              projectsV2: {
                nodes: [
                  { id: "P1", title: "relay-core-ui-archive", number: 1, url: "u1" },
                  { id: "P2", title: "relay-core-ui", number: 2, url: "u2" },
                ],
              },
            },
          },
        },
      ]);
      const out = await findProjectByTitle(
        { owner: "jcast90", ownerType: "user" },
        "relay-core-ui",
        deps(fetchImpl)
      );
      expect(out).not.toBeNull();
      expect(out!.id).toBe("P2");
    });

    it("returns null when GitHub's fuzzy results contain only near-matches", async () => {
      const { fetchImpl } = stubFetch([
        {
          data: {
            user: {
              projectsV2: {
                nodes: [{ id: "P1", title: "relay-core-ui-archive", number: 1, url: "u" }],
              },
            },
          },
        },
      ]);
      const out = await findProjectByTitle(
        { owner: "jcast90", ownerType: "user" },
        "relay-core-ui",
        deps(fetchImpl)
      );
      expect(out).toBeNull();
    });

    it("returns null when the owner itself resolves to null", async () => {
      const { fetchImpl } = stubFetch([{ data: { organization: null } }]);
      const out = await findProjectByTitle(
        { owner: "ghost-org", ownerType: "organization" },
        "anything",
        deps(fetchImpl)
      );
      expect(out).toBeNull();
    });
  });

  describe("createProject", () => {
    it("calls createProjectV2 with the owner id and title", async () => {
      const { fetchImpl, calls } = stubFetch([
        {
          data: {
            createProjectV2: {
              projectV2: { id: "P_new", title: "relay", number: 7, url: "u" },
            },
          },
        },
      ]);
      const out = await createProject("U_owner", "relay", deps(fetchImpl));
      expect(out.id).toBe("P_new");
      expect(out.number).toBe(7);
      expect(calls[0].body.query).toMatch(/createProjectV2/);
      expect(calls[0].body.variables).toEqual({ ownerId: "U_owner", title: "relay" });
    });
  });

  describe("resolveProject", () => {
    it("returns the existing project without calling createProjectV2", async () => {
      const { fetchImpl, calls } = stubFetch([
        {
          data: {
            user: {
              projectsV2: {
                nodes: [{ id: "P_exists", title: "relay", number: 3, url: "u" }],
              },
            },
          },
        },
      ]);
      const out = await resolveProject(
        { owner: "jcast90", ownerType: "user" },
        "relay",
        deps(fetchImpl)
      );
      expect(out.id).toBe("P_exists");
      expect(calls).toHaveLength(1);
      expect(calls[0].body.query).not.toMatch(/createProjectV2/);
    });

    it("creates the project when no exact match is found (3-call sequence)", async () => {
      const { fetchImpl, calls } = stubFetch([
        // 1) findProjectByTitle — empty result
        { data: { user: { projectsV2: { nodes: [] } } } },
        // 2) getOwnerId — returns the user node id
        { data: { user: { id: "U_new" } } },
        // 3) createProject — returns the new project
        {
          data: {
            createProjectV2: {
              projectV2: { id: "P_fresh", title: "relay", number: 9, url: "u" },
            },
          },
        },
      ]);
      const out = await resolveProject(
        { owner: "jcast90", ownerType: "user" },
        "relay",
        deps(fetchImpl)
      );
      expect(out.id).toBe("P_fresh");
      expect(calls).toHaveLength(3);
      expect(calls[0].body.query).toMatch(/projectsV2\(first: 20/);
      expect(calls[1].body.query).toMatch(/user\(login:/);
      expect(calls[2].body.query).toMatch(/createProjectV2/);
    });
  });

  describe("listProjectFields", () => {
    it("returns id+name pairs and preserves single-select option lists", async () => {
      const { fetchImpl } = stubFetch([
        {
          data: {
            node: {
              fields: {
                nodes: [
                  { id: "F_title", name: "Title" },
                  {
                    id: "F_status",
                    name: "Status",
                    options: [
                      { id: "o1", name: "Backlog" },
                      { id: "o2", name: "In progress" },
                    ],
                  },
                ],
              },
            },
          },
        },
      ]);
      const fields = await listProjectFields("P_id", deps(fetchImpl));
      expect(fields).toHaveLength(2);
      const status = fields.find((f) => f.name === "Status");
      expect(status?.options?.length).toBe(2);
      const title = fields.find((f) => f.name === "Title");
      expect(title?.options).toBeUndefined();
    });

    it("filters fragment nodes that didn't match a known field type", async () => {
      const { fetchImpl } = stubFetch([
        {
          data: {
            node: {
              fields: {
                nodes: [
                  { id: "F_title", name: "Title" },
                  // An iteration field shape — not matched by either fragment, no id/name
                  {},
                ],
              },
            },
          },
        },
      ]);
      const fields = await listProjectFields("P_id", deps(fetchImpl));
      expect(fields).toHaveLength(1);
      expect(fields[0].name).toBe("Title");
    });

    it("throws when the project node is null (deleted or wrong id)", async () => {
      const { fetchImpl } = stubFetch([{ data: { node: null } }]);
      await expect(listProjectFields("P_missing", deps(fetchImpl))).rejects.toThrow(
        /project not found \(P_missing\)/
      );
    });
  });

  describe("ensureCustomFields (PR A stub)", () => {
    it("reports which requested fields already exist and creates none", async () => {
      const { fetchImpl } = stubFetch([
        {
          data: {
            node: {
              fields: {
                nodes: [
                  { id: "F_status", name: "Status" },
                  { id: "F_other", name: "OtherThing" },
                ],
              },
            },
          },
        },
      ]);
      const out = await ensureCustomFields("P_id", ["Status", "Type", "Priority"], deps(fetchImpl));
      expect(out.existing).toEqual(["Status"]);
      // PR A is read-only — creation lands in PR B (#181).
      expect(out.created).toEqual([]);
    });
  });
});

/**
 * Live-network smoke test. Off by default — flip on locally with:
 *   HARNESS_LIVE=1 GITHUB_TOKEN=<your-token> \
 *   GITHUB_PROJECTS_TEST_OWNER=<login> \
 *   pnpm vitest run test/integrations/github-projects-client.test.ts
 *
 * Per AGENTS.md this stays inside `describe.skip` so default CI never
 * hits the real API.
 */
describe.skip("github-projects/client (live network)", () => {
  it("resolves a sandbox project against the real GraphQL endpoint", async () => {
    const token = process.env.GITHUB_TOKEN;
    const owner = process.env.GITHUB_PROJECTS_TEST_OWNER;
    if (!token || !owner) {
      throw new Error("GITHUB_TOKEN and GITHUB_PROJECTS_TEST_OWNER required");
    }
    const project = await resolveProject({ owner, ownerType: "user" }, "relay-test-sandbox", {
      token,
    });
    expect(project.id).toMatch(/^PVT_/);
  });
});
