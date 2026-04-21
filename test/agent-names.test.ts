import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getAgentName,
  listAgentNames,
  setAgentName,
  type AgentNameEntry
} from "../src/domain/agent-names.js";
import { STORE_NS } from "../src/storage/namespaces.js";
import type {
  BlobRef,
  ChangeEvent,
  HarnessStore,
  ReadLogOptions
} from "../src/storage/store.js";

/**
 * Minimal in-memory HarnessStore. Same shape as the one used in the T-101
 * channel-store-harness-store test — only the methods agent-names actually
 * calls (`mutate`) are implemented with real semantics; the rest throw so
 * accidental usage surfaces in tests.
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

  async putDoc<T>(ns: string, id: string, doc: T): Promise<void> {
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

describe("agent names", () => {
  let relayDir: string;

  beforeEach(async () => {
    relayDir = await mkdtemp(join(tmpdir(), "agent-names-"));
  });

  afterEach(async () => {
    await rm(relayDir, { recursive: true, force: true });
  });

  it("sets and retrieves agent display names", async () => {
    await setAgentName("test-agent-1", "Test Agent One", "claude", "planner", {
      relayDir
    });

    const name = await getAgentName("test-agent-1", { relayDir });
    expect(name).toBe("Test Agent One");

    // Falls back to agentId for unknown agents
    const unknown = await getAgentName("nonexistent-agent", { relayDir });
    expect(unknown).toBe("nonexistent-agent");

    const entries = await listAgentNames({ relayDir });
    expect(entries.some((e) => e.agentId === "test-agent-1")).toBe(true);

    // Overwrite
    await setAgentName("test-agent-1", "Updated Name", "claude", "reviewer", {
      relayDir
    });
    const updated = await getAgentName("test-agent-1", { relayDir });
    expect(updated).toBe("Updated Name");
  });

  it("keeps agent-names.json as the Rust-visible source of truth", async () => {
    // Rust's `load_agent_names` reads `<relayDir>/agent-names.json` directly.
    // After a set, the on-disk file must contain the full registry as a flat
    // JSON array — never an object wrapper, never under a sub-path.
    await setAgentName("planner-1", "Planner One", "claude", "planner", {
      relayDir
    });
    await setAgentName(
      "implementer-1",
      "Implementer One",
      "codex",
      "implementer",
      { relayDir }
    );

    const onDisk = JSON.parse(
      await readFile(join(relayDir, "agent-names.json"), "utf8")
    ) as AgentNameEntry[];
    expect(Array.isArray(onDisk)).toBe(true);
    expect(onDisk.map((e) => e.agentId).sort()).toEqual([
      "implementer-1",
      "planner-1"
    ]);
  });

  it("mirrors the registry through the injected HarnessStore", async () => {
    const fake = new FakeHarnessStore();

    await setAgentName("planner-1", "Planner One", "claude", "planner", {
      relayDir,
      store: fake
    });
    await setAgentName(
      "implementer-1",
      "Implementer One",
      "codex",
      "implementer",
      { relayDir, store: fake }
    );

    // Coordination record is stored under STORE_NS.agentName via mutate so
    // Postgres-backed stores can layer advisory-lock coordination later.
    const calls = fake.mutateCalls.filter(
      (c) => c.ns === STORE_NS.agentName && c.id === "registry"
    );
    expect(calls).toHaveLength(2);

    const mirrored = await fake.getDoc<AgentNameEntry[]>(
      STORE_NS.agentName,
      "registry"
    );
    expect(mirrored).not.toBeNull();
    expect(mirrored!.map((e) => e.agentId).sort()).toEqual([
      "implementer-1",
      "planner-1"
    ]);
  });

  it("does not fail setAgentName when the HarnessStore mirror throws", async () => {
    // Mirror failures must never shadow a successful primary disk write.
    // The on-disk `agent-names.json` is what Rust/GUI observe; losing the
    // coordination-record mirror is recoverable on the next write.
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
      mutate: async () => {
        throw new Error("simulated mirror outage");
      },
      watch: async function* () {
        throw new Error("not implemented");
      }
    };

    await expect(
      setAgentName("resilient-agent", "Resilient", "claude", "planner", {
        relayDir,
        store: flaky
      })
    ).resolves.toMatchObject({ agentId: "resilient-agent" });

    // Primary disk write still committed.
    const name = await getAgentName("resilient-agent", { relayDir });
    expect(name).toBe("Resilient");
  });
});

describe("agent names reads legacy pre-migration fixture", () => {
  let workDir: string;

  beforeEach(async () => {
    // Copy the fixture file into a hermetic workDir that doubles as the
    // relayDir. `listAgentNames` reads `<relayDir>/agent-names.json`, so the
    // fixture has to live under that exact name at the dir root.
    workDir = await mkdtemp(join(tmpdir(), "agent-names-legacy-"));
    const src = fileURLToPath(
      new URL("./fixtures/legacy-agent-names.json", import.meta.url)
    );
    await cp(src, join(workDir, "agent-names.json"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("reads pre-migration agent-names.json via the new API", async () => {
    const entries = await listAgentNames({ relayDir: workDir });
    expect(entries.map((e) => e.agentId).sort()).toEqual([
      "implementer-codex",
      "planner-claude"
    ]);

    const name = await getAgentName("planner-claude", { relayDir: workDir });
    expect(name).toBe("Claude (Planner)");
  });
});
