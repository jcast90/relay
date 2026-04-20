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
 * points at the tracking ticket so operators know where to follow up instead
 * of filing duplicate bugs.
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
 *   - src/cli/workspace-registry.ts      -> T-102
 *   - src/cli/session-store.ts           -> T-102
 *   - src/channels/channel-store.ts      -> T-101
 *   - src/crosslink/store.ts             -> T-104
 *   - src/execution/artifact-store.ts    -> T-103
 *
 * Other `node:fs/promises` importers (workspace bootstrap, agent wrapper,
 * crosslink hook/tools, config, welcome, mcp server, scripted invoker,
 * agent-names, cli-agents, this file's peer `file-store.ts`) are not
 * storage backends and stay on direct fs access.
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
 */
export function buildHarnessStore(
  opts: StoreFactoryOptions = {}
): HarnessStore {
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
