/**
 * AL-16 Coordinator unit tests.
 *
 * Drives the bus with a fake pool (aliases → `{}` placeholders) and an
 * injected channel store, then asserts on the externally-observable
 * contract: validation, routing, block graph, audit mirror, waitFor,
 * and the end-to-end "A blocked on B, B announces ready" scenario.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ChannelStore } from "../../src/channels/channel-store.js";
import { Coordinator } from "../../src/crosslink/coordinator.js";
import type { CoordinationMessage, CoordinationMessageKind } from "../../src/crosslink/messages.js";

/**
 * Fake pool: the coordinator only consults `getSession` / `listSessions`
 * to check that an alias is registered, so a simple Map<alias, {}>
 * suffices. Returning a non-null object for known aliases is enough —
 * the coordinator never reaches into the session.
 */
function makeFakePool(aliases: string[]) {
  const sessions = new Map<string, { alias: string }>();
  for (const alias of aliases) sessions.set(alias, { alias });
  // Types match what Coordinator's `Pick<RepoAdminPool, ...>` needs.
  const pool = {
    getSession(alias: string) {
      return (
        (sessions.get(alias) as unknown as ReturnType<
          InstanceType<
            typeof import("../../src/orchestrator/repo-admin-pool.js").RepoAdminPool
          >["getSession"]
        >) ?? null
      );
    },
    listSessions() {
      return Array.from(sessions.values()) as unknown as ReturnType<
        InstanceType<
          typeof import("../../src/orchestrator/repo-admin-pool.js").RepoAdminPool
        >["listSessions"]
      >;
    },
  };
  return pool;
}

async function withCoordinator(
  aliases: string[],
  body: (ctx: {
    coordinator: Coordinator;
    channelId: string;
    channelStore: ChannelStore;
    dir: string;
  }) => Promise<void>
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "al-16-coord-"));
  const channelStore = new ChannelStore(dir);
  try {
    const channel = await channelStore.createChannel({
      name: "#al-16",
      description: "al-16 coordinator tests",
    });
    const coordinator = new Coordinator({
      pool: makeFakePool(aliases),
      channelStore,
      channelId: channel.channelId,
    });
    try {
      await body({ coordinator, channelId: channel.channelId, channelStore, dir });
    } finally {
      await coordinator.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function blockedOnRepo(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    kind: "blocked-on-repo",
    requester: "backend",
    blocker: "frontend",
    ticketId: "AL-X",
    dependsOnTicketId: "AL-Y",
    reason: "cross-repo handoff",
    requestedAt: "2026-04-21T12:00:00.000Z",
    ...overrides,
  };
}

function repoReady(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    kind: "repo-ready",
    alias: "frontend",
    ticketId: "AL-Y",
    prUrl: "https://github.com/o/r/pull/1",
    announcedAt: "2026-04-21T12:10:00.000Z",
    ...overrides,
  };
}

describe("Coordinator.send", () => {
  it("routes a valid repo-ready payload to a subscribed listener", async () => {
    await withCoordinator(["backend", "frontend"], async ({ coordinator }) => {
      const received: CoordinationMessage[] = [];
      const unsubscribe = coordinator.onMessage("backend", (msg) => {
        received.push(msg);
      });
      try {
        const result = await coordinator.send("frontend", "backend", repoReady());
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.kind).toBe("repo-ready");
          expect(result.from).toBe("frontend");
          expect(result.to).toBe("backend");
        }
        expect(received).toHaveLength(1);
        expect(received[0].kind).toBe("repo-ready");
      } finally {
        unsubscribe();
      }
    });
  });

  it("rejects a malformed payload with a structured error (AC4)", async () => {
    await withCoordinator(["backend", "frontend"], async ({ coordinator }) => {
      const result = await coordinator.send("frontend", "backend", {
        kind: "repo-ready",
        // missing alias, ticketId, prUrl, announcedAt
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("malformed");
        expect(result.detail.length).toBeGreaterThan(0);
      }
    });
  });

  it("rejects a send to an unknown admin alias", async () => {
    await withCoordinator(["backend"], async ({ coordinator }) => {
      const result = await coordinator.send("backend", "ghost", repoReady({ alias: "ghost" }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("no-such-admin");
      }
    });
  });

  it("rejects self-addressed sends", async () => {
    await withCoordinator(["backend"], async ({ coordinator }) => {
      const result = await coordinator.send("backend", "backend", repoReady({ alias: "backend" }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("self-addressed");
    });
  });

  it("rejects a blocked-on-repo whose requester doesn't match the from alias", async () => {
    await withCoordinator(["backend", "frontend"], async ({ coordinator }) => {
      // Backend is the actual sender, but requester claims "frontend".
      const result = await coordinator.send(
        "backend",
        "frontend",
        blockedOnRepo({ requester: "frontend" })
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("malformed");
    });
  });

  it("rejects a blocked-on-repo whose blocker doesn't match the to alias", async () => {
    await withCoordinator(["backend", "frontend"], async ({ coordinator }) => {
      const result = await coordinator.send(
        "backend",
        "frontend",
        blockedOnRepo({ blocker: "other" })
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("malformed");
    });
  });

  it("rejects a blocked-on-repo that would close a cycle (AC2 deadlock prevention)", async () => {
    await withCoordinator(["backend", "frontend"], async ({ coordinator }) => {
      // A (backend) blocks on B (frontend).
      const first = await coordinator.send(
        "backend",
        "frontend",
        blockedOnRepo({ requester: "backend", blocker: "frontend" })
      );
      expect(first.ok).toBe(true);

      // B (frontend) tries to block on A (backend) — closes the cycle.
      const second = await coordinator.send(
        "frontend",
        "backend",
        blockedOnRepo({
          requester: "frontend",
          blocker: "backend",
          ticketId: "AL-Z",
          dependsOnTicketId: "AL-W",
        })
      );
      expect(second.ok).toBe(false);
      if (!second.ok) expect(second.reason).toBe("would-form-cycle");

      // The cycle-rejected edge was NOT added to the graph.
      const openBlocks = coordinator.listOpenBlocks();
      expect(openBlocks).toHaveLength(1);
      expect(openBlocks[0].requester).toBe("backend");
    });
  });

  it("clears a block edge when repo-ready announces completion of the depended-on ticket", async () => {
    await withCoordinator(["backend", "frontend"], async ({ coordinator }) => {
      await coordinator.send("backend", "frontend", blockedOnRepo());
      expect(coordinator.listOpenBlocks()).toHaveLength(1);

      // Frontend announces ready for AL-Y — the dependsOnTicketId.
      const ready = await coordinator.send(
        "frontend",
        "backend",
        repoReady({ alias: "frontend", ticketId: "AL-Y" })
      );
      expect(ready.ok).toBe(true);
      expect(coordinator.listOpenBlocks()).toHaveLength(0);
    });
  });

  it("records a coordination_message decision on every successful send (audit trail)", async () => {
    await withCoordinator(
      ["backend", "frontend"],
      async ({ coordinator, channelId, channelStore }) => {
        await coordinator.send("frontend", "backend", repoReady());
        const decisions = await channelStore.listDecisions(channelId);
        const coord = decisions.filter((d) => d.type === "coordination_message");
        expect(coord).toHaveLength(1);
        expect(coord[0].metadata?.from).toBe("frontend");
        expect(coord[0].metadata?.to).toBe("backend");
        const payload = coord[0].metadata?.payload as { kind: CoordinationMessageKind };
        expect(payload.kind).toBe("repo-ready");
      }
    );
  });

  it("rejects sends after close()", async () => {
    await withCoordinator(["backend", "frontend"], async ({ coordinator }) => {
      await coordinator.close();
      const result = await coordinator.send("frontend", "backend", repoReady());
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("coordinator-closed");
    });
  });
});

describe("Coordinator.waitFor", () => {
  it("resolves when a matching message arrives", async () => {
    await withCoordinator(["backend", "frontend"], async ({ coordinator }) => {
      const waiter = coordinator.waitFor(
        "backend",
        (msg) => msg.kind === "repo-ready" && msg.ticketId === "AL-Y",
        { timeoutMs: 1_000, label: "test-ac3" }
      );
      // Await the send so the coordinator's audit write completes
      // before the enclosing `withCoordinator` unwinds the tmp dir —
      // otherwise the decisions-file write races the rm -rf.
      const send = coordinator.send("frontend", "backend", repoReady());
      const [msg, sendResult] = await Promise.all([waiter, send]);
      expect(msg.kind).toBe("repo-ready");
      expect(sendResult.ok).toBe(true);
    });
  });

  it("times out if no matching message arrives", async () => {
    await withCoordinator(["backend", "frontend"], async ({ coordinator }) => {
      await expect(
        coordinator.waitFor("backend", () => false, { timeoutMs: 15, label: "tiny" })
      ).rejects.toThrow(/wait-timeout/);
    });
  });

  it("models the AC3 end-to-end: A blocks on B, B completes, A unblocks without deadlock", async () => {
    await withCoordinator(["backend", "frontend"], async ({ coordinator }) => {
      // A (backend) tells B (frontend) it is blocked on AL-Y.
      const block = await coordinator.send(
        "backend",
        "frontend",
        blockedOnRepo({ requester: "backend", blocker: "frontend" })
      );
      expect(block.ok).toBe(true);

      // Backend waits for a repo-ready from frontend for AL-Y.
      const wait = coordinator.waitFor(
        "backend",
        (msg) => msg.kind === "repo-ready" && msg.alias === "frontend" && msg.ticketId === "AL-Y",
        { timeoutMs: 1_000, label: "ac3" }
      );

      // Frontend completes AL-Y and announces.
      const ready = await coordinator.send(
        "frontend",
        "backend",
        repoReady({ alias: "frontend", ticketId: "AL-Y" })
      );
      expect(ready.ok).toBe(true);

      const resolved = await wait;
      expect(resolved.kind).toBe("repo-ready");
      if (resolved.kind === "repo-ready") {
        expect(resolved.ticketId).toBe("AL-Y");
      }

      // Block graph is empty — the ready cleared it.
      expect(coordinator.listOpenBlocks()).toHaveLength(0);
    });
  });
});

describe("Coordinator.onMessage", () => {
  let cleanupFns: Array<() => Promise<void> | void> = [];

  beforeEach(() => {
    cleanupFns = [];
  });

  afterEach(async () => {
    for (const fn of cleanupFns) await fn();
  });

  it("multiple subscribers for the same alias all receive the message", async () => {
    await withCoordinator(["backend", "frontend"], async ({ coordinator }) => {
      const seenByA: CoordinationMessage[] = [];
      const seenByB: CoordinationMessage[] = [];
      const offA = coordinator.onMessage("backend", (m) => {
        seenByA.push(m);
      });
      const offB = coordinator.onMessage("backend", (m) => {
        seenByB.push(m);
      });
      try {
        await coordinator.send("frontend", "backend", repoReady());
        expect(seenByA).toHaveLength(1);
        expect(seenByB).toHaveLength(1);
      } finally {
        offA();
        offB();
      }
    });
  });

  it("a subscriber that throws does not wedge other subscribers", async () => {
    await withCoordinator(["backend", "frontend"], async ({ coordinator }) => {
      const seen: CoordinationMessage[] = [];
      coordinator.onMessage("backend", () => {
        throw new Error("boom");
      });
      coordinator.onMessage("backend", (m) => {
        seen.push(m);
      });
      await coordinator.send("frontend", "backend", repoReady());
      expect(seen).toHaveLength(1);
    });
  });
});
