/**
 * One-shot reconciliation tick that projects Relay tickets onto a
 * channel's GitHub Projects v2 epic. Fourth slice of the v0.2 tracker
 * work (PR D / #183). Composes the GraphQL primitives from PR A (#188),
 * the draft-item + field surfaces from PR B (#189), and the channel
 * `trackerLinks` shape from PR C (#191).
 *
 * Direction is **one-way, Relay-authoritative**. Drift detected on the
 * GitHub side is logged to the channel feed as a `status_update`
 * warning and then **overwritten** with Relay's version on the same
 * tick. Teams that want editable external trackers can break the
 * projection via `rly channel unlink-tracker` (PR G, #186).
 *
 * What this module deliberately doesn't do (deferred to follow-ups):
 *   - The tick scheduler / interval timer. PR D ships a one-shot tick;
 *     the loop driver lands behind PR G's `tracker` config block.
 *   - Status-field reconciliation. Title drift is detected here; status
 *     drift requires per-project option-id resolution that the bulk
 *     of code lives outside this PR's budget. Tracking issue follow-up.
 *   - Bulk-import of an existing GH project's items into a fresh
 *     channel ticket list. Will land alongside the `rly channel
 *     link-github-project` CLI in a follow-up.
 *   - Bidirectional sync. Explicit non-goal per the design doc.
 */
import type { ChannelStore } from "../../channels/channel-store.js";
import type { ChannelGitHubProjectsLink } from "../../domain/channel.js";
import type { TicketLedgerEntry } from "../../domain/ticket.js";
import {
  githubProjectsGraphqlWithMeta,
  listProjectFields,
  type ProjectsClientDeps,
  type RateLimitInfo,
} from "./client.js";

/**
 * Default throttle threshold. When the remaining GraphQL budget drops
 * below this, the worker returns from the current tick with
 * `throttled: true` instead of starting fresh work. Tunable per-call
 * via `SyncTickInput.minRateLimitBudget`.
 */
const DEFAULT_MIN_RATE_LIMIT_BUDGET = 200;

export interface SyncTickInput {
  channelId: string;
  /**
   * Minimum remaining rate-limit budget required before the worker
   * starts new work on this tick. Defaults to 200 — leaves headroom
   * for ad-hoc CLI invocations during reconciliation. Set to 0 to
   * disable throttling (only sane in tests).
   */
  minRateLimitBudget?: number;
}

export interface DriftEvent {
  ticketId: string;
  externalItemId: string;
  kind: "title-changed";
  /** What GitHub had before we overwrote it. */
  observed: string;
  /** What Relay wrote back. */
  applied: string;
}

export interface SyncTickResult {
  /** Channel was missing trackerLinks.githubProjects — nothing to do. */
  skipped: boolean;
  /** True when the tick exited early because rate-limit budget dropped below the threshold. */
  throttled: boolean;
  /** Tickets that had no external projection and were created on this tick. */
  created: string[];
  /** Tickets that had drifted on the GitHub side — overwritten with Relay state. */
  drift: DriftEvent[];
  /**
   * Tickets whose stored GitHub-project item id no longer resolves
   * (item deleted out from under us). Their `externalIds` were
   * cleared on this tick so the next tick re-projects from scratch.
   */
  staleIdCleared: string[];
  /** Last rate-limit snapshot read during the tick. */
  rateLimit: RateLimitInfo;
}

export interface SyncWorkerDeps extends ProjectsClientDeps {
  store: ChannelStore;
}

interface FieldRefs {
  typeFieldId: string | null;
  ticketOptionId: string | null;
}

const EMPTY_RATE_LIMIT: RateLimitInfo = { remaining: null, resetEpochSeconds: null };

/**
 * One reconciliation pass for a single channel. Caller (eventually a
 * timer driver behind PR G config) invokes this every N seconds. The
 * function is safe to call repeatedly; idempotent on already-projected
 * tickets so a missed tick costs at most one extra round-trip per
 * ticket on the next run.
 */
export async function syncChannelTickets(
  input: SyncTickInput,
  deps: SyncWorkerDeps
): Promise<SyncTickResult> {
  const { store } = deps;
  const channel = await store.getChannel(input.channelId);
  if (!channel) {
    return emptyResult({ skipped: true });
  }
  const link = channel.trackerLinks?.githubProjects;
  if (!link) {
    return emptyResult({ skipped: true });
  }

  const minBudget = input.minRateLimitBudget ?? DEFAULT_MIN_RATE_LIMIT_BUDGET;
  const tickets = await store.readChannelTickets(input.channelId);
  const fieldRefs = await resolveTicketTypeRefs(link.projectId, deps);

  const created: string[] = [];
  const drift: DriftEvent[] = [];
  const staleIdCleared: string[] = [];
  let lastRateLimit: RateLimitInfo = EMPTY_RATE_LIMIT;

  for (const ticket of tickets) {
    if (lastRateLimit.remaining != null && lastRateLimit.remaining < minBudget) {
      return {
        skipped: false,
        throttled: true,
        created,
        drift,
        staleIdCleared,
        rateLimit: lastRateLimit,
      };
    }

    const projection = ticket.externalIds?.githubProjectItemId
      ? await reconcileExistingTicket(ticket, link, deps)
      : await projectNewTicket(ticket, link, fieldRefs, deps);

    if (projection.driftEvent) {
      drift.push(projection.driftEvent);
      await store.postEntry(input.channelId, {
        type: "status_update",
        fromAgentId: null,
        fromDisplayName: "tracker:github-projects",
        content: `Detected drift on ticket ${ticket.ticketId}: external title was ${JSON.stringify(
          projection.driftEvent.observed
        )}; overwritten with Relay's ${JSON.stringify(projection.driftEvent.applied)}.`,
        metadata: {
          tracker: "github-projects",
          ticketId: ticket.ticketId,
          externalItemId: projection.driftEvent.externalItemId,
          driftKind: projection.driftEvent.kind,
        },
      });
    }
    if (projection.staleIdCleared) {
      staleIdCleared.push(ticket.ticketId);
      const remaining = stripGithubExternalIds(ticket.externalIds);
      await store.upsertChannelTickets(input.channelId, [{ ...ticket, externalIds: remaining }]);
      await store.postEntry(input.channelId, {
        type: "status_update",
        fromAgentId: null,
        fromDisplayName: "tracker:github-projects",
        content: `External item for ticket ${ticket.ticketId} no longer resolves on GitHub; cleared stale ids so the next tick re-projects.`,
        metadata: {
          tracker: "github-projects",
          ticketId: ticket.ticketId,
          kind: "stale-id-cleared",
        },
      });
    }
    if (projection.created) {
      created.push(ticket.ticketId);
      await store.upsertChannelTickets(input.channelId, [
        {
          ...ticket,
          externalIds: {
            ...(ticket.externalIds ?? {}),
            githubProjectItemId: projection.itemId,
            githubDraftIssueId: projection.draftIssueId,
          },
        },
      ]);
    }
    lastRateLimit = projection.rateLimit;
  }

  return {
    skipped: false,
    throttled: false,
    created,
    drift,
    staleIdCleared,
    rateLimit: lastRateLimit,
  };
}

/**
 * Strip the GitHub-projects-specific keys from a ticket's
 * externalIds map, returning `undefined` if no other foreign-tracker
 * ids remain so the field doesn't get serialized as `{}`.
 */
function stripGithubExternalIds(
  externalIds: TicketLedgerEntry["externalIds"]
): TicketLedgerEntry["externalIds"] {
  if (!externalIds) return undefined;
  const { githubProjectItemId: _itemId, githubDraftIssueId: _draftId, ...rest } = externalIds;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

interface ProjectionResult {
  itemId: string;
  draftIssueId: string;
  created: boolean;
  /**
   * True when the stored external id no longer resolves (item was
   * deleted on the GitHub side). Caller clears the ticket's
   * `externalIds.github*` fields and posts a status_update warning so
   * the next tick re-projects.
   */
  staleIdCleared: boolean;
  driftEvent: DriftEvent | null;
  rateLimit: RateLimitInfo;
}

/**
 * Project a ticket that has no external id yet. Creates the draft
 * item, optionally stamps Type=ticket, returns the new ids and the
 * rate-limit snapshot from the last call so the worker can decide
 * whether to keep going or throttle on the next iteration.
 *
 * Inlined GraphQL (rather than calling into draft-items.ts) so we can
 * observe rate-limit headers on every step. The duplication is small
 * and keeps the sync worker the only place that knows about rate-limit
 * back-pressure — draft-items.ts stays a clean primitive.
 */
async function projectNewTicket(
  ticket: TicketLedgerEntry,
  link: ChannelGitHubProjectsLink,
  fieldRefs: FieldRefs,
  deps: SyncWorkerDeps
): Promise<ProjectionResult> {
  const createRes = await githubProjectsGraphqlWithMeta<{
    addProjectV2DraftIssue: {
      projectItem: { id: string; content: { id: string } | null };
    };
  }>(
    `mutation($projectId: ID!, $title: String!) {
      addProjectV2DraftIssue(input: { projectId: $projectId, title: $title }) {
        projectItem {
          id
          content { ... on DraftIssue { id } }
        }
      }
    }`,
    { projectId: link.projectId, title: ticket.title },
    deps
  );
  const projectItem = createRes.data.addProjectV2DraftIssue.projectItem;
  if (!projectItem.content) {
    throw new Error("addProjectV2DraftIssue returned a project item with no draft-issue content");
  }
  let lastRate = createRes.rateLimit;

  if (fieldRefs.typeFieldId && fieldRefs.ticketOptionId) {
    const setRes = await githubProjectsGraphqlWithMeta<{
      updateProjectV2ItemFieldValue: { projectV2Item: { id: string } };
    }>(
      `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
        updateProjectV2ItemFieldValue(input: {
          projectId: $projectId,
          itemId: $itemId,
          fieldId: $fieldId,
          value: { singleSelectOptionId: $optionId }
        }) {
          projectV2Item { id }
        }
      }`,
      {
        projectId: link.projectId,
        itemId: projectItem.id,
        fieldId: fieldRefs.typeFieldId,
        optionId: fieldRefs.ticketOptionId,
      },
      deps
    );
    lastRate = setRes.rateLimit;
  }

  return {
    itemId: projectItem.id,
    draftIssueId: projectItem.content.id,
    created: true,
    staleIdCleared: false,
    driftEvent: null,
    rateLimit: lastRate,
  };
}

/**
 * Reconcile a ticket that already has an external projection. Reads
 * the current draft-item title via GraphQL, compares to Relay state,
 * overwrites + reports drift if they diverge. v1 covers title only —
 * status field reconciliation is deferred (see module-level note).
 */
async function reconcileExistingTicket(
  ticket: TicketLedgerEntry,
  link: ChannelGitHubProjectsLink,
  deps: SyncWorkerDeps
): Promise<ProjectionResult> {
  const itemId = ticket.externalIds!.githubProjectItemId!;
  const { data, rateLimit } = await githubProjectsGraphqlWithMeta<{
    node: {
      content: { id: string; title: string } | null;
    } | null;
  }>(
    `query($itemId: ID!) {
      node(id: $itemId) {
        ... on ProjectV2Item {
          content {
            ... on DraftIssue { id title }
          }
        }
      }
    }`,
    { itemId },
    deps
  );

  const draft = data.node?.content;
  if (!draft) {
    // Item or its draft content was deleted on the GitHub side. Flag
    // the stored ids as stale; the caller clears them and posts a
    // status_update warning so the next tick re-projects from scratch.
    return {
      itemId: "",
      draftIssueId: "",
      created: false,
      staleIdCleared: true,
      driftEvent: null,
      rateLimit,
    };
  }

  const draftIssueId = draft.id;
  if (draft.title === ticket.title) {
    return {
      itemId,
      draftIssueId,
      created: false,
      staleIdCleared: false,
      driftEvent: null,
      rateLimit,
    };
  }

  // Title drifted — overwrite with Relay's value.
  const overwriteRes = await githubProjectsGraphqlWithMeta<{
    updateProjectV2DraftIssue: { draftIssue: { id: string } };
  }>(
    `mutation($draftIssueId: ID!, $title: String!) {
      updateProjectV2DraftIssue(input: { draftIssueId: $draftIssueId, title: $title }) {
        draftIssue { id }
      }
    }`,
    { draftIssueId, title: ticket.title },
    deps
  );

  return {
    itemId,
    draftIssueId,
    created: false,
    staleIdCleared: false,
    driftEvent: {
      ticketId: ticket.ticketId,
      externalItemId: itemId,
      kind: "title-changed",
      observed: draft.title,
      applied: ticket.title,
    },
    rateLimit: overwriteRes.rateLimit,
  };
}

async function resolveTicketTypeRefs(
  projectId: string,
  deps: ProjectsClientDeps
): Promise<FieldRefs> {
  const fields = await listProjectFields(projectId, deps);
  const typeField = fields.find((f) => f.name === "Type");
  const ticketOption = typeField?.options?.find((o) => o.name === "ticket");
  return {
    typeFieldId: typeField?.id ?? null,
    ticketOptionId: ticketOption?.id ?? null,
  };
}

function emptyResult(overrides: Partial<SyncTickResult>): SyncTickResult {
  return {
    skipped: false,
    throttled: false,
    created: [],
    drift: [],
    staleIdCleared: [],
    rateLimit: EMPTY_RATE_LIMIT,
    ...overrides,
  };
}
