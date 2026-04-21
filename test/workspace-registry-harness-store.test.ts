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

import {
  WorkspaceRegistry,
  buildWorkspaceId
} from "../src/cli/workspace-registry.js";
import { FileHarnessStore } from "../src/storage/file-store.js";
import { STORE_NS } from "../src/storage/namespaces.js";
import type {
  BlobRef,
  ChangeEvent,
  HarnessStore,
  ReadLogOptions
} from "../src/storage/store.js";

/**
 * Minimal in-memory HarnessStore. Only the methods WorkspaceRegistry
 * actually exercises are implemented with real semantics; the rest throw
 * to surface accidental usage during tests.
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

describe("WorkspaceRegistry with HarnessStore injection", () => {
  let relayDir: string;
  let fake: FakeHarnessStore;
  let registry: WorkspaceRegistry;

  beforeEach(async () => {
    relayDir = await mkdtemp(join(tmpdir(), "ws-reg-hs-"));
    fake = new FakeHarnessStore();
    registry = new WorkspaceRegistry(relayDir, fake);
  });

  afterEach(async () => {
    await rm(relayDir, { recursive: true, force: true });
  });

  it("routes registry writes through HarnessStore.mutate", async () => {
    const repoPath = join(relayDir, "fake-repo");
    const entry = await registry.register(repoPath);

    expect(entry.workspaceId).toBe(buildWorkspaceId(repoPath));
    expect(entry.repoPath).toBe(repoPath);

    expect(fake.mutateCalls).toContainEqual({
      ns: STORE_NS.workspace,
      id: "registry"
    });

    const rec = await fake.getDoc<{ updatedAt: string; count: number }>(
      STORE_NS.workspace,
      "registry"
    );
    expect(rec).not.toBeNull();
    expect(rec!.count).toBe(1);
    expect(typeof rec!.updatedAt).toBe("string");
  });

  it("keeps the Rust-compat workspace-registry.json layout on disk", async () => {
    const repoPath = join(relayDir, "fake-repo-2");
    await registry.register(repoPath);

    // Authoritative data still at `<relayDir>/workspace-registry.json` —
    // Rust's `load_workspaces` depends on this.
    const onDiskPath = join(relayDir, "workspace-registry.json");
    const raw = JSON.parse(await readFile(onDiskPath, "utf8")) as {
      workspaces: Array<{ repoPath: string }>;
    };
    expect(raw.workspaces.map((w) => w.repoPath)).toEqual([repoPath]);
  });

  it("register, resolve, and list round-trip through the on-disk file", async () => {
    const pathA = join(relayDir, "repo-a");
    const pathB = join(relayDir, "repo-b");

    const a = await registry.register(pathA);
    const b = await registry.register(pathB);

    const resolvedA = await registry.resolveForRepo(pathA);
    expect(resolvedA).not.toBeNull();
    expect(resolvedA!.workspaceId).toBe(a.workspaceId);

    const all = await registry.list();
    expect(all.map((w) => w.workspaceId).sort()).toEqual(
      [a.workspaceId, b.workspaceId].sort()
    );

    // Unregistered path returns null
    const missing = await registry.resolveForRepo(
      join(relayDir, "does-not-exist")
    );
    expect(missing).toBeNull();
  });

  it("re-registering updates lastAccessedAt and the coordination record", async () => {
    const repoPath = join(relayDir, "repo-c");
    const first = await registry.register(repoPath);

    // Ensure ISO second ticks forward so the comparison is meaningful.
    await new Promise((r) => setTimeout(r, 5));

    const second = await registry.register(repoPath);
    expect(second.workspaceId).toBe(first.workspaceId);
    expect(second.lastAccessedAt >= first.lastAccessedAt).toBe(true);

    // Two writes → two `mutate` calls on `(workspace, registry)`.
    const calls = fake.mutateCalls.filter(
      (c) => c.ns === STORE_NS.workspace && c.id === "registry"
    );
    expect(calls.length).toBe(2);
  });

  it("defaults to a real FileHarnessStore when no store is injected", async () => {
    const defaulted = new WorkspaceRegistry(relayDir);
    const doc = await defaulted.read();
    expect(doc.workspaces).toEqual([]);
  });
});

describe("WorkspaceRegistry reads legacy Rust-layout fixtures", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "ws-reg-legacy-"));
    const fixtureSrc = fileURLToPath(
      new URL("./fixtures/legacy-workspace-registry", import.meta.url)
    );
    // The fixture dir ships with a `workspace-registry.json` at its root —
    // mirrors the on-disk layout a pre-migration Relay user would have.
    await cp(fixtureSrc, workDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("reads a pre-migration registry file from its Rust-compat path", async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), "ws-reg-legacy-store-"));
    try {
      const registry = new WorkspaceRegistry(
        workDir,
        new FileHarnessStore(storeRoot)
      );

      const doc = await registry.read();
      expect(doc.workspaces).toHaveLength(2);
      expect(doc.workspaces.map((w) => w.workspaceId)).toEqual([
        "ws-legacy-1",
        "ws-legacy-2"
      ]);
      expect(doc.workspaces[0].repoPath).toBe("/home/user/projects/legacy-a");

      // The pre-migration fixture uses hand-picked workspaceIds that don't
      // match `buildWorkspaceId(repoPath)`, so `resolveForRepo` (which hashes
      // the path to look up) legitimately returns null — that's the current
      // contract, and the list above proves the data round-tripped.
      const resolved = await registry.resolveForRepo(
        "/home/user/projects/legacy-a"
      );
      expect(resolved).toBeNull();

      // Coordination record is untouched by reads — only writes bump it.
      await expect(
        stat(join(storeRoot, "workspace", "registry.json"))
      ).rejects.toThrow();
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
    }
  });
});

