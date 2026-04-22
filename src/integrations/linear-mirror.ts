/**
 * Read-only mirror of a Linear project onto a channel's ticket board.
 *
 * Each Linear issue in the configured project becomes a `TicketLedgerEntry`
 * with `source: "linear"` and a stable id of `linear:<issue.id>`. The
 * orchestrator scheduler never touches these — it only picks up tickets it
 * itself placed on a run's ledger. Mirror tickets live on the channel
 * board for display only.
 *
 * The mirror talks to Linear directly via GraphQL using `LINEAR_API_KEY`.
 * We do not route through `@aoagents/ao-plugin-tracker-linear` because its
 * `listIssues` surface filters by team, not by project — the unit this
 * mirror is scoped to. Keep the query surface minimal and explicit here.
 */
import type { ChannelStore } from "../channels/channel-store.js";
import type { TicketLedgerEntry, TicketStatus } from "../domain/ticket.js";
import type { AgentSpecialty } from "../domain/specialty.js";

const LINEAR_API_URL = "https://api.linear.app/graphql";
const MIRROR_TICKET_PREFIX = "linear:";

export interface LinearIssueNode {
  id: string;
  identifier: string;
  title: string;
  url: string;
  state: { type: string; name: string };
  updatedAt: string;
}

export interface LinearProjectNode {
  id: string;
  name: string;
}

export interface LinearMirrorDeps {
  store: ChannelStore;
  apiKey: string;
  /**
   * Injectable fetch so tests can stub the network. Defaults to the global
   * `fetch`. The mirror only ever POSTs to `LINEAR_API_URL`.
   */
  fetch?: typeof fetch;
}

export interface LinearSyncResult {
  fetched: number;
  mirrored: TicketLedgerEntry[];
}

/** Raw GraphQL POST. Throws on network error, HTTP error, or `errors` array. */
async function linearGraphql<T>(
  query: string,
  variables: Record<string, unknown>,
  deps: Pick<LinearMirrorDeps, "apiKey" | "fetch">
): Promise<T> {
  const fetchImpl = deps.fetch ?? fetch;
  const res = await fetchImpl(LINEAR_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: deps.apiKey
    },
    body: JSON.stringify({ query, variables })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Linear API HTTP ${res.status}: ${body.slice(0, 200)}`
    );
  }
  const payload = (await res.json()) as {
    data?: T;
    errors?: Array<{ message: string }>;
  };
  if (payload.errors && payload.errors.length > 0) {
    throw new Error(`Linear API error: ${payload.errors[0].message}`);
  }
  if (!payload.data) {
    throw new Error("Linear API returned no data");
  }
  return payload.data;
}

/**
 * Confirm the given project exists and return its display name. Called by
 * `rly channel link-linear` before persisting `linearProjectId` on the
 * channel so we don't stamp a stale / malformed id onto a channel.
 *
 * Returns `null` when Linear reports no project with that id — lets the
 * CLI print a targeted error instead of a generic "API error".
 */
export async function fetchLinearProject(
  projectId: string,
  deps: Pick<LinearMirrorDeps, "apiKey" | "fetch">
): Promise<LinearProjectNode | null> {
  const data = await linearGraphql<{ project: LinearProjectNode | null }>(
    `query($id: String!) { project(id: $id) { id name } }`,
    { id: projectId },
    deps
  );
  return data.project ?? null;
}

/**
 * Fetch up to 100 issues belonging to the project. Linear paginates but
 * 100 is the API's hard per-page cap and covers the typical project. A
 * follow-up can add cursor-paging if projects routinely run larger.
 */
export async function fetchProjectIssues(
  projectId: string,
  deps: Pick<LinearMirrorDeps, "apiKey" | "fetch">
): Promise<LinearIssueNode[]> {
  const data = await linearGraphql<{ issues: { nodes: LinearIssueNode[] } }>(
    `query($projectId: ID!) {
      issues(filter: { project: { id: { eq: $projectId } } }, first: 100) {
        nodes {
          id
          identifier
          title
          url
          state { type name }
          updatedAt
        }
      }
    }`,
    { projectId },
    deps
  );
  return data.issues.nodes;
}

/**
 * Map a Linear state.type onto the nearest Relay ticket status. Preserves
 * meaningful kanban columns (open → ready, started → executing, completed
 * → completed, canceled → failed). Because mirror tickets carry
 * `source: "linear"`, dashboards can distinguish them from Relay-native
 * tickets if the mapping feels lossy.
 */
export function mapLinearStateToStatus(stateType: string): TicketStatus {
  switch (stateType) {
    case "started":
      return "executing";
    case "completed":
      return "completed";
    case "canceled":
      return "failed";
    case "triage":
    case "backlog":
    case "unstarted":
    default:
      return "ready";
  }
}

export function mirrorTicketId(issueId: string): string {
  return `${MIRROR_TICKET_PREFIX}${issueId}`;
}

export function toMirrorTicket(
  issue: LinearIssueNode,
  now: string
): TicketLedgerEntry {
  return {
    ticketId: mirrorTicketId(issue.id),
    title: `${issue.identifier} ${issue.title}`,
    specialty: "general" as AgentSpecialty,
    status: mapLinearStateToStatus(issue.state.type),
    dependsOn: [],
    assignedAgentId: null,
    assignedAgentName: null,
    crosslinkSessionId: null,
    verification: "pending",
    lastClassification: null,
    chosenNextAction: null,
    attempt: 0,
    startedAt: null,
    completedAt: issue.state.type === "completed" ? issue.updatedAt : null,
    updatedAt: now,
    runId: null,
    source: "linear",
    linearIssueId: issue.id,
    linearIdentifier: issue.identifier,
    linearState: issue.state.name,
    linearUrl: issue.url
  };
}

/**
 * One-shot sync: fetch issues for the channel's Linear project and upsert
 * them onto the channel board. Existing Relay-native tickets are left
 * untouched because `upsertChannelTickets` is additive per `ticketId`.
 */
export async function mirrorLinearProject(
  channelId: string,
  projectId: string,
  deps: LinearMirrorDeps
): Promise<LinearSyncResult> {
  const issues = await fetchProjectIssues(projectId, deps);
  const now = new Date().toISOString();
  const mirrors = issues.map((issue) => toMirrorTicket(issue, now));
  const merged = await deps.store.upsertChannelTickets(channelId, mirrors);
  return {
    fetched: issues.length,
    mirrored: merged.filter((t) => t.source === "linear")
  };
}
