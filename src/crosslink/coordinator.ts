/**
 * AL-16: inter-admin coordination bus.
 *
 * The {@link Coordinator} is the runtime half of the AL-16 protocol. It
 * validates payloads against the schemas in `./messages.ts`, routes them
 * between admin aliases, stamps the decisions board for audit, tracks
 * block relationships so cycles are rejected up front, and exposes a
 * `waitFor` helper so an admin can pause until a specific shape lands.
 *
 * ## Design notes
 *
 * - **Not a merge gate.** The bus is an advisory channel. It records
 *   proposals and block requests; the scheduler (AL-5 / AL-7) is the
 *   only layer that acts on them. Keeping the bus dumb means we can
 *   swap the enforcement layer later without rewriting wire format.
 *
 * - **Pool-scoped.** One Coordinator instance per autonomous session,
 *   wired inside `startAutonomousSession` alongside the
 *   {@link RepoAdminPool}. Admin aliases are its addressing scheme
 *   because a pool's membership is stable within a single run
 *   (assignments don't mutate mid-session).
 *
 * - **Fail-fast on validation.** `send()` validates via zod; a malformed
 *   payload resolves to `{ ok: false, reason: "malformed" }` with the
 *   full issues list. We NEVER silently drop a bad message — AC4.
 *
 * - **Deadlock prevention.** We track directed block edges (requester →
 *   blocker per ticketId). A second `blocked-on-repo` that would close
 *   a cycle is rejected with `{ ok: false, reason: "would-form-cycle" }`.
 *   This is the simplest useful form — richer graph reasoning
 *   (transitive cycles, timeouts on stale blocks) is deferred.
 *
 * - **Audit via decisions.** Every routed message writes a
 *   `coordination_message` entry to the channel's decisions board
 *   (type-tagged so future TUI/GUI filters are cheap). Failures to
 *   audit are warned but never surfaced — the message still reaches
 *   the subscriber. Disk is best-effort; the bus is the source of
 *   truth within the run.
 */

import { EventEmitter } from "node:events";

import type { ChannelStore } from "../channels/channel-store.js";
import type { RepoAdminPool } from "../orchestrator/repo-admin-pool.js";
import { parseCoordinationMessage, type CoordinationMessage } from "./messages.js";

/**
 * Payload a caller hands to {@link Coordinator.send}. The coordinator
 * re-validates before routing so callers that build the object by hand
 * can pass a loosely-typed record — the bus enforces the shape.
 */
export type CoordinationPayload = CoordinationMessage | Record<string, unknown>;

/** Success envelope returned by {@link Coordinator.send}. */
export interface SendOk {
  ok: true;
  kind: CoordinationMessage["kind"];
  from: string;
  to: string;
  routedAt: string;
}

/**
 * Failure envelope for {@link Coordinator.send}. `reason` is a short
 * stable code the repo-admin prompt can pattern-match on; `detail`
 * carries the human-readable explanation (e.g. the zod issue summary).
 */
export interface SendErr {
  ok: false;
  reason:
    | "malformed"
    | "no-such-admin"
    | "would-form-cycle"
    | "coordinator-closed"
    | "self-addressed";
  detail: string;
  issues?: unknown;
}

export type SendResult = SendOk | SendErr;

/**
 * A listener receives every routed message addressed to its admin
 * alias. Listeners may be sync or async; the coordinator awaits async
 * listeners so a throw in one subscriber doesn't race with the next
 * `send()` but never lets one slow listener wedge the whole bus
 * (per-listener try/catch inside {@link Coordinator.fanout}).
 */
export type CoordinationListener = (msg: CoordinationMessage) => void | Promise<void>;

export interface WaitForOptions {
  /**
   * How long to wait before rejecting with `wait-timeout`. Required so
   * a typo'd predicate can't wedge the caller forever; the AL-16
   * integration test uses a small value, while production callers
   * inside the autonomous loop pass a larger ceiling.
   */
  timeoutMs: number;
  /** Human label for error messages + audit. */
  label?: string;
}

/**
 * Internal block-edge record used by the cycle detector. `requester`
 * is blocked on `blocker`; if the graph already has `blocker` blocked
 * on `requester`, the new edge would close a cycle and must be
 * rejected.
 */
interface BlockEdge {
  requester: string;
  blocker: string;
  ticketId: string;
  dependsOnTicketId: string;
}

export interface CoordinatorOptions {
  /**
   * Pool of repo-admin sessions. Used exclusively to validate that
   * `send(from, to, ...)` targets an alias the run knows about; the
   * coordinator never reaches into a session's internals.
   */
  pool: Pick<RepoAdminPool, "getSession" | "listSessions">;
  /**
   * Channel board for decision-audit mirrors. Every routed message
   * writes a `coordination_message` decision — future TUI/GUI surfaces
   * can replay them to reconstruct inter-admin coordination post-mortem.
   */
  channelStore: Pick<ChannelStore, "recordDecision">;
  /** Channel id the audit decisions land under. */
  channelId: string;
  /**
   * Clock injection. Tests pin this so `requestedAt` / `routedAt` are
   * deterministic; production passes the default `Date.now`-based
   * ISO string emitter.
   */
  now?: () => string;
}

export class Coordinator {
  private readonly pool: Pick<RepoAdminPool, "getSession" | "listSessions">;
  private readonly channelStore: Pick<ChannelStore, "recordDecision">;
  private readonly channelId: string;
  private readonly now: () => string;

  private readonly listeners = new Map<string, Set<CoordinationListener>>();
  private readonly blockEdges: BlockEdge[] = [];
  private readonly emitter = new EventEmitter();
  private closed = false;

  constructor(options: CoordinatorOptions) {
    this.pool = options.pool;
    this.channelStore = options.channelStore;
    this.channelId = options.channelId;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /**
   * Validate + route a typed message from `from` to `to`.
   *
   * Returns a discriminated {@link SendResult} rather than throwing so
   * caller ergonomics match the MCP tool surface (the tool returns the
   * envelope verbatim) and so the repo-admin prompt can branch on a
   * single-field check.
   *
   * Ordering:
   *  1. Reject if the coordinator has been {@link close}d.
   *  2. Validate the payload against {@link CoordinationMessageSchema}.
   *  3. Reject self-addressed messages — sending to yourself is always
   *     a programming error and the bus refuses rather than eating the
   *     round trip.
   *  4. Confirm the `to` alias is registered with the pool.
   *  5. For `blocked-on-repo`: run the cycle check BEFORE fan-out so a
   *     cycle-closing request never reaches the blocker.
   *  6. Fan out to every subscribed listener for `to`.
   *  7. Audit: append a `coordination_message` decision entry.
   *  8. Return ok.
   *
   * Fan-out happens before audit so a slow disk write can't starve the
   * subscriber. The audit failure is warned, never surfaced — the
   * bus is authoritative in-memory.
   */
  async send(from: string, to: string, payload: CoordinationPayload): Promise<SendResult> {
    if (this.closed) {
      return {
        ok: false,
        reason: "coordinator-closed",
        detail: "Coordinator has been closed; no further sends accepted.",
      };
    }

    const parsed = parseCoordinationMessage(payload);
    if (!parsed.ok) {
      return {
        ok: false,
        reason: "malformed",
        detail: parsed.error,
        issues: parsed.issues,
      };
    }

    if (from === to) {
      return {
        ok: false,
        reason: "self-addressed",
        detail: `Admin "${from}" cannot send coordination messages to itself.`,
      };
    }

    // Confirm both ends are known to the pool. `from` is trusted (the
    // MCP layer derives it from the session's role) but we still
    // reject if the caller passed a bogus source — a typo there is
    // the same class of programming error as a missing target.
    const toSession = this.pool.getSession(to);
    if (!toSession) {
      return {
        ok: false,
        reason: "no-such-admin",
        detail: `No repo-admin with alias "${to}" is registered in this run.`,
      };
    }

    const message = parsed.message;

    // Deadlock prevention. Only `blocked-on-repo` adds graph edges; the
    // other shapes never introduce a dependency, so we skip the check
    // for them entirely (avoids running the scan on every announcement).
    if (message.kind === "blocked-on-repo") {
      if (message.requester !== from) {
        return {
          ok: false,
          reason: "malformed",
          detail:
            `blocked-on-repo.requester ("${message.requester}") must match ` +
            `the sending admin ("${from}").`,
        };
      }
      if (message.blocker !== to) {
        return {
          ok: false,
          reason: "malformed",
          detail:
            `blocked-on-repo.blocker ("${message.blocker}") must match ` +
            `the receiving admin ("${to}").`,
        };
      }
      if (this.wouldFormCycle(message.requester, message.blocker)) {
        return {
          ok: false,
          reason: "would-form-cycle",
          detail:
            `blocked-on-repo from "${message.requester}" to "${message.blocker}" ` +
            `would close a cycle in the cross-repo block graph.`,
        };
      }
      this.blockEdges.push({
        requester: message.requester,
        blocker: message.blocker,
        ticketId: message.ticketId,
        dependsOnTicketId: message.dependsOnTicketId,
      });
    }

    // `repo-ready` clears any block edges the announcement resolves.
    // A cross-repo block is only interesting until the blocker has a
    // merged/open PR for the dependency; once we see ready for that
    // ticketId, the edge is dead weight in the cycle graph. Drop it.
    if (message.kind === "repo-ready") {
      for (let i = this.blockEdges.length - 1; i >= 0; i--) {
        const edge = this.blockEdges[i];
        if (edge.blocker === message.alias && edge.dependsOnTicketId === message.ticketId) {
          this.blockEdges.splice(i, 1);
        }
      }
    }

    const routedAt = this.now();

    await this.fanout(to, message);
    this.emitter.emit("message", { from, to, message, routedAt });
    await this.audit(from, to, message, routedAt);

    return { ok: true, kind: message.kind, from, to, routedAt };
  }

  /**
   * Subscribe a listener to every message routed to `alias`. Returns
   * an unsubscribe handle. Safe to call before the admin's session is
   * live — the coordinator only checks pool membership on `send()`,
   * so a listener can be wired up during session boot before the
   * first message arrives.
   */
  onMessage(alias: string, listener: CoordinationListener): () => void {
    let set = this.listeners.get(alias);
    if (!set) {
      set = new Set();
      this.listeners.set(alias, set);
    }
    set.add(listener);
    return () => {
      const s = this.listeners.get(alias);
      if (!s) return;
      s.delete(listener);
      if (s.size === 0) this.listeners.delete(alias);
    };
  }

  /**
   * Wait for the next message addressed to `alias` whose payload
   * satisfies `predicate`. Resolves with the matching message, or
   * rejects with `wait-timeout` after `timeoutMs`.
   *
   * Unlike {@link onMessage}, `waitFor` is a one-shot: the listener
   * auto-unsubscribes as soon as the predicate matches. This is the
   * primitive the autonomous-loop integration test uses to model
   * "repo-admin A waits for B's repo-ready before proceeding" (AC3).
   */
  waitFor(
    alias: string,
    predicate: (msg: CoordinationMessage) => boolean,
    opts: WaitForOptions
  ): Promise<CoordinationMessage> {
    if (this.closed) {
      return Promise.reject(new Error("coordinator-closed"));
    }
    return new Promise((resolve, reject) => {
      const label = opts.label ?? "waitFor";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        unsubscribe();
        reject(new Error(`${label}: wait-timeout after ${opts.timeoutMs}ms`));
      }, opts.timeoutMs);
      // Don't wedge node's exit if the wait is still outstanding.
      const t = timer as unknown as { unref?: () => void };
      if (t && typeof t.unref === "function") t.unref();

      const unsubscribe = this.onMessage(alias, (msg) => {
        if (settled) return;
        let matched = false;
        try {
          matched = predicate(msg);
        } catch (err) {
          // Predicate threw — treat as non-match but surface on stderr so
          // buggy predicates don't silently fail every message.
          // eslint-disable-next-line no-console
          console.warn(
            `[coordinator] ${label}: predicate threw on ${msg.kind}: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
        if (!matched) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        resolve(msg);
      });
    });
  }

  /**
   * Drain subscribers and block further sends. Idempotent. The CLI's
   * autonomous-loop teardown calls this after the pool has stopped so
   * late-arriving listeners don't linger past the run.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.listeners.clear();
    this.blockEdges.length = 0;
    this.emitter.removeAllListeners();
  }

  /**
   * Snapshot of outstanding block edges. Exposed for the pool-event
   * observer / TUI so "why is this admin waiting?" is answerable
   * without replaying the bus. Returns a shallow copy so callers can't
   * mutate internal state.
   */
  listOpenBlocks(): ReadonlyArray<Readonly<BlockEdge>> {
    return this.blockEdges.slice();
  }

  // --- internals ---------------------------------------------------------

  /**
   * Cycle detection. A new edge `requester → blocker` closes a cycle
   * iff there's already a path `blocker → ... → requester` in the
   * current graph. We only maintain direct edges (per-ticket), so a
   * DFS over {@link blockEdges} is sufficient for the MVP.
   *
   * Not transitively strict by design: the AL-16 MVP protects against
   * the common pairwise A↔B case that the ticket brief calls out.
   * Richer graph hygiene (stale-block eviction, ticket-granular
   * edges) is deferred.
   */
  private wouldFormCycle(requester: string, blocker: string): boolean {
    // DFS from `blocker` following `requester`-outbound edges; if we
    // reach `requester`, adding requester→blocker closes a cycle.
    const visited = new Set<string>();
    const stack = [blocker];
    while (stack.length > 0) {
      const cursor = stack.pop()!;
      if (cursor === requester) return true;
      if (visited.has(cursor)) continue;
      visited.add(cursor);
      for (const edge of this.blockEdges) {
        if (edge.requester === cursor) stack.push(edge.blocker);
      }
    }
    return false;
  }

  private async fanout(alias: string, message: CoordinationMessage): Promise<void> {
    const set = this.listeners.get(alias);
    if (!set || set.size === 0) return;
    // Snapshot: a handler that unsubscribes during fan-out shouldn't
    // affect the current pass. Also fan-out sequentially (await each)
    // so the `waitFor` resolution happens-before any audit write —
    // tests assert that invariant.
    const snapshot = Array.from(set);
    for (const listener of snapshot) {
      try {
        await listener(message);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[coordinator] listener for "${alias}" threw on ${message.kind}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }
  }

  private async audit(
    from: string,
    to: string,
    message: CoordinationMessage,
    routedAt: string
  ): Promise<void> {
    try {
      await this.channelStore.recordDecision(this.channelId, {
        runId: null,
        ticketId: deriveTicketIdForAudit(message),
        title: `coordination: ${message.kind} ${from} → ${to}`,
        description: describeForAudit(message),
        rationale: "message" in message ? "" : "", // kept as a hook for future rationale fields
        alternatives: [],
        decidedBy: from,
        decidedByName: `repo-admin:${from}`,
        linkedArtifacts: [],
        type: "coordination_message",
        metadata: {
          from,
          to,
          routedAt,
          payload: message as unknown as Record<string, unknown>,
        },
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[coordinator] audit write failed for ${message.kind} ${from} → ${to}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }
}

/**
 * Extract the ticket id that should anchor the audit entry. Each shape
 * carries its own "primary" ticket id — the blocker for `blocked-on-
 * repo`, the ready ticket for `repo-ready`, and the first item in the
 * sequence for `merge-order-proposal`. Returning null when nothing
 * fits is safe — `recordDecision` accepts `ticketId: null`.
 */
function deriveTicketIdForAudit(message: CoordinationMessage): string | null {
  switch (message.kind) {
    case "blocked-on-repo":
      return message.ticketId;
    case "repo-ready":
      return message.ticketId;
    case "merge-order-proposal":
      return message.sequence[0]?.ticketId ?? null;
  }
}

/**
 * Short human-readable description for the decisions board. Kept on
 * one line so the TUI decision list stays scannable.
 */
function describeForAudit(message: CoordinationMessage): string {
  switch (message.kind) {
    case "blocked-on-repo":
      return (
        `${message.requester} is blocked on ${message.blocker}'s ` +
        `${message.dependsOnTicketId} (for ${message.ticketId}): ${message.reason}`
      );
    case "repo-ready":
      return (
        `${message.alias} announces ${message.ticketId} ready at ${message.prUrl}` +
        (message.mergedAt ? ` (merged ${message.mergedAt})` : " (PR open)")
      );
    case "merge-order-proposal":
      return (
        `${message.proposer} proposes merge order: ` +
        message.sequence.map((s) => `${s.alias}/${s.ticketId}`).join(" → ") +
        ` — ${message.rationale}`
      );
  }
}
