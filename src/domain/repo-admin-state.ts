/**
 * Phase 4: Canonical four-state enum for repo-admin readiness.
 *
 * Single source of truth in TS for "what state is a repo-admin in?" as
 * rendered across every Phase 4 surface (SessionStart hook, TUI sidebar,
 * GUI badges, `rly status`). Mirrored byte-for-byte by the Rust enum and
 * `derive_state` function in `crates/harness-data/src/lib.rs` — the four
 * wire values (`disconnected | booting | ready | stale`) MUST stay
 * identical between the two implementations. Wire format is kebab-case.
 *
 * Phase 3's lesson was "alive != ready". Phase 4's equivalent: one
 * derivation function, called identically everywhere. Never re-derive
 * state in a consumer; always import {@link deriveRepoAdminState}.
 *
 * State semantics (per `04-CONTEXT.md` D-06):
 *   - `disconnected` — repo is not in the channel's `repoAssignments[]`,
 *     OR no `CrosslinkSession` exists for the repo. Decided at the
 *     channel-rendering layer; {@link deriveRepoAdminState} returns this
 *     only when called with `session === null`.
 *   - `booting` — `CrosslinkSession` exists, pid alive, heartbeat fresh,
 *     `readyAt` absent (Phase 3's "alive but not ready" window).
 *   - `ready` — `readyAt` is set (agent called `agent_ready`).
 *   - `stale` — pid dead OR `heartbeatAge > STALE_HEARTBEAT_MS`. Wins
 *     over `ready`: a session whose pid is dead is `stale`, not `ready`,
 *     even if it managed to set `readyAt` before dying.
 */

import { z } from "zod";

/**
 * Zod schema for the wire format. Use this when parsing JSON that crosses
 * the TS/Rust boundary or when validating user input. The four kebab-case
 * strings are the only valid values — adding a fifth requires a coordinated
 * TS+Rust change.
 */
export const RepoAdminStateSchema = z.enum(["disconnected", "booting", "ready", "stale"]);

export type RepoAdminState = z.infer<typeof RepoAdminStateSchema>;

/**
 * Heartbeat staleness threshold in milliseconds. Mirrors the Rust constant
 * in `crates/harness-data/src/lib.rs::STALE_HEARTBEAT_MS`. Phase 4 takes
 * ownership of this constant as part of D-06's single-source-of-truth
 * mandate; `src/crosslink/store.ts` imports from here.
 */
export const STALE_HEARTBEAT_MS = 120_000;

/**
 * Minimal session shape `deriveRepoAdminState` needs. Intentionally
 * structural so callers can pass a full `CrosslinkSession`, a fixture
 * object in tests, or a hand-rolled subset without coupling to the full
 * zod schema in `src/crosslink/types.ts`.
 */
export interface RepoAdminStateSessionInput {
  pid: number;
  lastHeartbeat: string;
  readyAt?: string | null;
}

/**
 * Derive the canonical four-state value for a given session.
 *
 * Branch order MUST match the Rust `derive_state` byte-for-byte:
 *   1. `session === null` → `"disconnected"`.
 *   2. process not alive OR (`nowMs - lastHeartbeat`) > `STALE_HEARTBEAT_MS`
 *      → `"stale"`. Stale wins over ready: a session whose pid is dead is
 *      `stale` even if `readyAt` is set.
 *   3. `readyAt` is truthy → `"ready"`.
 *   4. Otherwise → `"booting"`.
 *
 * `isProcessAlive` is injected so this function is pure (no IO, no
 * implicit dependency on `process.kill`). Tests can pass a deterministic
 * stub; production callers pass a thin wrapper around `process.kill(pid, 0)`.
 */
export function deriveRepoAdminState(
  session: RepoAdminStateSessionInput | null,
  nowMs: number,
  isProcessAlive: (pid: number) => boolean
): RepoAdminState {
  if (!session) return "disconnected";
  const hb = new Date(session.lastHeartbeat).getTime();
  const alive = isProcessAlive(session.pid);
  if (!alive || nowMs - hb > STALE_HEARTBEAT_MS) return "stale";
  if (session.readyAt) return "ready";
  return "booting";
}
