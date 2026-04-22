import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { getRelayDir } from "../cli/paths.js";
import { buildHarnessStore, getHarnessStore } from "../storage/factory.js";
import { STORE_NS } from "../storage/namespaces.js";
import type { HarnessStore } from "../storage/store.js";
import type { AgentProvider, AgentRole } from "./agent.js";

export interface AgentNameEntry {
  agentId: string;
  displayName: string;
  provider: AgentProvider;
  role: AgentRole;
  updatedAt: string;
}

/**
 * The Rust crate `harness-data` (`load_agent_names` at
 * `crates/harness-data/src/lib.rs`) reads `<relayDir>/agent-names.json`
 * directly and expects a top-level JSON array of `AgentNameEntry`. The Tauri
 * GUI piggybacks on that. Migrating this file fully to
 * `HarnessStore.putDoc(agentName, registry, ...)` would silently hide
 * registered names from the desktop app, so this module retains the on-disk
 * `agent-names.json` as the primary source of truth and mirrors the registry
 * through the store as a coordination record for Postgres-backed deployments
 * (T-402). Same pattern as T-101's `upsertChannelTickets` coordination doc.
 */
const namesPath = (dir?: string): string => join(dir ?? getRelayDir(), "agent-names.json");

/**
 * Doc id for the `STORE_NS.agentName` coordination record. The registry is
 * a single document keyed by a stable sentinel; individual agents aren't
 * split into separate docs because the Rust reader expects one aggregated
 * file and that shape is what downstream coordination consumers want too.
 */
const REGISTRY_DOC_ID = "registry";

/**
 * Test/integration override for the relay directory. The CLI injects this
 * via the `relayDir` argument. Kept as an optional parameter rather than
 * a module-level setter to avoid the ambient-state pitfalls T-102 called
 * out for workspace-registry — every caller is explicit about where it's
 * reading from.
 */
interface AgentNameIO {
  relayDir?: string;
  store?: HarnessStore;
}

function resolveStore(io: AgentNameIO | undefined): HarnessStore {
  if (io?.store) return io.store;
  if (io?.relayDir) {
    // Tests commonly pass `relayDir` without a store. Build a store scoped
    // to that dir so the coordination mirror doesn't escape into ~/.relay.
    return buildHarnessStore({ fileRoot: io.relayDir });
  }
  return getHarnessStore();
}

export async function setAgentName(
  agentId: string,
  displayName: string,
  provider: AgentProvider,
  role: AgentRole,
  io?: AgentNameIO
): Promise<AgentNameEntry> {
  const entries = await listAgentNames(io);
  const now = new Date().toISOString();
  const entry: AgentNameEntry = { agentId, displayName, provider, role, updatedAt: now };
  const index = entries.findIndex((e) => e.agentId === agentId);

  if (index >= 0) {
    entries[index] = entry;
  } else {
    entries.push(entry);
  }

  const path = namesPath(io?.relayDir);
  const tmpPath = `${path}.tmp.${process.pid}`;
  await writeFile(tmpPath, JSON.stringify(entries, null, 2));
  await rename(tmpPath, path);

  // Mirror the full registry through the HarnessStore as a coordination
  // record. Purely advisory today (nothing reads it); consumers on the
  // Postgres backend can layer `store.watch(agentName, registry)` to get
  // cross-process notifications when names change. The direct-file write
  // above is the source of truth — if the mirror fails, we've already
  // persisted the data Rust/GUI care about.
  try {
    const store = resolveStore(io);
    await store.mutate<AgentNameEntry[]>(STORE_NS.agentName, REGISTRY_DOC_ID, () => entries);
  } catch (err) {
    // Never let a mirror failure shadow a successful primary write. The
    // Rust-visible file is already on disk; a future caller's `setAgentName`
    // will re-mirror the full registry so transient failures self-heal.
    // Surface the failure at warn-level so operators aren't left guessing
    // why the Postgres-backed coordination doc is stale.
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[agent-names] coordination mirror failed for registry: ${msg}`);
  }

  return entry;
}

export async function getAgentName(agentId: string, io?: AgentNameIO): Promise<string> {
  const entries = await listAgentNames(io);
  return entries.find((e) => e.agentId === agentId)?.displayName ?? agentId;
}

export async function listAgentNames(io?: AgentNameIO): Promise<AgentNameEntry[]> {
  try {
    return JSON.parse(await readFile(namesPath(io?.relayDir), "utf8")) as AgentNameEntry[];
  } catch {
    return [];
  }
}
