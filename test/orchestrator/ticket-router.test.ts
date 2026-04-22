/**
 * AL-13 — TicketRouter unit tests.
 *
 * Covers the resolve→dispatch flow + the unroutable surface that the ticket
 * spec requires (AC box 3: "Routing failures surface as a ticket status
 * update, not a silent drop"). Uses the AL-12 `FakeSpawner` shape so pool
 * + session lifecycles run without a real `claude` binary.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SpawnedProcess } from "../../src/agents/command-invoker.js";
import { ChannelStore } from "../../src/channels/channel-store.js";
import type { Channel } from "../../src/domain/channel.js";
import type { TicketLedgerEntry } from "../../src/domain/ticket.js";
import { SessionLifecycle } from "../../src/lifecycle/session-lifecycle.js";
import {
  RepoAdminPool,
  type RepoAdminPoolOptions,
} from "../../src/orchestrator/repo-admin-pool.js";
import type {
  RepoAdminProcessSpawner,
  RepoAdminSpawnArgs,
} from "../../src/orchestrator/repo-admin-session.js";
import { TicketRouter } from "../../src/orchestrator/ticket-router.js";
import { FileHarnessStore } from "../../src/storage/file-store.js";

type StdListener = (chunk: string) => void;
type ExitListener = (code: number | null, signal: NodeJS.Signals | null) => void;
type ErrorListener = (err: Error) => void;

interface FakeChild extends SpawnedProcess {
  readonly killCalls: Array<NodeJS.Signals | undefined>;
  emitExit(code: number | null, signal?: NodeJS.Signals | null): void;
  spawnArgs: RepoAdminSpawnArgs;
}

function makeFakeChild(args: RepoAdminSpawnArgs): FakeChild {
  const stdoutListeners: StdListener[] = [];
  const stderrListeners: StdListener[] = [];
  const exitListeners: ExitListener[] = [];
  const errorListeners: ErrorListener[] = [];
  const killCalls: Array<NodeJS.Signals | undefined> = [];

  return {
    pid: 20_000 + Math.floor(Math.random() * 1000),
    spawnArgs: args,
    killCalls,
    onStdout(l) {
      stdoutListeners.push(l);
    },
    onStderr(l) {
      stderrListeners.push(l);
    },
    onExit(l) {
      exitListeners.push(l);
    },
    onError(l) {
      errorListeners.push(l);
    },
    kill(signal) {
      killCalls.push(signal);
      return true;
    },
    emitExit(code, signal = null) {
      for (const l of exitListeners) l(code, signal);
    },
  };
}

class FakeSpawner implements RepoAdminProcessSpawner {
  readonly byAlias = new Map<string, FakeChild[]>();
  spawn(args: RepoAdminSpawnArgs): SpawnedProcess {
    const child = makeFakeChild(args);
    const list = this.byAlias.get(args.alias) ?? [];
    list.push(child);
    this.byAlias.set(args.alias, list);
    return child;
  }
  children(alias: string): FakeChild[] {
    return this.byAlias.get(alias) ?? [];
  }
}

function buildChannel(overrides: Partial<Channel> & { channelId: string }): Channel {
  return {
    channelId: overrides.channelId,
    name: overrides.name ?? "router-test",
    description: overrides.description ?? "router-test",
    status: "active",
    workspaceIds: overrides.workspaceIds ?? [],
    members: overrides.members ?? [],
    pinnedRefs: overrides.pinnedRefs ?? [],
    repoAssignments: overrides.repoAssignments ?? [],
    primaryWorkspaceId: overrides.primaryWorkspaceId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function buildTicket(ticketId: string, assignedAlias: string | undefined): TicketLedgerEntry {
  return {
    ticketId,
    title: `ticket ${ticketId}`,
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
    updatedAt: new Date().toISOString(),
    runId: null,
    ...(assignedAlias !== undefined ? { assignedAlias } : {}),
  };
}

/**
 * Build a pool + channel + router + ChannelStore in one go. Callers pass
 * the aliases on the channel and (optionally) the subset the pool is
 * allowed to boot for — mirroring the `allowedAliases` filter from AL-3 so
 * we can exercise the "no-admin-for-alias" path.
 */
async function buildRouterHarness(opts: { aliases: string[]; allowedAliases?: string[] }) {
  const root = await mkdtemp(join(tmpdir(), "router-test-"));
  const channelsDir = join(root, "channels");
  const lifecycleDir = join(root, "lifecycle");
  const harnessStore = new FileHarnessStore(join(root, "__hs__"));
  const channelStore = new ChannelStore(channelsDir, harnessStore);
  const repoAssignments = opts.aliases.map((a) => ({
    alias: a,
    workspaceId: `ws-${a}`,
    repoPath: `/tmp/fake-${a}-repo`,
  }));
  // Persist the channel through the store so `postEntry` / the ticket
  // board have a canonical directory to write into. The store mints its
  // own `channelId`; we adopt it into our in-memory copy below.
  const persisted = await channelStore.createChannel({
    name: "router-test",
    description: "router-test",
    workspaceIds: opts.aliases.map((a) => `ws-${a}`),
    repoAssignments,
  });
  const channel = buildChannel({
    channelId: persisted.channelId,
    workspaceIds: persisted.workspaceIds,
    repoAssignments,
  });

  const lifecycle = new SessionLifecycle(`sess-${Date.now()}`, {
    rootDir: lifecycleDir,
  });
  const spawner = new FakeSpawner();

  const poolOpts: RepoAdminPoolOptions = {
    channel,
    lifecycle,
    spawner,
    allowedAliases: opts.allowedAliases,
    rootDir: root,
    sessionStopGraceMs: 5,
    buildSessionId: () => `admin-${Math.random().toString(36).slice(2, 8)}`,
  };
  const pool = new RepoAdminPool(poolOpts);
  await pool.start();

  const router = new TicketRouter({
    pool,
    channel,
    channelStore,
    now: () => "2026-04-21T00:00:00.000Z",
  });

  const cleanup = async () => {
    const done = pool.stop();
    for (const alias of opts.allowedAliases ?? opts.aliases) {
      const kids = spawner.children(alias);
      for (const k of kids) k.emitExit(0, "SIGTERM");
    }
    await done;
    await rm(root, { recursive: true, force: true });
  };

  return { pool, router, channel, channelStore, spawner, lifecycle, cleanup };
}

describe("TicketRouter", () => {
  // Hold one harness per test so cleanup can happen even on assertion fail.
  let cleanup: (() => Promise<void>) | null = null;

  beforeEach(() => {
    cleanup = null;
  });
  afterEach(async () => {
    if (cleanup) {
      try {
        await cleanup();
      } catch {
        // Don't let teardown noise mask the real assertion failure.
      }
    }
  });

  it("routes a ticket with assignedAlias to the matching admin", async () => {
    const harness = await buildRouterHarness({ aliases: ["backend", "frontend"] });
    cleanup = harness.cleanup;

    const ticket = buildTicket("t-backend", "backend");
    const result = await harness.router.route(ticket);

    expect(result).toEqual({ kind: "routed", alias: "backend" });

    const backendSession = harness.pool.getSession("backend")!;
    const frontendSession = harness.pool.getSession("frontend")!;
    expect(backendSession.pendingTickets().map((t) => t.ticketId)).toEqual(["t-backend"]);
    expect(frontendSession.pendingTickets()).toHaveLength(0);
  });

  it("routes a ticket to each admin when both aliases are assigned", async () => {
    const harness = await buildRouterHarness({ aliases: ["backend", "frontend"] });
    cleanup = harness.cleanup;

    await harness.router.route(buildTicket("t-back", "backend"));
    await harness.router.route(buildTicket("t-front", "frontend"));

    expect(
      harness.pool
        .getSession("backend")!
        .pendingTickets()
        .map((t) => t.ticketId)
    ).toEqual(["t-back"]);
    expect(
      harness.pool
        .getSession("frontend")!
        .pendingTickets()
        .map((t) => t.ticketId)
    ).toEqual(["t-front"]);
  });

  it("falls back to the channel's primary when assignedAlias is unset (single-repo back-compat)", async () => {
    const harness = await buildRouterHarness({ aliases: ["primary-only"] });
    cleanup = harness.cleanup;

    const ticket = buildTicket("t-no-alias", undefined);
    const result = await harness.router.route(ticket);

    expect(result).toEqual({ kind: "routed", alias: "primary-only" });
    expect(
      harness.pool
        .getSession("primary-only")!
        .pendingTickets()
        .map((t) => t.ticketId)
    ).toEqual(["t-no-alias"]);
  });

  it("marks a ticket with an unknown assignedAlias blocked + posts a status update", async () => {
    const harness = await buildRouterHarness({ aliases: ["backend", "frontend"] });
    cleanup = harness.cleanup;

    const ticket = buildTicket("t-typo", "typo");
    const result = await harness.router.route(ticket);

    expect(result.kind).toBe("unroutable");
    if (result.kind === "unroutable") {
      expect(result.reason).toBe("unknown-alias:typo");
      expect(result.attemptedAlias).toBe("typo");
    }

    // Ticket mutated in place.
    expect(ticket.status).toBe("blocked");
    expect(ticket.lastClassification?.category).toBe("routing_error");
    expect(ticket.lastClassification?.rationale).toMatch(/typo/);
    expect(ticket.lastClassification?.nextAction).toMatch(/assignedAlias/);

    // No admin's queue picked it up.
    expect(harness.pool.getSession("backend")!.pendingTickets()).toHaveLength(0);
    expect(harness.pool.getSession("frontend")!.pendingTickets()).toHaveLength(0);

    // Channel board reflects the block.
    const board = await harness.channelStore.readChannelTickets(harness.channel.channelId);
    const mirrored = board.find((t) => t.ticketId === "t-typo");
    expect(mirrored?.status).toBe("blocked");
    expect(mirrored?.lastClassification?.category).toBe("routing_error");

    // Channel feed carries an operator-readable note.
    const feed = await harness.channelStore.readFeed(harness.channel.channelId);
    const note = feed.find((e) => e.type === "status_update" && e.metadata?.ticketId === "t-typo");
    expect(note).toBeDefined();
    expect(note?.metadata.routingReason).toBe("unknown-alias:typo");
  });

  it("marks the ticket unroutable when no admin is booted for the alias (--allow-repo filter)", async () => {
    const harness = await buildRouterHarness({
      aliases: ["backend", "frontend"],
      allowedAliases: ["backend"],
    });
    cleanup = harness.cleanup;

    const ticket = buildTicket("t-filtered", "frontend");
    const result = await harness.router.route(ticket);

    expect(result.kind).toBe("unroutable");
    if (result.kind === "unroutable") {
      expect(result.reason).toBe("no-admin-for-alias:frontend");
      expect(result.attemptedAlias).toBe("frontend");
    }
    expect(ticket.status).toBe("blocked");
    expect(ticket.lastClassification?.category).toBe("routing_error");

    // Backend admin's queue is still empty.
    expect(harness.pool.getSession("backend")!.pendingTickets()).toHaveLength(0);
    // No session exists for frontend.
    expect(harness.pool.getSession("frontend")).toBeNull();
  });

  it("does not spawn workers while routing — scope discipline for AL-13", async () => {
    // Each `dispatchTicket` call must not touch the process spawner (AL-14
    // will own worker spawning). The FakeSpawner above counts every spawn
    // via `children(alias).length`; after start() the pool has exactly one
    // per alias, and routing tickets must not bump that count.
    const harness = await buildRouterHarness({ aliases: ["backend"] });
    cleanup = harness.cleanup;

    const before = harness.spawner.children("backend").length;
    await harness.router.route(buildTicket("t-1", "backend"));
    await harness.router.route(buildTicket("t-2", "backend"));
    const after = harness.spawner.children("backend").length;
    expect(after).toBe(before);
    expect(harness.pool.getSession("backend")!.pendingTickets()).toHaveLength(2);
  });
});
