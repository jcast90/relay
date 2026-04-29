import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { ChannelStore } from "../../src/channels/channel-store.js";
import { syncChannelTickets } from "../../src/integrations/github-projects/sync-worker.js";
import type { TicketLedgerEntry } from "../../src/domain/ticket.js";
import { FileHarnessStore } from "../../src/storage/file-store.js";

/**
 * Sync-worker tests run a real ChannelStore in a tmp dir against a
 * stubbed `fetch`. The combination is intentional — we want to prove
 * that ticket externalIds are persisted on disk and that drift
 * warnings make it into `feed.jsonl`, not just that the GraphQL
 * sequence is right.
 */

interface StubResponse {
  body: unknown;
  headers?: Record<string, string>;
}

interface CapturedRequest {
  body: { query: string; variables: Record<string, unknown> };
}

function stubFetch(responses: Array<StubResponse>): {
  fetchImpl: typeof fetch;
  calls: CapturedRequest[];
} {
  const calls: CapturedRequest[] = [];
  let i = 0;
  const fetchImpl = vi.fn(async (_url: unknown, init: RequestInit = {}) => {
    const body = JSON.parse(String(init.body ?? "{}"));
    calls.push({ body });
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return new Response(JSON.stringify(r.body), {
      status: 200,
      headers: { "content-type": "application/json", ...(r.headers ?? {}) },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

async function withStore<T>(fn: (store: ChannelStore, dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "gh-sync-"));
  try {
    // Same convention as test/integrations/linear-mirror.test.ts — `dir` is
    // both the channels root and the harness-store root.
    const store = new ChannelStore(dir, new FileHarnessStore(dir));
    return await fn(store, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function makeTicket(
  over: Partial<TicketLedgerEntry> & Pick<TicketLedgerEntry, "ticketId" | "title">
): TicketLedgerEntry {
  return {
    specialty: "general",
    status: "ready",
    dependsOn: [],
    assignedAgentId: null,
    assignedAgentName: null,
    crosslinkSessionId: null,
    verification: "pending",
    lastClassification: null,
    chosenNextAction: null,
    attempt: 0,
    startedAt: null,
    completedAt: null,
    updatedAt: "2026-04-28T00:00:00.000Z",
    runId: null,
    ...over,
  };
}

const TYPE_FIELD = {
  id: "F_type",
  name: "Type",
  options: [
    { id: "OPT_epic", name: "epic" },
    { id: "OPT_ticket", name: "ticket" },
  ],
};

function listFieldsResponse(headers?: Record<string, string>): StubResponse {
  return {
    body: { data: { node: { fields: { nodes: [TYPE_FIELD] } } } },
    headers,
  };
}

function addDraftResponse(
  itemId: string,
  draftId: string,
  headers?: Record<string, string>
): StubResponse {
  return {
    body: {
      data: {
        addProjectV2DraftIssue: {
          projectItem: { id: itemId, content: { id: draftId } },
        },
      },
    },
    headers,
  };
}

function setFieldResponse(itemId: string, headers?: Record<string, string>): StubResponse {
  return {
    body: { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: itemId } } } },
    headers,
  };
}

function fetchItemResponse(
  draftId: string,
  title: string,
  headers?: Record<string, string>
): StubResponse {
  return {
    body: { data: { node: { content: { id: draftId, title } } } },
    headers,
  };
}

function updateDraftResponse(draftId: string, headers?: Record<string, string>): StubResponse {
  return {
    body: { data: { updateProjectV2DraftIssue: { draftIssue: { id: draftId } } } },
    headers,
  };
}

const TRACKER_LINK = {
  projectId: "PVT_p1",
  projectNumber: 1,
  projectUrl: "https://example.test/p/1",
  epicItemId: "PVTI_epic",
  epicDraftIssueId: "DI_epic",
};

describe("github-projects/sync-worker", () => {
  it("skips when the channel has no GH projection", async () => {
    await withStore(async (store) => {
      const ch = await store.createChannel({ name: "no-projection", description: "" });
      const { fetchImpl, calls } = stubFetch([]);
      const result = await syncChannelTickets(
        { channelId: ch.channelId, minRateLimitBudget: 0 },
        { token: "ghp", fetch: fetchImpl, store }
      );
      expect(result.skipped).toBe(true);
      expect(calls).toHaveLength(0);
    });
  });

  it("projects unlinked tickets and persists externalIds back to the ticket file", async () => {
    await withStore(async (store) => {
      const ch = await store.createChannel({ name: "ch", description: "" });
      await store.updateChannel(ch.channelId, {
        trackerLinks: { githubProjects: TRACKER_LINK },
      });

      await store.upsertChannelTickets(ch.channelId, [
        makeTicket({ ticketId: "T-1", title: "First ticket" }),
        makeTicket({ ticketId: "T-2", title: "Second ticket" }),
      ]);

      const { fetchImpl } = stubFetch([
        listFieldsResponse(), // resolveTicketTypeRefs
        addDraftResponse("PVTI_t1", "DI_t1"), // T-1 create
        setFieldResponse("PVTI_t1"), // T-1 stamp Type=ticket
        addDraftResponse("PVTI_t2", "DI_t2"), // T-2 create
        setFieldResponse("PVTI_t2"), // T-2 stamp Type=ticket
      ]);

      const result = await syncChannelTickets(
        { channelId: ch.channelId, minRateLimitBudget: 0 },
        { token: "ghp", fetch: fetchImpl, store }
      );

      expect(result.skipped).toBe(false);
      expect(result.created).toEqual(["T-1", "T-2"]);
      expect(result.drift).toEqual([]);
      expect(result.staleIdCleared).toEqual([]);

      const tickets = await store.readChannelTickets(ch.channelId);
      const t1 = tickets.find((t) => t.ticketId === "T-1");
      expect(t1?.externalIds).toEqual({
        githubProjectItemId: "PVTI_t1",
        githubDraftIssueId: "DI_t1",
      });
    });
  });

  it("detects title drift, posts a feed warning, and overwrites with Relay's value", async () => {
    await withStore(async (store, dir) => {
      const ch = await store.createChannel({ name: "drift", description: "" });
      await store.updateChannel(ch.channelId, {
        trackerLinks: { githubProjects: TRACKER_LINK },
      });

      await store.upsertChannelTickets(ch.channelId, [
        makeTicket({
          ticketId: "T-1",
          title: "Relay's authoritative title",
          externalIds: {
            githubProjectItemId: "PVTI_t1",
            githubDraftIssueId: "DI_t1",
          },
        }),
      ]);

      const { fetchImpl, calls } = stubFetch([
        listFieldsResponse(),
        // Existing external item — title diverges from Relay's.
        fetchItemResponse("DI_t1", "Edited title on GitHub"),
        // Overwrite mutation.
        updateDraftResponse("DI_t1"),
      ]);

      const result = await syncChannelTickets(
        { channelId: ch.channelId, minRateLimitBudget: 0 },
        { token: "ghp", fetch: fetchImpl, store }
      );

      expect(result.created).toEqual([]);
      expect(result.drift).toHaveLength(1);
      expect(result.drift[0]).toMatchObject({
        ticketId: "T-1",
        externalItemId: "PVTI_t1",
        kind: "title-changed",
        observed: "Edited title on GitHub",
        applied: "Relay's authoritative title",
      });

      // The third call MUST be the overwrite mutation against the right
      // draft id with Relay's title — otherwise a regression that wrote
      // back the observed title (or the wrong id) would still pass the
      // drift-event assertion above.
      expect(calls[2].body.query).toMatch(/updateProjectV2DraftIssue/);
      expect(calls[2].body.variables).toMatchObject({
        draftIssueId: "DI_t1",
        title: "Relay's authoritative title",
      });

      // Drift warning must land on the channel feed.
      const feed = await readFile(join(dir, ch.channelId, "feed.jsonl"), "utf8");
      expect(feed).toMatch(/Detected drift on ticket T-1/);
      expect(feed).toMatch(/status_update/);
    });
  });

  it("returns throttled=true and stops new work when rate-limit drops below threshold", async () => {
    await withStore(async (store) => {
      const ch = await store.createChannel({ name: "throttle", description: "" });
      await store.updateChannel(ch.channelId, {
        trackerLinks: { githubProjects: TRACKER_LINK },
      });

      await store.upsertChannelTickets(ch.channelId, [
        makeTicket({ ticketId: "T-1", title: "First" }),
        makeTicket({ ticketId: "T-2", title: "Second" }),
      ]);

      const lowBudget = { "x-ratelimit-remaining": "5", "x-ratelimit-reset": "1700000000" };
      const { fetchImpl, calls } = stubFetch([
        listFieldsResponse(),
        addDraftResponse("PVTI_t1", "DI_t1", lowBudget),
        setFieldResponse("PVTI_t1", lowBudget),
        // T-2 should never run — sync should bail after observing low budget on T-1.
      ]);

      const result = await syncChannelTickets(
        { channelId: ch.channelId, minRateLimitBudget: 100 },
        { token: "ghp", fetch: fetchImpl, store }
      );

      expect(result.throttled).toBe(true);
      expect(result.created).toEqual(["T-1"]);
      expect(result.rateLimit.remaining).toBe(5);
      // 3 calls used for T-1 (list-fields, create, set-field). T-2 work never starts.
      expect(calls).toHaveLength(3);
    });
  });

  it("clears a stale external id when the GH item was deleted out from under us", async () => {
    await withStore(async (store, dir) => {
      const ch = await store.createChannel({ name: "deleted", description: "" });
      await store.updateChannel(ch.channelId, {
        trackerLinks: { githubProjects: TRACKER_LINK },
      });

      await store.upsertChannelTickets(ch.channelId, [
        makeTicket({
          ticketId: "T-1",
          title: "Lonely",
          externalIds: { githubProjectItemId: "PVTI_gone", githubDraftIssueId: "DI_gone" },
        }),
      ]);

      const { fetchImpl } = stubFetch([
        listFieldsResponse(),
        // GitHub returns null for the deleted node.
        { body: { data: { node: null } } },
      ]);

      const result = await syncChannelTickets(
        { channelId: ch.channelId, minRateLimitBudget: 0 },
        { token: "ghp", fetch: fetchImpl, store }
      );
      // Not counted as created (no fresh projection); not counted as drift.
      expect(result.created).toEqual([]);
      expect(result.drift).toEqual([]);
      expect(result.skipped).toBe(false);
      // Stale id MUST be reported and the ticket's externalIds cleared
      // on disk so the next tick re-projects from scratch.
      expect(result.staleIdCleared).toEqual(["T-1"]);

      const tickets = await store.readChannelTickets(ch.channelId);
      const t1 = tickets.find((t) => t.ticketId === "T-1");
      // Whole field stripped because no other tracker ids remained.
      expect(t1?.externalIds).toBeUndefined();

      // Warning posted to the channel feed.
      const feed = await readFile(join(dir, ch.channelId, "feed.jsonl"), "utf8");
      expect(feed).toMatch(/no longer resolves on GitHub/);
      expect(feed).toMatch(/stale-id-cleared/);
    });
  });
});
