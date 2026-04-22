import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { ChannelStore } from "../../src/channels/channel-store.js";
import {
  fetchLinearProject,
  mapLinearStateToStatus,
  mirrorLinearProject,
  mirrorTicketId,
  toMirrorTicket,
  type LinearIssueNode
} from "../../src/integrations/linear-mirror.js";
import { FileHarnessStore } from "../../src/storage/file-store.js";

/**
 * Tests for the read-only Linear → channel-board mirror.
 *
 * Network is stubbed via an injected `fetch`. Each test sets up a real
 * `ChannelStore` in a tmp dir so the upsert-merge path is exercised end to
 * end against the on-disk shape Rust consumers expect.
 */

function stubFetch(responses: Array<unknown>): typeof fetch {
  let i = 0;
  return vi.fn(async () => {
    const body = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as unknown as typeof fetch;
}

function issue(
  overrides: Partial<LinearIssueNode> & Pick<LinearIssueNode, "id" | "identifier">
): LinearIssueNode {
  return {
    title: "Sample issue",
    url: `https://linear.app/acme/issue/${overrides.identifier}`,
    state: { type: "unstarted", name: "Todo" },
    updatedAt: "2026-04-21T00:00:00.000Z",
    ...overrides
  };
}

async function withStore<T>(fn: (store: ChannelStore, dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "linear-mirror-"));
  try {
    const store = new ChannelStore(dir, new FileHarnessStore(dir));
    return await fn(store, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("linear-mirror", () => {
  it("maps Linear state.type onto Relay ticket statuses", () => {
    expect(mapLinearStateToStatus("started")).toBe("executing");
    expect(mapLinearStateToStatus("completed")).toBe("completed");
    expect(mapLinearStateToStatus("canceled")).toBe("failed");
    expect(mapLinearStateToStatus("backlog")).toBe("ready");
    expect(mapLinearStateToStatus("triage")).toBe("ready");
    // Unknown types fall through to "ready" so a new Linear state doesn't
    // orphan mirror tickets into an invalid status enum.
    expect(mapLinearStateToStatus("future-state")).toBe("ready");
  });

  it("builds a mirror ticket with source=linear and namespaced id", () => {
    const t = toMirrorTicket(
      issue({
        id: "issue-uuid-1",
        identifier: "ENG-42",
        title: "Rate-limit search",
        state: { type: "started", name: "In Progress" }
      }),
      "2026-04-21T10:00:00.000Z"
    );
    expect(t.ticketId).toBe(mirrorTicketId("issue-uuid-1"));
    expect(t.source).toBe("linear");
    expect(t.status).toBe("executing");
    expect(t.linearIdentifier).toBe("ENG-42");
    expect(t.linearState).toBe("In Progress");
    expect(t.title).toBe("ENG-42 Rate-limit search");
    expect(t.dependsOn).toEqual([]);
    expect(t.runId).toBeNull();
  });

  it("stamps completedAt only when the Linear issue is completed", () => {
    const open = toMirrorTicket(
      issue({ id: "a", identifier: "ENG-1" }),
      "2026-04-21T00:00:00.000Z"
    );
    expect(open.completedAt).toBeNull();

    const done = toMirrorTicket(
      issue({
        id: "b",
        identifier: "ENG-2",
        state: { type: "completed", name: "Done" },
        updatedAt: "2026-04-20T00:00:00.000Z"
      }),
      "2026-04-21T00:00:00.000Z"
    );
    expect(done.completedAt).toBe("2026-04-20T00:00:00.000Z");
  });

  it("fetchLinearProject returns null when Linear reports no such project", async () => {
    const fetchImpl = stubFetch([{ data: { project: null } }]);
    const out = await fetchLinearProject("missing", {
      apiKey: "lin_api_x",
      fetch: fetchImpl
    });
    expect(out).toBeNull();
  });

  it("surfaces Linear GraphQL errors so the CLI can stop before writing", async () => {
    const fetchImpl = stubFetch([
      { errors: [{ message: "Invalid project id" }] }
    ]);
    await expect(
      fetchLinearProject("bad", { apiKey: "k", fetch: fetchImpl })
    ).rejects.toThrow(/Invalid project id/);
  });

  it("mirrors issues onto the channel board and preserves existing Relay tickets", async () => {
    await withStore(async (store) => {
      const channel = await store.createChannel({
        name: "mirror-test",
        description: "test"
      });

      // Seed a Relay-authored ticket so we can prove the mirror is additive.
      await store.upsertChannelTickets(channel.channelId, [
        {
          ticketId: "T-1",
          title: "relay ticket",
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
          updatedAt: "2026-04-21T00:00:00.000Z",
          runId: null
        }
      ]);

      const fetchImpl = stubFetch([
        {
          data: {
            issues: {
              nodes: [
                issue({ id: "li-1", identifier: "ENG-1" }),
                issue({
                  id: "li-2",
                  identifier: "ENG-2",
                  state: { type: "started", name: "In Progress" }
                })
              ]
            }
          }
        }
      ]);

      const result = await mirrorLinearProject(
        channel.channelId,
        "proj-uuid",
        { store, apiKey: "lin_api_x", fetch: fetchImpl }
      );

      expect(result.fetched).toBe(2);
      expect(result.mirrored).toHaveLength(2);

      const board = await store.readChannelTickets(channel.channelId);
      const ids = board.map((t) => t.ticketId);
      // Relay ticket survives alongside the two mirrors.
      expect(ids).toContain("T-1");
      expect(ids).toContain(mirrorTicketId("li-1"));
      expect(ids).toContain(mirrorTicketId("li-2"));

      const relay = board.find((t) => t.ticketId === "T-1");
      expect(relay?.source).toBeUndefined();

      const mirrors = board.filter((t) => t.source === "linear");
      expect(mirrors).toHaveLength(2);
    });
  });

  it("re-syncing overwrites mirror rows with fresh state from Linear", async () => {
    await withStore(async (store) => {
      const channel = await store.createChannel({
        name: "resync",
        description: "test"
      });

      const firstFetch = stubFetch([
        {
          data: {
            issues: {
              nodes: [
                issue({
                  id: "li-1",
                  identifier: "ENG-7",
                  state: { type: "unstarted", name: "Todo" }
                })
              ]
            }
          }
        }
      ]);
      await mirrorLinearProject(channel.channelId, "proj", {
        store,
        apiKey: "k",
        fetch: firstFetch
      });

      const secondFetch = stubFetch([
        {
          data: {
            issues: {
              nodes: [
                issue({
                  id: "li-1",
                  identifier: "ENG-7",
                  state: { type: "completed", name: "Done" },
                  updatedAt: "2026-04-22T00:00:00.000Z"
                })
              ]
            }
          }
        }
      ]);
      await mirrorLinearProject(channel.channelId, "proj", {
        store,
        apiKey: "k",
        fetch: secondFetch
      });

      const board = await store.readChannelTickets(channel.channelId);
      const row = board.find((t) => t.ticketId === mirrorTicketId("li-1"));
      expect(row?.status).toBe("completed");
      expect(row?.linearState).toBe("Done");
      expect(row?.completedAt).toBe("2026-04-22T00:00:00.000Z");
    });
  });

  it("raises on non-2xx HTTP so callers never silently drop data", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("rate limited", {
          status: 429,
          headers: { "content-type": "text/plain" }
        })
    ) as unknown as typeof fetch;

    await withStore(async (store) => {
      const channel = await store.createChannel({
        name: "err",
        description: "test"
      });
      await expect(
        mirrorLinearProject(channel.channelId, "proj", {
          store,
          apiKey: "k",
          fetch: fetchImpl
        })
      ).rejects.toThrow(/HTTP 429/);
    });
  });
});
