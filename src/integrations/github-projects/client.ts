/**
 * GitHub Projects v2 GraphQL client. The first slice of the v0.2 tracker
 * work — owns project resolution (find-or-create by title) and a
 * read-only inventory of a project's custom fields. Draft-item CRUD and
 * the Status/Type/Priority bootstrap land in PR B (#181); channel/epic
 * wiring lands in PR C (#182).
 *
 * The client is deliberately framework-free: every call accepts a
 * `ProjectsClientDeps` bag, so tests inject a stub `fetch` and callers
 * inject the GitHub token from their own scope (we never read
 * `process.env.GITHUB_TOKEN` here — see the `passEnv` opt-in in
 * `src/agents/command-invoker.ts` for the secret-handling contract).
 */

const GITHUB_API_URL = "https://api.github.com/graphql";

export type GitHubOwnerType = "user" | "organization";

export interface ProjectV2Node {
  id: string;
  title: string;
  number: number;
  url: string;
}

export interface ProjectV2FieldNode {
  id: string;
  name: string;
  /** Single-select fields surface their option list; other field kinds omit it. */
  options?: Array<{ id: string; name: string }>;
}

export interface ProjectsClientDeps {
  /** GitHub token with `project` scope (and `read:org` for org-owned projects). */
  token: string;
  /** Injectable fetch so tests can stub the network. */
  fetch?: typeof fetch;
  /** Override for tests; defaults to the public GraphQL endpoint. */
  apiUrl?: string;
}

export interface ProjectOwnerRef {
  owner: string;
  ownerType: GitHubOwnerType;
}

interface GraphqlResponse<T> {
  data?: T;
  errors?: Array<{ message: string; type?: string; path?: Array<string | number> }>;
}

/**
 * Raw GraphQL POST. Throws on network error, non-2xx HTTP, or any
 * `errors` entry. Callers that want to tolerate a partial response should
 * wrap this and inspect `error.message` — we deliberately don't paper
 * over GraphQL errors because the sync worker (PR D) needs to surface
 * them as channel-feed warnings, not silently drop them.
 */
export async function githubProjectsGraphql<T>(
  query: string,
  variables: Record<string, unknown>,
  deps: ProjectsClientDeps
): Promise<T> {
  const fetchImpl = deps.fetch ?? fetch;
  const url = deps.apiUrl ?? GITHUB_API_URL;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${deps.token}`,
      "User-Agent": "relay-github-projects-client",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub Projects API HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const payload = (await res.json()) as GraphqlResponse<T>;
  if (payload.errors && payload.errors.length > 0) {
    throw new Error(`GitHub Projects GraphQL error: ${payload.errors[0].message}`);
  }
  if (!payload.data) {
    throw new Error("GitHub Projects API returned no data");
  }
  return payload.data;
}

/**
 * Resolve the GraphQL node id of the project owner. The createProjectV2
 * mutation needs this id; the public `login` is not enough. We split
 * user vs organization because the two GraphQL roots are distinct
 * (`user(login:)` vs `organization(login:)`) and one query that tries
 * both fails the schema-validation pass.
 */
export async function getOwnerId(ref: ProjectOwnerRef, deps: ProjectsClientDeps): Promise<string> {
  if (ref.ownerType === "user") {
    const data = await githubProjectsGraphql<{ user: { id: string } | null }>(
      `query($login: String!) { user(login: $login) { id } }`,
      { login: ref.owner },
      deps
    );
    if (!data.user) {
      throw new Error(`GitHub user not found: ${ref.owner}`);
    }
    return data.user.id;
  }
  const data = await githubProjectsGraphql<{ organization: { id: string } | null }>(
    `query($login: String!) { organization(login: $login) { id } }`,
    { login: ref.owner },
    deps
  );
  if (!data.organization) {
    throw new Error(`GitHub organization not found: ${ref.owner}`);
  }
  return data.organization.id;
}

interface ProjectsListNode {
  projectsV2: { nodes: ProjectV2Node[] };
}

/**
 * Look up a project by title under the given owner. GitHub's `query`
 * argument on `projectsV2` is a fuzzy substring match, so we re-filter
 * client-side on exact title equality to avoid returning a project
 * named "relay-core-ui-archive" when the caller asked for
 * "relay-core-ui". Caps at 20 candidates — the per-page max is 100, but
 * any owner with that many similarly-named projects has a different
 * problem.
 */
export async function findProjectByTitle(
  ref: ProjectOwnerRef,
  title: string,
  deps: ProjectsClientDeps
): Promise<ProjectV2Node | null> {
  const queryStr =
    ref.ownerType === "user"
      ? `query($login: String!, $q: String!) {
          user(login: $login) {
            projectsV2(first: 20, query: $q) {
              nodes { id title number url }
            }
          }
        }`
      : `query($login: String!, $q: String!) {
          organization(login: $login) {
            projectsV2(first: 20, query: $q) {
              nodes { id title number url }
            }
          }
        }`;

  const data = await githubProjectsGraphql<{
    user?: ProjectsListNode | null;
    organization?: ProjectsListNode | null;
  }>(queryStr, { login: ref.owner, q: title }, deps);

  const root = ref.ownerType === "user" ? data.user : data.organization;
  if (!root) {
    return null;
  }
  const exact = root.projectsV2.nodes.find((p) => p.title === title);
  return exact ?? null;
}

/**
 * Create a new project under the given owner. Caller is expected to
 * have already verified that no project with this title exists — see
 * `resolveProject` for the idempotent wrapper.
 */
export async function createProject(
  ownerId: string,
  title: string,
  deps: ProjectsClientDeps
): Promise<ProjectV2Node> {
  const data = await githubProjectsGraphql<{
    createProjectV2: { projectV2: ProjectV2Node };
  }>(
    `mutation($ownerId: ID!, $title: String!) {
      createProjectV2(input: { ownerId: $ownerId, title: $title }) {
        projectV2 { id title number url }
      }
    }`,
    { ownerId, title },
    deps
  );
  return data.createProjectV2.projectV2;
}

/**
 * Idempotent project resolver: returns an existing project with the
 * given title if one is found, otherwise creates it. This is the
 * primary entry point that PR C will call from the channel-create hook.
 */
export async function resolveProject(
  ref: ProjectOwnerRef,
  title: string,
  deps: ProjectsClientDeps
): Promise<ProjectV2Node> {
  const existing = await findProjectByTitle(ref, title, deps);
  if (existing) {
    return existing;
  }
  const ownerId = await getOwnerId(ref, deps);
  return createProject(ownerId, title, deps);
}

/**
 * Read-only inventory of a project's custom fields. PR A returns what
 * exists; PR B (#181) adds the create-missing-fields path that the
 * Status/Type/Priority bootstrap needs. Splitting it this way keeps
 * each PR sub-800 LOC and lets PR A merge without depending on the
 * field-creation mutations being settled.
 */
export async function listProjectFields(
  projectId: string,
  deps: ProjectsClientDeps
): Promise<ProjectV2FieldNode[]> {
  const data = await githubProjectsGraphql<{
    node: {
      fields: {
        nodes: Array<{
          id?: string;
          name?: string;
          options?: Array<{ id: string; name: string }>;
        }>;
      };
    } | null;
  }>(
    `query($projectId: ID!) {
      node(id: $projectId) {
        ... on ProjectV2 {
          fields(first: 50) {
            nodes {
              ... on ProjectV2FieldCommon { id name }
              ... on ProjectV2SingleSelectField { id name options { id name } }
            }
          }
        }
      }
    }`,
    { projectId },
    deps
  );
  if (!data.node) {
    throw new Error(`GitHub Projects API: project not found (${projectId})`);
  }
  return data.node.fields.nodes
    .filter(
      (n): n is { id: string; name: string; options?: Array<{ id: string; name: string }> } =>
        typeof n.id === "string" && typeof n.name === "string"
    )
    .map((n) => ({ id: n.id, name: n.name, options: n.options }));
}

// `ensureCustomFields` and the field-creation primitives moved to
// `./fields.ts` in PR B (#181). Re-export so existing imports keep
// working and `client.ts` stays the canonical entry point for the
// integration.
export {
  createSingleSelectField,
  defaultFieldOptions,
  ensureCustomFields,
  ensureCustomFieldsWithOptions,
  type CreateSingleSelectFieldInput,
  type EnsureFieldsResult,
  type SingleSelectColor,
  type SingleSelectOptionInput,
} from "./fields.js";

export {
  archiveItem,
  createDraftItem,
  setSingleSelectValue,
  updateDraftIssue,
  type ArchiveItemInput,
  type CreateDraftItemInput,
  type DraftItemRef,
  type SetSingleSelectValueInput,
  type UpdateDraftIssueInput,
} from "./draft-items.js";
