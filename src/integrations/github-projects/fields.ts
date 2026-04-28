/**
 * Custom-field bootstrap for GitHub Projects v2. Replaces the read-only
 * stub that PR A shipped (`ensureCustomFields` returned an empty
 * `created` array). PR B (#181) wires up the actual field-creation
 * mutation plus seeded option lists for Status / Type / Priority so PR
 * C can stand up a fresh project end-to-end.
 *
 * The `defaultFieldOptions` table is intentionally narrow — Relay only
 * needs three single-select fields. Callers outside the channel/epic
 * flow that want different fields can pass their own option lists via
 * `ensureCustomFieldsWithOptions`.
 */
import {
  githubProjectsGraphql,
  listProjectFields,
  type ProjectsClientDeps,
  type ProjectV2FieldNode,
} from "./client.js";

/** GitHub's `ProjectV2SingleSelectFieldOptionColor` enum values. */
export type SingleSelectColor =
  | "GRAY"
  | "BLUE"
  | "GREEN"
  | "YELLOW"
  | "ORANGE"
  | "RED"
  | "PINK"
  | "PURPLE";

export interface SingleSelectOptionInput {
  name: string;
  color: SingleSelectColor;
  /** GraphQL requires a non-null description. Empty string is accepted. */
  description: string;
}

/**
 * Default option seeds for the three custom fields PR C wires from the
 * channel-create hook. Names match the Relay ticket-status enum values
 * exactly so the sync worker (PR D) can map without translation.
 */
export const defaultFieldOptions: Record<string, SingleSelectOptionInput[]> = {
  Status: [
    { name: "backlog", color: "GRAY", description: "Not yet started" },
    { name: "in_progress", color: "BLUE", description: "Active work" },
    { name: "needs_review", color: "YELLOW", description: "Awaiting review" },
    { name: "done", color: "GREEN", description: "Completed" },
  ],
  Type: [
    { name: "epic", color: "PURPLE", description: "Channel-level rollup" },
    { name: "ticket", color: "GRAY", description: "Individual unit of work" },
  ],
  Priority: [
    { name: "low", color: "GRAY", description: "Low priority" },
    { name: "med", color: "YELLOW", description: "Medium priority" },
    { name: "high", color: "RED", description: "High priority" },
  ],
};

export interface CreateSingleSelectFieldInput {
  projectId: string;
  name: string;
  options: SingleSelectOptionInput[];
}

/**
 * Create a single-select custom field on a project. The
 * `singleSelectOptions` input is required at creation time — adding
 * options later goes through a separate mutation we don't need yet.
 */
export async function createSingleSelectField(
  input: CreateSingleSelectFieldInput,
  deps: ProjectsClientDeps
): Promise<ProjectV2FieldNode> {
  const data = await githubProjectsGraphql<{
    createProjectV2Field: {
      projectV2Field: {
        id: string;
        name: string;
        options?: Array<{ id: string; name: string }>;
      };
    };
  }>(
    `mutation(
      $projectId: ID!,
      $name: String!,
      $singleSelectOptions: [ProjectV2SingleSelectFieldOptionInput!]
    ) {
      createProjectV2Field(input: {
        projectId: $projectId,
        dataType: SINGLE_SELECT,
        name: $name,
        singleSelectOptions: $singleSelectOptions
      }) {
        projectV2Field {
          ... on ProjectV2SingleSelectField { id name options { id name } }
        }
      }
    }`,
    {
      projectId: input.projectId,
      name: input.name,
      singleSelectOptions: input.options,
    },
    deps
  );
  const created = data.createProjectV2Field.projectV2Field;
  return { id: created.id, name: created.name, options: created.options };
}

export interface EnsureFieldsResult {
  /** Field names already present on the project — left untouched. */
  existing: string[];
  /** Field names created by this call. */
  created: string[];
}

/**
 * Idempotent custom-field bootstrap. Lists the project's existing
 * fields, then creates a single-select for every requested name that
 * isn't present, using the default option seeds. Returns which names
 * fell into which bucket so callers can log a meaningful summary.
 *
 * Names that have no entry in `defaultFieldOptions` are treated as a
 * caller error — use `ensureCustomFieldsWithOptions` if you need a
 * custom seed list.
 */
export async function ensureCustomFields(
  projectId: string,
  fieldNames: readonly string[],
  deps: ProjectsClientDeps
): Promise<EnsureFieldsResult> {
  for (const name of fieldNames) {
    if (!defaultFieldOptions[name]) {
      throw new Error(
        `ensureCustomFields: no default option seed for "${name}". ` +
          `Use ensureCustomFieldsWithOptions to supply your own.`
      );
    }
  }
  const fields = await listProjectFields(projectId, deps);
  const present = new Set(fields.map((f) => f.name));

  const existing: string[] = [];
  const created: string[] = [];
  for (const name of fieldNames) {
    if (present.has(name)) {
      existing.push(name);
      continue;
    }
    await createSingleSelectField({ projectId, name, options: defaultFieldOptions[name] }, deps);
    created.push(name);
  }
  return { existing, created };
}

/**
 * Lower-level variant for callers that want to bootstrap fields with
 * their own option lists. Same idempotency contract as
 * `ensureCustomFields` — fields whose names are already present are
 * left untouched (their options are NOT reconciled, by design — option
 * reconciliation across renames is a hairy area we'd rather solve
 * deliberately when a real need surfaces).
 */
export async function ensureCustomFieldsWithOptions(
  projectId: string,
  spec: ReadonlyArray<{ name: string; options: SingleSelectOptionInput[] }>,
  deps: ProjectsClientDeps
): Promise<EnsureFieldsResult> {
  const fields = await listProjectFields(projectId, deps);
  const present = new Set(fields.map((f) => f.name));

  const existing: string[] = [];
  const created: string[] = [];
  for (const { name, options } of spec) {
    if (present.has(name)) {
      existing.push(name);
      continue;
    }
    await createSingleSelectField({ projectId, name, options }, deps);
    created.push(name);
  }
  return { existing, created };
}
