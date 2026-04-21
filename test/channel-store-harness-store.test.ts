import {
  cp,
  mkdtemp,
  readFile,
  rm,
  stat
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ChannelStore } from "../src/channels/channel-store.js";
import { FileHarnessStore } from "../src/storage/file-store.js";
import { STORE_NS } from "../src/storage/namespaces.js";
import type {
  BlobRef,
  ChangeEvent,
  HarnessStore,
  ReadLogOptions
} from "../src/storage/store.js";

/**
 * Minimal in-memory HarnessStore. Good enough to verify ChannelStore calls
 * through to the injected store on migrated operations. Only the methods
 * ChannelStore actually exercises are implemented with real semantics; the
 * rest throw to surface accidental usage during tests.
 */
class FakeHarnessStore implements HarnessStore {
  readonly docs: Map<string, unknown> = new Map();
  readonly mutateCalls: Array<{ ns: string; id: string }> = [];

  private key(ns: string, id: string): string {
    return `${ns}\u0000${id}`;
  }

  async getDoc<T>(ns: string, id: string): Promise<T | null> {
    const v = this.docs.get(this.key(ns, id));
    return (v as T | undefined) ?? null;
  }

  readonly putCalls: Array<{ ns: string; id: string }> = [];

  async putDoc<T>(ns: string, id: string, doc: T): Promise<void> {
    this.putCalls.push({ ns, id });
    this.docs.set(this.key(ns, id), doc);
  }

  async listDocs<T>(): Promise<T[]> {
    throw new Error("FakeHarnessStore.listDocs is not implemented");
  }

  async deleteDoc(): Promise<void> {
    throw new Error("FakeHarnessStore.deleteDoc is not implemented");
  }

  async appendLog(): Promise<void> {
    throw new Error("FakeHarnessStore.appendLog is not implemented");
  }

  async readLog<T>(
    _ns: string,
    _id: string,
    _opts?: ReadLogOptions
  ): Promise<T[]> {
    throw new Error("FakeHarnessStore.readLog is not implemented");
  }

  async putBlob(): Promise<BlobRef> {
    throw new Error("FakeHarnessStore.putBlob is not implemented");
  }

  async getBlob(): Promise<Uint8Array> {
    throw new Error("FakeHarnessStore.getBlob is not implemented");
  }

  async mutate<T>(
    ns: string,
    id: string,
    fn: (prev: T | null) => T
  ): Promise<T> {
    this.mutateCalls.push({ ns, id });
    const prev = (this.docs.get(this.key(ns, id)) as T | undefined) ?? null;
    const next = fn(prev);
    this.docs.set(this.key(ns, id), next);
    return next;
  }

  // eslint-disable-next-line require-yield
  async *watch(): AsyncIterable<ChangeEvent> {
    throw new Error("FakeHarnessStore.watch is not implemented");
  }
}

describe("ChannelStore with HarnessStore injection", () => {
  let channelsDir: string;
  let fake: FakeHarnessStore;
  let store: ChannelStore;

  beforeEach(async () => {
    channelsDir = await mkdtemp(join(tmpdir(), "ch-hs-"));
    fake = new FakeHarnessStore();
    store = new ChannelStore(channelsDir, fake);
  });

  afterEach(async () => {
    await rm(channelsDir, { recursive: true, force: true });
  });

  it("routes ticket-board coordination through HarnessStore.mutate", async () => {
    const channel = await store.createChannel({
      name: "#coord",
      description: "coord-test"
    });

    await store.upsertChannelTickets(channel.channelId, [
      {
        ticketId: "t-1",
        title: "first",
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
        updatedAt: "2025-01-01T00:00:00.000Z",
        runId: null
      }
    ]);

    // The upsert must have written a coordination record through the store.
    expect(fake.mutateCalls).toContainEqual({
      ns: STORE_NS.channelTickets,
      id: channel.channelId
    });

    const rec = await fake.getDoc<{ updatedAt: string; count: number }>(
      STORE_NS.channelTickets,
      channel.channelId
    );
    expect(rec).not.toBeNull();
    expect(rec!.count).toBe(1);
    expect(typeof rec!.updatedAt).toBe("string");
  });

  it("keeps the Rust-compat tickets.json layout on disk", async () => {
    const channel = await store.createChannel({
      name: "#layout",
      description: "layout-test"
    });

    await store.upsertChannelTickets(channel.channelId, [
      {
        ticketId: "t-rust",
        title: "rust-compat check",
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
        updatedAt: "2025-01-01T00:00:00.000Z",
        runId: null
      }
    ]);

    // Tickets still live at `channels/<id>/tickets.json` — not under the
    // HarnessStore's `channel-tickets/<id>.json` layout. Rust's
    // `load_channel_tickets` depends on this.
    const onDiskPath = join(channelsDir, channel.channelId, "tickets.json");
    const raw = JSON.parse(await readFile(onDiskPath, "utf8")) as {
      tickets: Array<{ ticketId: string }>;
    };
    expect(raw.tickets.map((t) => t.ticketId)).toEqual(["t-rust"]);
  });

  it("channel doc stays at channelsDir/<id>.json (Rust-compat)", async () => {
    const channel = await store.createChannel({
      name: "#rust-doc",
      description: "rust-doc-test"
    });

    const docPath = join(channelsDir, `${channel.channelId}.json`);
    await expect(stat(docPath)).resolves.toBeTruthy();

    // The HarnessStore's `channel` namespace must NOT have picked up a
    // mirror — migrating that would break Rust's `load_channels`.
    const mirrored = await fake.getDoc(STORE_NS.channel, channel.channelId);
    expect(mirrored).toBeNull();
  });

  it("defaults to a real FileHarnessStore when no store is injected", async () => {
    // No store arg → ctor builds one via `buildHarnessStore()`. This shouldn't
    // throw even though HARNESS_STORE may default to "file" with a default
    // rootDir — the store is constructed lazily but its ctor is safe.
    const defaulted = new ChannelStore(channelsDir);
    const channel = await defaulted.createChannel({
      name: "#default",
      description: "default-ctor"
    });
    expect(channel.channelId).toMatch(/^channel-/);
  });

  it("mirrors recorded decisions through HarnessStore.putDoc", async () => {
    const channel = await store.createChannel({
      name: "#decisions",
      description: "decision-mirror-test"
    });

    const decision = await store.recordDecision(channel.channelId, {
      runId: null,
      ticketId: null,
      title: "Adopt zustand",
      description: "Replace context-based state with zustand.",
      rationale: "Smaller re-renders, simpler API.",
      alternatives: ["redux", "context-only"],
      decidedBy: "planner-claude",
      decidedByName: "Claude (Planner)",
      linkedArtifacts: []
    });

    // Primary source of truth still lives at channels/<id>/decisions/<did>.json
    // — Rust's `load_channel_decisions` depends on that path.
    const onDiskPath = join(
      channelsDir,
      channel.channelId,
      "decisions",
      `${decision.decisionId}.json`
    );
    const onDisk = JSON.parse(await readFile(onDiskPath, "utf8")) as {
      decisionId: string;
    };
    expect(onDisk.decisionId).toBe(decision.decisionId);

    // And a coordination mirror is published under STORE_NS.decision at
    // `<channelId>:<decisionId>` so store-watchers can observe new
    // decisions without tailing the filesystem.
    const storeId = `${channel.channelId}:${decision.decisionId}`;
    expect(fake.putCalls).toContainEqual({
      ns: STORE_NS.decision,
      id: storeId
    });
    const mirrored = await fake.getDoc<{ decisionId: string; title: string }>(
      STORE_NS.decision,
      storeId
    );
    expect(mirrored).not.toBeNull();
    expect(mirrored!.title).toBe("Adopt zustand");
  });

  it("swallows HarnessStore mirror failures when recording a decision", async () => {
    // Decisions are durably persisted to disk before the mirror runs. A
    // mirror outage must never surface as a recordDecision failure, or
    // the Rust/GUI readers would be out of sync with callers who retry.
    const flaky: HarnessStore = {
      getDoc: async () => null,
      putDoc: async () => {
        throw new Error("simulated mirror outage");
      },
      listDocs: async () => {
        throw new Error("not implemented");
      },
      deleteDoc: async () => {
        throw new Error("not implemented");
      },
      appendLog: async () => {
        throw new Error("not implemented");
      },
      readLog: async () => {
        throw new Error("not implemented");
      },
      putBlob: async () => {
        throw new Error("not implemented");
      },
      getBlob: async () => {
        throw new Error("not implemented");
      },
      mutate: async <T>(
        _ns: string,
        _id: string,
        fn: (prev: T | null) => T
      ): Promise<T> => fn(null),
      watch: async function* () {
        throw new Error("not implemented");
      }
    };
    const flakyStore = new ChannelStore(channelsDir, flaky);
    const channel = await flakyStore.createChannel({
      name: "#flaky",
      description: "flaky-mirror"
    });

    const decision = await flakyStore.recordDecision(channel.channelId, {
      runId: null,
      ticketId: null,
      title: "Stay resilient",
      description: "Keep disk primary.",
      rationale: "Mirror is advisory.",
      alternatives: [],
      decidedBy: "planner-claude",
      decidedByName: "Claude (Planner)",
      linkedArtifacts: []
    });

    // Disk copy still landed.
    const onDiskPath = join(
      channelsDir,
      channel.channelId,
      "decisions",
      `${decision.decisionId}.json`
    );
    await expect(stat(onDiskPath)).resolves.toBeTruthy();
  });

  it("serializes concurrent upsertChannelTickets on the same channel", async () => {
    const channel = await store.createChannel({
      name: "#race",
      description: "race-test"
    });

    const makeTicket = (ticketId: string) => ({
      ticketId,
      title: ticketId,
      specialty: "general" as const,
      status: "ready" as const,
      dependsOn: [],
      assignedAgentId: null,
      assignedAgentName: null,
      crosslinkSessionId: null,
      verification: "pending" as const,
      lastClassification: null,
      chosenNextAction: null,
      attempt: 0,
      startedAt: null,
      completedAt: null,
      updatedAt: "2025-01-01T00:00:00.000Z",
      runId: null
    });

    // Fire 4 concurrent upserts with distinct ticketIds. The in-process
    // mutex must serialize them so every ticket lands in the final board.
    await Promise.all([
      store.upsertChannelTickets(channel.channelId, [makeTicket("t-1")]),
      store.upsertChannelTickets(channel.channelId, [makeTicket("t-2")]),
      store.upsertChannelTickets(channel.channelId, [makeTicket("t-3")]),
      store.upsertChannelTickets(channel.channelId, [makeTicket("t-4")])
    ]);

    const final = await store.readChannelTickets(channel.channelId);
    const ids = final.map((t) => t.ticketId).sort();
    expect(ids).toEqual(["t-1", "t-2", "t-3", "t-4"]);
  });
});

describe("ChannelStore reads legacy Rust-layout fixtures", () => {
  let workDir: string;

  beforeEach(async () => {
    // Copy the hand-written legacy fixture into a scratch dir so the test is
    // hermetic and can create additional subdirectories without touching the
    // source tree.
    workDir = await mkdtemp(join(tmpdir(), "ch-legacy-"));
    const src = fileURLToPath(
      new URL("./fixtures/legacy-channel", import.meta.url)
    );
    await cp(src, workDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("reads a pre-migration channel doc, feed, tickets, runs, and decisions", async () => {
    // Use a real FileHarnessStore rooted outside the channels dir — the
    // fixture test shouldn't depend on the user's home directory.
    const storeRoot = await mkdtemp(join(tmpdir(), "ch-legacy-store-"));
    try {
      const store = new ChannelStore(
        workDir,
        new FileHarnessStore(storeRoot)
      );

      const channel = await store.getChannel("channel-abc");
      expect(channel).not.toBeNull();
      expect(channel!.name).toBe("#legacy-feature");
      expect(channel!.status).toBe("active");
      expect(channel!.members).toHaveLength(1);

      const feed = await store.readFeed("channel-abc");
      expect(feed).toHaveLength(2);
      expect(feed[0].entryId).toBe("entry-001");
      expect(feed[1].type).toBe("status_update");
      expect(feed[1].metadata).toEqual({ runId: "run-legacy-1" });

      const tickets = await store.readChannelTickets("channel-abc");
      expect(tickets.map((t) => t.ticketId)).toEqual([
        "ticket-legacy-1",
        "ticket-legacy-2"
      ]);
      expect(tickets[0].status).toBe("executing");

      const runs = await store.readRunLinks("channel-abc");
      expect(runs).toHaveLength(1);
      expect(runs[0].runId).toBe("run-legacy-1");

      const decisions = await store.listDecisions("channel-abc");
      expect(decisions).toHaveLength(1);
      expect(decisions[0].decisionId).toBe("decision-legacy-1");
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
    }
  });
});

/**
 * Decision-only parity fixture. `legacy-channel/` and `legacy-crosslink/`
 * each covered their respective domains end-to-end; the review flagged
 * that decisions had no dedicated fixture proving that pre-T-104
 * on-disk files still round-trip through `ChannelStore`. This block
 * covers that gap: copy the fixture into a scratch dir, bind a fresh
 * ChannelStore with an isolated HarnessStore (so no coordination docs
 * leak into the user's relay), and assert both `getDecision` and
 * `listDecisions` read the JSON payloads untouched.
 */
describe("ChannelStore reads legacy decisions fixture", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "ch-dec-legacy-"));
    const src = fileURLToPath(
      new URL("./fixtures/legacy-channel-decisions", import.meta.url)
    );
    await cp(src, workDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("reads pre-migration decisions through listDecisions and getDecision", async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), "ch-dec-legacy-store-"));
    try {
      const channelsDir = join(workDir, "channels");
      const store = new ChannelStore(
        channelsDir,
        new FileHarnessStore(storeRoot)
      );

      const decisions = await store.listDecisions("channel-decisions-legacy");
      // Sorted descending by createdAt in `listDecisions`, so the newer beta
      // comes first.
      expect(decisions.map((d) => d.decisionId)).toEqual([
        "decision-legacy-beta",
        "decision-legacy-alpha"
      ]);
      expect(decisions[0].title).toBe("JWT for v1 session tokens");
      expect(decisions[0].linkedArtifacts).toHaveLength(1);
      expect(decisions[1].alternatives).toContain("Redis SETNX");

      const alpha = await store.getDecision(
        "channel-decisions-legacy",
        "decision-legacy-alpha"
      );
      expect(alpha).not.toBeNull();
      expect(alpha!.decidedBy).toBe("planner-claude");
      expect(alpha!.runId).toBe("run-legacy-alpha");

      const beta = await store.getDecision(
        "channel-decisions-legacy",
        "decision-legacy-beta"
      );
      expect(beta).not.toBeNull();
      expect(beta!.ticketId).toBe("ticket-legacy-auth");
      expect(beta!.runId).toBeNull();
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
    }
  });
});
