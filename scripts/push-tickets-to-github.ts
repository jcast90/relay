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

// Project #3 (Relay) field ids — discovered via the GraphQL schema query.
// Hard-coded so the script doesn't round-trip discovery on every run; swap
// via --project-id + a discovery pass if the project changes.
const FIELDS = {
  status: {
    id: "PVTSSF_lAHOAPon-c4BVZUpzhQ1aBc",
    options: {
      todo: "f75ad846",
      inProgress: "47fc9ee4",
      done: "98236657",
    },
  },
  relayId: "PVTF_lAHOAPon-c4BVZUpzhQ2Jgs",
  effort: {
    id: "PVTSSF_lAHOAPon-c4BVZUpzhQ2Jg0",
    options: { S: "73175763", M: "3eaa7fc6", L: "5f8d4460" },
  },
  dependsOn: "PVTF_lAHOAPon-c4BVZUpzhQ2Jik",
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

async function loadRunForChannel(
  channelId: string
): Promise<{ tickets: TicketDefinition[]; relayStatusById: Map<string, string> }> {
  const channelStore = new ChannelStore();
  const ledger = await channelStore.readChannelTickets(channelId);
  if (ledger.length === 0) {
    throw new Error(`Channel ${channelId} has no tickets on its board`);
  }
  const relayStatusById = new Map(ledger.map((t) => [t.ticketId, t.status]));

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
  return { tickets: run.ticketPlan.tickets, relayStatusById };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { tickets, relayStatusById } = await loadRunForChannel(args.channel);

  if (!args.dryRun) {
    // Make sure the labels exist so `gh issue create --label` doesn't fail.
    ensureLabel(args.repo, "autonomous-loop", "5319e7", "Autonomous-loop rollout tickets");
    ensureLabel(args.repo, "relay-seeded", "fbca04", "Seeded from a Relay ticket board");
    ensureLabel(args.repo, "size/S", "c2e0c6", "Small");
    ensureLabel(args.repo, "size/M", "fef2c0", "Medium");
    ensureLabel(args.repo, "size/L", "f9d0c4", "Large");
  }

  const rows: Array<{ ticket: string; status: string; url: string; action: string }> = [];

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

    if (!args.dryRun) {
      const itemId = addItemToProject(args.projectId, issueUrl);
      setSingleSelectField(args.projectId, itemId, FIELDS.status.id, FIELDS.status.options[bucket]);
      setTextField(args.projectId, itemId, FIELDS.relayId, t.id);
      if (effort) {
        setSingleSelectField(
          args.projectId,
          itemId,
          FIELDS.effort.id,
          FIELDS.effort.options[effort]
        );
      }
      if (t.dependsOn.length > 0) {
        setTextField(args.projectId, itemId, FIELDS.dependsOn, t.dependsOn.join(", "));
      }
    }

    rows.push({ ticket: t.id, status: relayStatus, url: issueUrl, action });
  }

  console.log(JSON.stringify({ project: args.projectId, repo: args.repo, rows }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
