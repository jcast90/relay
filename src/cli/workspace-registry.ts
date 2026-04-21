import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { buildHarnessStore, getHarnessStore } from "../storage/factory.js";
import { STORE_NS } from "../storage/namespaces.js";
import type { HarnessStore } from "../storage/store.js";
import { getRelayDir } from "./paths.js";

export interface WorkspaceRegistryEntry {
  workspaceId: string;
  repoPath: string;
  registeredAt: string;
  lastAccessedAt: string;
}

export interface WorkspaceRegistryDoc {
  updatedAt: string;
  workspaces: WorkspaceRegistryEntry[];
}

/**
 * Coordination record stored on the `HarnessStore` at
 * `(workspace, registry)`. Mirrors the top-level summary of the on-disk
 * `workspace-registry.json` that Rust and the Tauri GUI read directly. The
 * authoritative data still lives at `<relayDir>/workspace-registry.json` for
 * Rust compat (see `crates/harness-data/src/lib.rs::load_workspaces`); this
 * doc doubles as a cross-process mutation point so `store.mutate` can serve
 * as an advisory-lock-backed mutex once the store is Postgres (T-402).
 */
interface WorkspaceRegistryLockRecord {
  updatedAt: string;
  count: number;
}

// Monotonic suffix so concurrent writers in the same process never collide
// on the tmp file used by `writeRegistry`.
let registryTmpCounter = 0;

export function buildWorkspaceId(repoPath: string): string {
  const hash = createHash("sha256").update(repoPath).digest("hex").slice(0, 12);
  const basename = repoPath.split("/").filter(Boolean).pop() ?? "workspace";
  return `${basename}-${hash}`;
}

export function getGlobalRoot(): string {
  return getRelayDir();
}

export function getWorkspaceDir(workspaceId: string): string {
  return join(getRelayDir(), "workspaces", workspaceId);
}

/**
 * Wraps access to the workspace registry file at
 * `<relayDir>/workspace-registry.json`. The file layout is preserved for the
 * Rust crate `harness-data` and the Tauri GUI; the injected `HarnessStore`
 * is used to write a coordination record at `(workspace, registry)` on
 * every mutating operation so downstream multi-process coordination (T-402)
 * can hang off the same key without the registry owning that logic.
 *
 * Callers normally use the free-function re-exports (`registerWorkspace`,
 * `resolveWorkspaceForRepo`, `listRegisteredWorkspaces`, `readRegistry`,
 * `writeRegistry`) which default to `getHarnessStore()`. Construct a
 * `WorkspaceRegistry` directly only for tests that need to inject a
 * `FakeHarnessStore`.
 */
export class WorkspaceRegistry {
  private readonly relayDir: string;
  private readonly store: HarnessStore;

  /**
   * @param relayDir Root of the Relay state directory. Defaults to
   *   `getRelayDir()` so the file at `workspace-registry.json` lands where
   *   the Rust reader expects. Overriding this is only meaningful for tests.
   * @param store `HarnessStore` used for the `(workspace, registry)`
   *   coordination record. Defaults to `buildHarnessStore()` so callers that
   *   don't inject one pick up the process-wide singleton via the factory.
   */
  constructor(relayDir?: string, store?: HarnessStore) {
    this.relayDir = relayDir ?? getRelayDir();
    this.store = store ?? buildHarnessStore();
  }

  getRegistryPath(): string {
    return join(this.relayDir, "workspace-registry.json");
  }

  async read(): Promise<WorkspaceRegistryDoc> {
    try {
      const raw = JSON.parse(
        await readFile(this.getRegistryPath(), "utf8")
      ) as WorkspaceRegistryDoc;
      return {
        updatedAt: raw.updatedAt ?? new Date().toISOString(),
        workspaces: Array.isArray(raw.workspaces) ? raw.workspaces : []
      };
    } catch {
      return { updatedAt: new Date().toISOString(), workspaces: [] };
    }
  }

  async write(registry: WorkspaceRegistryDoc): Promise<void> {
    await mkdir(this.relayDir, { recursive: true });
    const path = this.getRegistryPath();
    const tmpPath = `${path}.tmp.${process.pid}.${registryTmpCounter++}`;
    await writeFile(tmpPath, JSON.stringify(registry, null, 2));
    await rename(tmpPath, path);

    // Persist the coordination record through the HarnessStore. On
    // FileHarnessStore this is a plain JSON file at
    // `<relayDir>/workspace/registry.json` — harmless to the Rust reader
    // (which only reads `workspace-registry.json`). On Postgres (T-402) this
    // executes under a transaction-scoped advisory lock keyed on the same
    // `(ns, id)`, giving us cross-process serialization for free.
    await this.store.mutate<WorkspaceRegistryLockRecord>(
      STORE_NS.workspace,
      "registry",
      () => ({
        updatedAt: registry.updatedAt,
        count: registry.workspaces.length
      })
    );
  }

  async register(repoPath: string): Promise<WorkspaceRegistryEntry> {
    const registry = await this.read();
    const workspaceId = buildWorkspaceId(repoPath);
    const now = new Date().toISOString();

    const existing = registry.workspaces.find(
      (w) => w.workspaceId === workspaceId
    );

    if (existing) {
      existing.lastAccessedAt = now;
      existing.repoPath = repoPath;
      registry.updatedAt = now;
      await this.write(registry);
      return existing;
    }

    const entry: WorkspaceRegistryEntry = {
      workspaceId,
      repoPath,
      registeredAt: now,
      lastAccessedAt: now
    };

    registry.workspaces.push(entry);
    registry.updatedAt = now;
    await this.write(registry);

    return entry;
  }

  async resolveForRepo(
    repoPath: string
  ): Promise<WorkspaceRegistryEntry | null> {
    const registry = await this.read();
    const workspaceId = buildWorkspaceId(repoPath);
    return (
      registry.workspaces.find((w) => w.workspaceId === workspaceId) ?? null
    );
  }

  async list(): Promise<WorkspaceRegistryEntry[]> {
    const registry = await this.read();
    return registry.workspaces;
  }
}

// --- Free-function API (preserved for back-compat with existing callers) ---
//
// These helpers all default to the process-wide `HarnessStore` singleton via
// `getHarnessStore()`. Tests that need a fake store should construct a
// `WorkspaceRegistry` directly and pass it.

export function getRegistryPath(): string {
  return new WorkspaceRegistry().getRegistryPath();
}

export async function readRegistry(): Promise<WorkspaceRegistryDoc> {
  return new WorkspaceRegistry(undefined, getHarnessStore()).read();
}

export async function writeRegistry(
  registry: WorkspaceRegistryDoc
): Promise<void> {
  return new WorkspaceRegistry(undefined, getHarnessStore()).write(registry);
}

export async function registerWorkspace(
  repoPath: string
): Promise<WorkspaceRegistryEntry> {
  return new WorkspaceRegistry(undefined, getHarnessStore()).register(repoPath);
}

export async function resolveWorkspaceForRepo(
  repoPath: string
): Promise<WorkspaceRegistryEntry | null> {
  return new WorkspaceRegistry(undefined, getHarnessStore()).resolveForRepo(
    repoPath
  );
}

export async function listRegisteredWorkspaces(): Promise<
  WorkspaceRegistryEntry[]
> {
  return new WorkspaceRegistry(undefined, getHarnessStore()).list();
}
