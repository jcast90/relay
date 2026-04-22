/**
 * Push a Relay channel's tickets to a GitHub Project v2 + create issues on a
 * target repo. Designed for the `#autonomous-loop` board and jcast90/relay
 * Project #3, but the ids/field-ids are CLI-overridable so the same script
 * works for other channels / projects.
 *
 * Idempotency: every issue gets an HTML-comment marker
 * `<!-- relay-ticket:<id> -->` in its body. Re-runs search for an existing
 * issue with that marker and skip creation (leaving the project-item +
 * field values to be re-applied so status can drift forward).
 *
 * Two-axis routing (AL-17): the project mirror carries the `(role, repo)`
 * routing model the autonomous loop uses. Each item gets a `Repo`
 * single-select populated from `ticket.assignedAlias` (fallback: the
 * channel's primary repo alias) and an `Admin` text field carrying
 * `repo-admin-<alias>`. Both fields are created on the project lazily if
 * they don't exist yet — the script is safe to re-run against a board that
 * was already bootstrapped manually via the web UI.
 *
 * Usage:
 *   tsx scripts/push-tickets-to-github.ts --channel <channelId>
 *     [--repo jcast90/relay] [--owner jcast90] [--project-number 3]
 *     [--project-id PVT_...] [--dry-run]
 *
 * Requires: `gh` CLI authenticated with `project,read:project,repo` scopes.
 */

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

import { ChannelStore } from "../src/channels/channel-store.js";
import type { TicketDefinition } from "../src/domain/ticket.js";

type Effort = "S" | "M" | "L";

type Args = {
  channel: string;
  repo: string;
  owner: string;
  projectNumber: number;
  projectId: string;
  dryRun: boolean;
};

// Field names on the project. Everything is discovered at runtime by
// name (see `discoverFields`) so the script isn't pinned to Project #3's
// specific field ids — pass `--project-id`/`--project-number` to run it
// against a different project with the same field names.
const STATUS_FIELD_NAME = "Status";
const RELAY_ID_FIELD_NAME = "Relay ID";
const EFFORT_FIELD_NAME = "Effort";
const DEPENDS_ON_FIELD_NAME = "Depends on";

// Two-axis routing field names — the script creates-or-reuses these on
// Project #3. Names are matched case-sensitively against the project's
// existing field list.
// Named "Target Repo" to avoid visual confusion with GitHub's built-in
// Repository column in the project view.
const REPO_FIELD_NAME = "Target Repo";
const ADMIN_FIELD_NAME = "Admin";

// Default palette colors for single-select option creation. The GitHub
// GraphQL enum values are UPPERCASE; rotate through them so a freshly
// populated field doesn't end up all-gray.
const OPTION_COLORS = ["BLUE", "GREEN", "PURPLE", "ORANGE", "PINK", "YELLOW", "RED"] as const;

type ProjectFields = {
  // Four pre-existing fields on the project. Discovered by name rather
  // than hard-coded so `--project-id` can point at any project that has
  // these field names.
  status: {
    id: string;
    options: { todo: string; inProgress: string; done: string };
  };
  relayId: { id: string };
  effort: {
    id: string;
    options: { S: string; M: string; L: string };
  };
  dependsOn: { id: string };
  // Two-axis routing fields. Created by this script on first run if
  // absent, otherwise reused by name.
  repoFieldId: string;
  adminFieldId: string;
  // Map from alias → option id for the `Target Repo` single-select field.
  repoOptions: Map<string, string>;
  // Full option list (name + color + description) so we can round-trip it
  // through `updateProjectV2Field` when we need to append a new alias —
  // GitHub's mutation replaces the option set wholesale.
  repoOptionDefs: Array<{ id: string; name: string; color: string; description: string }>;
};

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined => {
    const idx = argv.findIndex((a) => a === name);
    return idx >= 0 ? argv[idx + 1] : undefined;
  };
  const channel = get("--channel");
  if (!channel) {
    throw new Error("Missing required --channel <channelId>");
  }
  return {
    channel,
    repo: get("--repo") ?? "jcast90/relay",
    owner: get("--owner") ?? "jcast90",
    projectNumber: Number(get("--project-number") ?? "3"),
    projectId: get("--project-id") ?? "PVT_kwHOAPon-c4BVZUp",
    dryRun: argv.includes("--dry-run"),
  };
}

// Surface stderr + stdout for the caller to read since `gh` writes some
// informational lines to stderr even on success.
function gh(args: string[], input?: string): string {
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    input,
  });
  if (result.status !== 0) {
    throw new Error(
      `gh ${args.slice(0, 3).join(" ")}… failed (exit ${result.status}): ${result.stderr || result.stdout}`
    );
  }
  return result.stdout.trim();
}

function parseEffort(title: string): Effort | null {
  const m = title.match(/^\[([SML])\]/);
  return (m?.[1] as Effort) ?? null;
}

function statusBucket(relayStatus: string): "todo" | "inProgress" | "done" {
  switch (relayStatus) {
    case "completed":
      return "done";
    case "executing":
    case "verifying":
    case "retry":
      return "inProgress";
    default:
      return "todo";
  }
}

function buildIssueBody(ticket: TicketDefinition, dependsOn: string[]): string {
  const checklist = ticket.acceptanceCriteria.map((c) => `- [ ] ${c}`).join("\n");
  const deps = dependsOn.length > 0 ? dependsOn.map((d) => `\`${d}\``).join(", ") : "_none_";
  return [
    `<!-- relay-ticket:${ticket.id} -->`,
    "",
    "## Objective",
    "",
    ticket.objective,
    "",
    "## Acceptance criteria",
    "",
    checklist,
    "",
    "## Dependencies",
    "",
    deps,
    "",
    "---",
    "",
    `_Seeded from Relay ticket \`${ticket.id}\`. Do not remove the marker comment at the top — it's used for idempotent re-sync._`,
  ].join("\n");
}

function findExistingIssue(repo: string, ticketId: string): string | null {
  // `gh issue list --search` on body is supported by the API search syntax.
  // Use JSON output so we can match exactly on the marker (search is fuzzy).
  const raw = gh([
    "issue",
    "list",
    "--repo",
    repo,
    "--state",
    "all",
    "--search",
    `"relay-ticket:${ticketId}" in:body`,
    "--json",
    "number,url,body",
    "--limit",
    "20",
  ]);
  if (!raw) return null;
  const rows = JSON.parse(raw) as Array<{ number: number; url: string; body: string }>;
  const match = rows.find((r) => r.body.includes(`<!-- relay-ticket:${ticketId} -->`));
  return match?.url ?? null;
}

function ensureLabel(repo: string, name: string, color: string, description: string): void {
  const raw = gh([
    "label",
    "list",
    "--repo",
    repo,
    "--search",
    name,
    "--json",
    "name",
    "--limit",
    "50",
  ]);
  const names = raw ? (JSON.parse(raw) as Array<{ name: string }>).map((l) => l.name) : [];
  if (names.includes(name)) return;
  gh([
    "label",
    "create",
    name,
    "--repo",
    repo,
    "--color",
    color,
    "--description",
    description,
    "--force",
  ]);
}

function createIssue(repo: string, title: string, body: string, labels: string[]): string {
  const args = ["issue", "create", "--repo", repo, "--title", title, "--body-file", "-"];
  for (const label of labels) {
    args.push("--label", label);
  }
  return gh(args, body);
}

function addItemToProject(projectId: string, issueUrl: string): string {
  const result = gh([
    "api",
    "graphql",
    "-f",
    `query=
mutation AddItem($projectId: ID!, $contentId: ID!) {
  addProjectV2ItemById(input: {projectId: $projectId, contentId: $contentId}) {
    item { id }
  }
}`,
    "-f",
    `projectId=${projectId}`,
    "-f",
    `contentId=${resolveIssueNodeId(issueUrl)}`,
  ]);
  const parsed = JSON.parse(result) as {
    data?: { addProjectV2ItemById?: { item?: { id: string } } };
  };
  const id = parsed.data?.addProjectV2ItemById?.item?.id;
  if (!id) throw new Error(`addProjectV2ItemById returned no item id: ${result}`);
  return id;
}

function resolveIssueNodeId(issueUrl: string): string {
  const out = gh(["issue", "view", issueUrl, "--json", "id"]);
  return (JSON.parse(out) as { id: string }).id;
}

function setSingleSelectField(
  projectId: string,
  itemId: string,
  fieldId: string,
  optionId: string
): void {
  gh([
    "api",
    "graphql",
    "-f",
    `query=
mutation SetField($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
  updateProjectV2ItemFieldValue(input: {
    projectId: $projectId
    itemId: $itemId
    fieldId: $fieldId
    value: {singleSelectOptionId: $optionId}
  }) { projectV2Item { id } }
}`,
    "-f",
    `projectId=${projectId}`,
    "-f",
    `itemId=${itemId}`,
    "-f",
    `fieldId=${fieldId}`,
    "-f",
    `optionId=${optionId}`,
  ]);
}

function setTextField(projectId: string, itemId: string, fieldId: string, text: string): void {
  gh([
    "api",
    "graphql",
    "-f",
    `query=
mutation SetText($projectId: ID!, $itemId: ID!, $fieldId: ID!, $text: String!) {
  updateProjectV2ItemFieldValue(input: {
    projectId: $projectId
    itemId: $itemId
    fieldId: $fieldId
    value: {text: $text}
  }) { projectV2Item { id } }
}`,
    "-f",
    `projectId=${projectId}`,
    "-f",
    `itemId=${itemId}`,
    "-f",
    `fieldId=${fieldId}`,
    "-f",
    `text=${text}`,
  ]);
}

type ProjectFieldNode =
  | {
      __typename: "ProjectV2Field";
      id: string;
      name: string;
      dataType: string;
    }
  | {
      __typename: "ProjectV2SingleSelectField";
      id: string;
      name: string;
      dataType: string;
      options: Array<{ id: string; name: string; color?: string; description?: string }>;
    };

function listProjectFields(owner: string, projectNumber: number): ProjectFieldNode[] {
  const out = gh([
    "api",
    "graphql",
    "-f",
    `query=
query ProjectFields($owner: String!, $number: Int!) {
  user(login: $owner) {
    projectV2(number: $number) {
      fields(first: 50) {
        nodes {
          __typename
          ... on ProjectV2Field { id name dataType }
          ... on ProjectV2SingleSelectField {
            id
            name
            dataType
            options { id name color description }
          }
        }
      }
    }
  }
}`,
    "-F",
    `owner=${owner}`,
    "-F",
    `number=${projectNumber}`,
  ]);
  const parsed = JSON.parse(out) as {
    data?: { user?: { projectV2?: { fields?: { nodes?: ProjectFieldNode[] } } } };
  };
  return parsed.data?.user?.projectV2?.fields?.nodes ?? [];
}

function createTextField(projectId: string, name: string): string {
  const out = gh([
    "api",
    "graphql",
    "-f",
    `query=
mutation CreateTextField($projectId: ID!, $name: String!) {
  createProjectV2Field(input: {
    projectId: $projectId
    dataType: TEXT
    name: $name
  }) { projectV2Field { ... on ProjectV2Field { id name dataType } } }
}`,
    "-f",
    `projectId=${projectId}`,
    "-f",
    `name=${name}`,
  ]);
  const parsed = JSON.parse(out) as {
    data?: { createProjectV2Field?: { projectV2Field?: { id: string } } };
  };
  const id = parsed.data?.createProjectV2Field?.projectV2Field?.id;
  if (!id) throw new Error(`createProjectV2Field(TEXT, ${name}) returned no id: ${out}`);
  return id;
}

function createSingleSelectField(
  projectId: string,
  name: string,
  options: Array<{ name: string; color: string; description: string }>
): { id: string; options: Array<{ id: string; name: string; color?: string }> } {
  // `singleSelectOptions` must be a JSON array on the GraphQL variable slot
  // — `gh api -f/-F` both stringify, so pipe a pre-constructed payload
  // through `--input -` to preserve array shape.
  const query = `mutation CreateSelectField($projectId: ID!, $name: String!, $options: [ProjectV2SingleSelectFieldOptionInput!]!) {
  createProjectV2Field(input: {
    projectId: $projectId
    dataType: SINGLE_SELECT
    name: $name
    singleSelectOptions: $options
  }) {
    projectV2Field {
      ... on ProjectV2SingleSelectField {
        id
        name
        options { id name color description }
      }
    }
  }
}`;
  const payload = JSON.stringify({
    query,
    variables: { projectId, name, options },
  });
  const out = gh(["api", "graphql", "--input", "-"], payload);
  const parsed = JSON.parse(out) as {
    data?: {
      createProjectV2Field?: {
        projectV2Field?: {
          id: string;
          options?: Array<{ id: string; name: string; color?: string }>;
        };
      };
    };
  };
  const field = parsed.data?.createProjectV2Field?.projectV2Field;
  if (!field?.id) {
    throw new Error(`createProjectV2Field(SINGLE_SELECT, ${name}) returned no id: ${out}`);
  }
  return { id: field.id, options: field.options ?? [] };
}

function pickOptionColor(index: number): string {
  return OPTION_COLORS[index % OPTION_COLORS.length];
}

/**
 * Look up every project field this script writes to. The four base
 * fields (`Status`, `Relay ID`, `Effort`, `Depends on`) must already
 * exist — the script errors out if they don't. The two routing fields
 * (`Target Repo`, `Admin`) are created lazily on first run and reused
 * by name on subsequent runs.
 */
function discoverFields(
  projectId: string,
  owner: string,
  projectNumber: number,
  seedAliases: string[]
): ProjectFields {
  const nodes = listProjectFields(owner, projectNumber);

  const findSingleSelect = (name: string) =>
    nodes.find(
      (n): n is Extract<ProjectFieldNode, { __typename: "ProjectV2SingleSelectField" }> =>
        n.__typename === "ProjectV2SingleSelectField" && n.name === name
    );
  const findText = (name: string) =>
    nodes.find(
      (n): n is Extract<ProjectFieldNode, { __typename: "ProjectV2Field" }> =>
        n.__typename === "ProjectV2Field" && n.name === name
    );

  const statusField = findSingleSelect(STATUS_FIELD_NAME);
  if (!statusField) {
    throw new Error(`Project is missing required single-select field "${STATUS_FIELD_NAME}"`);
  }
  const statusOptionId = (label: string): string => {
    const opt = statusField.options.find((o) => o.name.toLowerCase() === label.toLowerCase());
    if (!opt) {
      throw new Error(
        `"${STATUS_FIELD_NAME}" field missing expected option "${label}" (have: ${statusField.options
          .map((o) => o.name)
          .join(", ")})`
      );
    }
    return opt.id;
  };

  const relayIdField = findText(RELAY_ID_FIELD_NAME);
  if (!relayIdField) {
    throw new Error(`Project is missing required text field "${RELAY_ID_FIELD_NAME}"`);
  }

  const effortField = findSingleSelect(EFFORT_FIELD_NAME);
  if (!effortField) {
    throw new Error(`Project is missing required single-select field "${EFFORT_FIELD_NAME}"`);
  }
  const effortOptionId = (label: "S" | "M" | "L"): string => {
    const opt = effortField.options.find((o) => o.name === label);
    if (!opt) {
      throw new Error(
        `"${EFFORT_FIELD_NAME}" field missing expected option "${label}" (have: ${effortField.options
          .map((o) => o.name)
          .join(", ")})`
      );
    }
    return opt.id;
  };

  const dependsOnField = findText(DEPENDS_ON_FIELD_NAME);
  if (!dependsOnField) {
    throw new Error(`Project is missing required text field "${DEPENDS_ON_FIELD_NAME}"`);
  }

  let repo = findSingleSelect(REPO_FIELD_NAME);
  let admin = findText(ADMIN_FIELD_NAME);

  if (!repo) {
    const options = seedAliases.map((alias, i) => ({
      name: alias,
      color: pickOptionColor(i),
      description: `Repo alias: ${alias}`,
    }));
    // Always seed at least one option so the select is usable immediately.
    if (options.length === 0) {
      options.push({ name: "relay", color: pickOptionColor(0), description: "Repo alias: relay" });
    }
    const created = createSingleSelectField(projectId, REPO_FIELD_NAME, options);
    console.error(
      `[AL-17] Created ${REPO_FIELD_NAME} single-select field ${created.id} with options ${created.options
        .map((o) => `${o.name}=${o.id}`)
        .join(", ")}`
    );
    repo = {
      __typename: "ProjectV2SingleSelectField",
      id: created.id,
      name: REPO_FIELD_NAME,
      dataType: "SINGLE_SELECT",
      options: created.options.map((o) => ({
        id: o.id,
        name: o.name,
        color: o.color,
        description: "",
      })),
    };
  }
  if (!admin) {
    const id = createTextField(projectId, ADMIN_FIELD_NAME);
    console.error(`[AL-17] Created ${ADMIN_FIELD_NAME} text field ${id}`);
    admin = {
      __typename: "ProjectV2Field",
      id,
      name: ADMIN_FIELD_NAME,
      dataType: "TEXT",
    };
  }

  const repoOptions = new Map<string, string>();
  const repoOptionDefs: ProjectFields["repoOptionDefs"] = [];
  for (const [i, opt] of repo.options.entries()) {
    repoOptions.set(opt.name, opt.id);
    repoOptionDefs.push({
      id: opt.id,
      name: opt.name,
      color: (opt.color ?? "").toUpperCase() || pickOptionColor(i),
      description: opt.description ?? "",
    });
  }

  return {
    status: {
      id: statusField.id,
      options: {
        todo: statusOptionId("Todo"),
        inProgress: statusOptionId("In Progress"),
        done: statusOptionId("Done"),
      },
    },
    relayId: { id: relayIdField.id },
    effort: {
      id: effortField.id,
      options: {
        S: effortOptionId("S"),
        M: effortOptionId("M"),
        L: effortOptionId("L"),
      },
    },
    dependsOn: { id: dependsOnField.id },
    repoFieldId: repo.id,
    adminFieldId: admin.id,
    repoOptions,
    repoOptionDefs,
  };
}

/**
 * Add a new alias option to the existing `Repo` single-select field.
 * `updateProjectV2Field` replaces the option set wholesale, so we pass
 * every existing option (with its `id` so GitHub preserves it — dropping
 * the id causes GitHub to re-issue fresh ids, orphaning every already-
 * assigned item) plus the new option (which has no id yet).
 */
function addRepoOption(projectId: string, fields: ProjectFields, alias: string): string {
  const next = [
    ...fields.repoOptionDefs.map((o) => ({
      id: o.id,
      name: o.name,
      color: o.color || pickOptionColor(0),
      description: o.description ?? "",
    })),
    {
      name: alias,
      color: pickOptionColor(fields.repoOptionDefs.length),
      description: `Repo alias: ${alias}`,
    },
  ];
  const query = `mutation AppendOption($fieldId: ID!, $options: [ProjectV2SingleSelectFieldOptionInput!]!) {
  updateProjectV2Field(input: {
    fieldId: $fieldId
    singleSelectOptions: $options
  }) {
    projectV2Field {
      ... on ProjectV2SingleSelectField {
        id
        options { id name color description }
      }
    }
  }
}`;
  const payload = JSON.stringify({
    query,
    variables: { fieldId: fields.repoFieldId, options: next },
  });
  const out = gh(["api", "graphql", "--input", "-"], payload);
  const parsed = JSON.parse(out) as {
    data?: {
      updateProjectV2Field?: {
        projectV2Field?: { options?: Array<{ id: string; name: string; color?: string }> };
      };
    };
    errors?: Array<{ message: string }>;
  };
  if (parsed.errors?.length) {
    throw new Error(
      `updateProjectV2Field failed — likely can't append options via API on this project: ` +
        parsed.errors.map((e) => e.message).join("; ") +
        `. Add the '${alias}' option manually via the project UI and re-run.`
    );
  }
  const options = parsed.data?.updateProjectV2Field?.projectV2Field?.options ?? [];
  // Refresh the local cache so a subsequent ticket with the same alias
  // doesn't re-add it.
  fields.repoOptions.clear();
  fields.repoOptionDefs.length = 0;
  for (const [i, opt] of options.entries()) {
    fields.repoOptions.set(opt.name, opt.id);
    fields.repoOptionDefs.push({
      id: opt.id,
      name: opt.name,
      color: (opt.color ?? "").toUpperCase() || pickOptionColor(i),
      description: "",
    });
  }
  const created = fields.repoOptions.get(alias);
  if (!created) {
    throw new Error(`updateProjectV2Field returned no option id for ${alias}: ${out}`);
  }
  return created;
}

type ItemFieldValues = {
  repoOptionName?: string;
  adminText?: string;
  relayIdText?: string;
  effortOptionName?: string;
  statusOptionName?: string;
  dependsOnText?: string;
};

/**
 * Fetch the current field values for a single project item. Lets the
 * write path skip no-op mutations — cheap single query vs. potentially 5
 * field writes per ticket on re-run.
 */
function getItemFieldValues(itemId: string): ItemFieldValues {
  const out = gh([
    "api",
    "graphql",
    "-f",
    `query=
query ItemFields($itemId: ID!) {
  node(id: $itemId) {
    ... on ProjectV2Item {
      fieldValues(first: 30) {
        nodes {
          __typename
          ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2Field { name } } }
          ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2SingleSelectField { name } } }
        }
      }
    }
  }
}`,
    "-f",
    `itemId=${itemId}`,
  ]);
  const parsed = JSON.parse(out) as {
    data?: {
      node?: {
        fieldValues?: {
          nodes?: Array<{
            __typename: string;
            text?: string;
            name?: string;
            field?: { name?: string };
          }>;
        };
      };
    };
  };
  const values: ItemFieldValues = {};
  for (const node of parsed.data?.node?.fieldValues?.nodes ?? []) {
    const fieldName = node.field?.name;
    if (!fieldName) continue;
    if (node.__typename === "ProjectV2ItemFieldTextValue") {
      if (fieldName === REPO_FIELD_NAME) values.repoOptionName = node.text ?? undefined;
      if (fieldName === ADMIN_FIELD_NAME) values.adminText = node.text ?? undefined;
      if (fieldName === "Relay ID") values.relayIdText = node.text ?? undefined;
      if (fieldName === "Depends on") values.dependsOnText = node.text ?? undefined;
    } else if (node.__typename === "ProjectV2ItemFieldSingleSelectValue") {
      if (fieldName === "Status") values.statusOptionName = node.name ?? undefined;
      if (fieldName === "Effort") values.effortOptionName = node.name ?? undefined;
      if (fieldName === REPO_FIELD_NAME) values.repoOptionName = node.name ?? undefined;
    }
  }
  return values;
}

// Sentinel signalling "intentionally leave Repo/Admin unset for this
// ticket" (e.g. the ticket's assignedAlias doesn't match any
// repoAssignment on the channel). Distinct from `undefined` which means
// "no routing override — fall back to the channel's primary alias".
const UNSET_ALIAS = null;
type AssignedAliasValue = string | undefined | typeof UNSET_ALIAS;

async function loadRunForChannel(channelId: string): Promise<{
  tickets: TicketDefinition[];
  relayStatusById: Map<string, string>;
  assignedAliasById: Map<string, AssignedAliasValue>;
  primaryAlias: string | null;
}> {
  const channelStore = new ChannelStore();
  const channel = await channelStore.getChannel(channelId);
  const primaryAlias = channel ? (channelStore.getPrimaryAssignment(channel)?.alias ?? null) : null;
  const knownAliases = new Set((channel?.repoAssignments ?? []).map((a) => a.alias));

  const ledger = await channelStore.readChannelTickets(channelId);
  if (ledger.length === 0) {
    throw new Error(`Channel ${channelId} has no tickets on its board`);
  }
  const relayStatusById = new Map(ledger.map((t) => [t.ticketId, t.status]));
  const assignedAliasById = new Map<string, AssignedAliasValue>();
  for (const t of ledger) {
    if (t.assignedAlias && !knownAliases.has(t.assignedAlias)) {
      console.error(
        `[AL-17] warning: ticket ${t.ticketId} has assignedAlias=${t.assignedAlias} but channel ${channelId} has no matching repoAssignment — leaving Repo/Admin unset for this ticket.`
      );
      // Sentinel: the writer will skip Repo/Admin for this ticket
      // rather than silently falling back to the primary alias.
      assignedAliasById.set(t.ticketId, UNSET_ALIAS);
    } else {
      assignedAliasById.set(t.ticketId, t.assignedAlias);
    }
  }

  // Tickets on the channel board are TicketLedgerEntry (status/metadata only)
  // — the rich definition (objective + acceptance criteria) lives in the
  // per-run snapshot. Resolve the run via `runs.json` then read run.json.
  const runsLink = await channelStore.readRunLinks(channelId);
  const latest = runsLink[runsLink.length - 1];
  if (!latest) {
    throw new Error(`Channel ${channelId} has no linked run — reseed the board first`);
  }
  const runPath = join(
    homedir(),
    ".relay",
    "workspaces",
    latest.workspaceId,
    "artifacts",
    latest.runId,
    "run.json"
  );
  const raw = await readFile(runPath, "utf8");
  const run = JSON.parse(raw) as {
    ticketPlan: { tickets: TicketDefinition[] };
  };
  return {
    tickets: run.ticketPlan.tickets,
    relayStatusById,
    assignedAliasById,
    primaryAlias,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { tickets, relayStatusById, assignedAliasById, primaryAlias } = await loadRunForChannel(
    args.channel
  );

  if (!args.dryRun) {
    // Make sure the labels exist so `gh issue create --label` doesn't fail.
    ensureLabel(args.repo, "autonomous-loop", "5319e7", "Autonomous-loop rollout tickets");
    ensureLabel(args.repo, "relay-seeded", "fbca04", "Seeded from a Relay ticket board");
    ensureLabel(args.repo, "size/S", "c2e0c6", "Small");
    ensureLabel(args.repo, "size/M", "fef2c0", "Medium");
    ensureLabel(args.repo, "size/L", "f9d0c4", "Large");
  }

  // Seed aliases for the Repo single-select: union of every ticket's
  // routed alias + the channel's primary alias. Deduped, deterministic.
  const seedAliases = Array.from(
    new Set(
      [primaryAlias, ...tickets.map((t) => assignedAliasById.get(t.id) ?? primaryAlias)].filter(
        (a): a is string => Boolean(a)
      )
    )
  );

  const fields = args.dryRun
    ? null
    : discoverFields(args.projectId, args.owner, args.projectNumber, seedAliases);

  const rows: Array<{
    ticket: string;
    status: string;
    url: string;
    action: string;
    repo?: string;
    admin?: string;
  }> = [];

  for (const t of tickets) {
    const effort = parseEffort(t.title);
    const sizeLabel = effort ? `size/${effort}` : null;
    const relayStatus = relayStatusById.get(t.id) ?? "ready";
    const bucket = statusBucket(relayStatus);

    const existing = args.dryRun ? null : findExistingIssue(args.repo, t.id);
    let issueUrl: string;
    let action: string;
    const body = buildIssueBody(t, t.dependsOn);
    if (existing) {
      issueUrl = existing;
      action = "updated";
      // Keep the issue body in sync with the authoritative ticket plan so
      // objective/acceptance-criteria/deps edits in the seeder propagate.
      gh(["issue", "edit", issueUrl, "--body-file", "-"], body);
    } else if (args.dryRun) {
      issueUrl = "(dry-run, not created)";
      action = "would-create";
    } else {
      const labels = ["autonomous-loop", "relay-seeded", ...(sizeLabel ? [sizeLabel] : [])];
      issueUrl = createIssue(args.repo, t.title, body, labels);
      action = "created";
    }

    // Resolve the per-ticket routing axis.
    //  - `UNSET_ALIAS` (null): ticket had a bad assignedAlias — leave
    //    Repo/Admin unwritten so the data drift is visible on the board.
    //  - `undefined`: no per-ticket routing; fall back to the channel's
    //    primary repo alias.
    //  - `string`: explicit routing to that alias.
    const rawAlias = assignedAliasById.get(t.id);
    const routedAlias: string | undefined =
      rawAlias === UNSET_ALIAS ? undefined : (rawAlias ?? primaryAlias ?? undefined);
    const skipRepoAdminWrite = rawAlias === UNSET_ALIAS;
    const adminText = routedAlias ? `repo-admin-${routedAlias}` : undefined;

    if (!args.dryRun && fields) {
      const itemId = addItemToProject(args.projectId, issueUrl);
      const current = getItemFieldValues(itemId);

      if (current.statusOptionName !== buildStatusName(bucket)) {
        setSingleSelectField(
          args.projectId,
          itemId,
          fields.status.id,
          fields.status.options[bucket]
        );
      }
      if (current.relayIdText !== t.id) {
        setTextField(args.projectId, itemId, fields.relayId.id, t.id);
      }
      if (effort && current.effortOptionName !== effort) {
        setSingleSelectField(
          args.projectId,
          itemId,
          fields.effort.id,
          fields.effort.options[effort]
        );
      }
      const depsText = t.dependsOn.length > 0 ? t.dependsOn.join(", ") : "";
      if (depsText && current.dependsOnText !== depsText) {
        setTextField(args.projectId, itemId, fields.dependsOn.id, depsText);
      }

      if (!skipRepoAdminWrite) {
        if (routedAlias) {
          let optionId = fields.repoOptions.get(routedAlias);
          if (!optionId) {
            optionId = addRepoOption(args.projectId, fields, routedAlias);
          }
          if (current.repoOptionName !== routedAlias) {
            setSingleSelectField(args.projectId, itemId, fields.repoFieldId, optionId);
          }
        }
        if (adminText && current.adminText !== adminText) {
          setTextField(args.projectId, itemId, fields.adminFieldId, adminText);
        }
      }
    }

    rows.push({
      ticket: t.id,
      status: relayStatus,
      url: issueUrl,
      action,
      repo: routedAlias,
      admin: adminText,
    });
  }

  console.log(
    JSON.stringify(
      {
        project: args.projectId,
        repo: args.repo,
        twoAxisFields: fields
          ? {
              repoFieldId: fields.repoFieldId,
              adminFieldId: fields.adminFieldId,
              repoOptions: Object.fromEntries(fields.repoOptions),
            }
          : null,
        rows,
      },
      null,
      2
    )
  );
}

function buildStatusName(bucket: "todo" | "inProgress" | "done"): string {
  switch (bucket) {
    case "todo":
      return "Todo";
    case "inProgress":
      return "In Progress";
    case "done":
      return "Done";
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
