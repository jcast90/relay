import { FileHarnessStore } from "./file-store.js";
import type { HarnessStore } from "./store.js";
import { getRelayDir } from "../cli/paths.js";

export type StoreKind = "file" | "postgres" | "sqlite";

export interface StoreFactoryOptions {
  /** Override env-based detection. Falls back to HARNESS_STORE env, then "file". */
  kind?: StoreKind;
  /** Root directory for FileHarnessStore. Defaults to getRelayDir(). */
  fileRoot?: string;
  /** Connection config for future Postgres impl (T-402). */
  postgresUrl?: string;
}

/**
 * Thrown when a store kind is recognized but not yet implemented. The message
 * points at the tracking ticket (where one exists) so operators know where to
 * follow up instead of filing duplicate bugs. SQLite has no tracking ticket
 * yet (TBD); postgres points at T-402.
 */
export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotImplementedError";
  }
}

/*
 * Interim direct-`node:fs/promises` allowlist. Each entry migrates to
 * `HarnessStore` in a dedicated ticket — until then, treat this list as the
 * canonical record of unmigrated state surfaces so reviewers don't flag them
 * in unrelated PRs:
 *
 *   - src/cli/workspace-registry.ts      -> T-102 (partial: ctor takes a
 *                                          HarnessStore; registry-level
 *                                          coordination record migrated.
 *                                          On-disk layout stays for
 *                                          Rust/GUI compat — T-101a aligns)
 *   - src/cli/session-store.ts           -> T-102 (partial: ctor takes a
 *                                          HarnessStore; per-session
 *                                          coordination record migrated.
 *                                          On-disk layout stays for
 *                                          Rust/GUI compat — T-101a aligns)
 *   - src/channels/channel-store.ts      -> T-101 (partial: ctor takes a
 *                                          HarnessStore; ticket-board
 *                                          coordination record migrated.
 *                                          On-disk layout stays for
 *                                          Rust/GUI compat — T-101a aligns)
 *   - src/crosslink/store.ts             -> T-104
 *   - src/execution/artifact-store.ts    -> T-103 (partial: ctor takes a
 *                                          HarnessStore; command-result and
 *                                          failure-classification blobs plus
 *                                          classification/approval/design-doc
 *                                          migrated; Rust-visible run
 *                                          snapshots/indexes/ledgers stay
 *                                          direct-file with a coordination
 *                                          record written through the store.
 *                                          T-103a aligns the Rust reader)
 *
 * Other `node:fs/promises` importers (workspace bootstrap, agent wrapper,
 * crosslink hook/tools, config, welcome, mcp server, scripted invoker,
 * agent-names, cli-agents, src/index.ts (reads package.json for version),
 * this file's peer `file-store.ts`) are not storage backends and stay on
 * direct fs access.
 */

function resolveKind(explicit: StoreKind | undefined): StoreKind {
  if (explicit) return explicit;
  const env = process.env["HARNESS_STORE"];
  if (env === "file" || env === "postgres" || env === "sqlite") return env;
  return "file";
}

/**
 * Construct the HarnessStore instance for this process. Single source of
 * truth for backend selection — downstream modules take the store as a ctor
 * argument and must not call this factory directly.
 *
 * Precedence: `opts.kind` > `HARNESS_STORE` env > default `"file"`.
 */
export function buildHarnessStore(opts: StoreFactoryOptions = {}): HarnessStore {
  const kind = resolveKind(opts.kind);

  if (kind === "file") {
    return new FileHarnessStore(opts.fileRoot ?? getRelayDir());
  }

  if (kind === "postgres") {
    throw new NotImplementedError(
      "PostgresHarnessStore is T-402 (not yet implemented); use HARNESS_STORE=file."
    );
  }

  throw new NotImplementedError(
    "SqliteHarnessStore is not yet implemented; use HARNESS_STORE=file."
  );
}

// Module-level singleton. Handlers migrating off direct `fs/promises` (T-101+)
// call `getHarnessStore()` to obtain the process-wide instance so every
// migrated caller observes the same state and watch semantics.
//
// A module-level cache rather than DI: legacy handlers still instantiate their
// own stores directly (`new ChannelStore()` etc.), and the cache keeps them
// from forking behavior against a separately-constructed instance. Downstream
// constructors (T-101+) take `HarnessStore` as a ctor arg for test
// substitution, so the singleton is only a default entry point — not a hard
// dependency.
let cachedStore: HarnessStore | null = null;

/**
 * Return the process-wide `HarnessStore` singleton, constructing it on first
 * use. Tests that need a fresh store should pass one explicitly to the
 * consuming class; `resetHarnessStoreForTests` is provided for the rare case
 * where the singleton itself must be cleared between suites.
 */
export function getHarnessStore(): HarnessStore {
  if (!cachedStore) cachedStore = buildHarnessStore();
  return cachedStore;
}

/**
 * Test helper: drop the cached singleton so the next `getHarnessStore` call
 * reconstructs from the current `HARNESS_STORE` env. Not exported from the
 * package entrypoint; only intended for integration tests that mutate env
 * vars between runs.
 */
export function resetHarnessStoreForTests(): void {
  cachedStore = null;
}
