/**
 * Per-ticket routing (AL-13).
 *
 * The autonomous-loop driver reads the channel's ticket board and hands each
 * ready ticket to this router. The router resolves which
 * {@link RepoAdminSession} owns the ticket's repo, then calls
 * `session.dispatchTicket(ticket)` so the admin can queue it for AL-14's
 * worker-spawn pass.
 *
 * Resolution rules (spec from ticket AL-13, Closes #88):
 *  1. If `ticket.assignedAlias` is set, look up the matching
 *     `repoAssignment`. No match → unroutable (`unknown-alias`).
 *  2. If unset, fall back to `ChannelStore.getPrimaryAssignment(channel)`.
 *     No primary (channel has no assignments at all) → unroutable
 *     (`no-primary-assignment`).
 *  3. With the alias pinned, look up the `RepoAdminSession` on the pool.
 *     No session for that alias → unroutable (`no-admin-for-alias`). This
 *     happens when `allowedAliases` excluded the admin at pool boot, or
 *     when the session died and the pool gave up on restarts.
 *  4. Otherwise: call `session.dispatchTicket(ticket)` and return `routed`.
 *
 * Unroutable tickets MUST NOT be silently dropped. The router's caller
 * (autonomous-loop) relies on this class to:
 *   - stamp `ticket.status = "blocked"`
 *   - set `lastClassification` to `{ category: "routing_error", … }` so the
 *     reason shows up in the TUI's ticket inspector the same way a
 *     verification failure would
 *   - mirror the updated entry onto the channel's ticket board via
 *     `ChannelStore.upsertChannelTickets`
 *   - post a `status_update` to the channel feed naming the block
 *
 * The router itself is scope-disciplined: it does NOT spawn workers
 * (AL-14), poll for completion (AL-14), or swap admins around (AL-15).
 * Everything terminates inside `dispatchTicket` or the unroutable-surface
 * helper.
 */

import type { Channel } from "../domain/channel.js";
import type { TicketLedgerEntry } from "../domain/ticket.js";
import type { ChannelStore } from "../channels/channel-store.js";
import type { RepoAdminPool } from "./repo-admin-pool.js";

export type TicketRouteReason =
  | `unknown-alias:${string}`
  | "no-primary-assignment"
  | `no-admin-for-alias:${string}`;

export interface TicketRouteRouted {
  kind: "routed";
  alias: string;
}

export interface TicketRouteUnroutable {
  kind: "unroutable";
  reason: TicketRouteReason;
  /**
   * Alias the router attempted to resolve to. Populated when the ticket had
   * an explicit `assignedAlias` OR when a primary fallback resolved; absent
   * when no alias could be determined (empty channel).
   */
  attemptedAlias?: string;
}

export type TicketRouteResult = TicketRouteRouted | TicketRouteUnroutable;

export interface TicketRouterOptions {
  pool: RepoAdminPool;
  channel: Channel;
  channelStore: ChannelStore;
  /**
   * Optional clock injection — tests use a deterministic one so the
   * `updatedAt` stamp on blocked tickets is stable across runs. Defaults to
   * `() => new Date().toISOString()`.
   */
  now?: () => string;
}

export class TicketRouter {
  private readonly pool: RepoAdminPool;
  private readonly channel: Channel;
  private readonly channelStore: ChannelStore;
  private readonly now: () => string;

  constructor(options: TicketRouterOptions) {
    this.pool = options.pool;
    this.channel = options.channel;
    this.channelStore = options.channelStore;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /**
   * Route a single ticket. Returns `routed` on success. On failure, the
   * return value describes the reason AND the ticket is mutated + mirrored
   * to the channel board as blocked with a `routing_error` classification.
   *
   * This method mutates the `ticket` argument in place on the unroutable
   * path so the caller's board snapshot reflects the new status without a
   * re-read. The channel-store mirror is a secondary durability hop for
   * readers that don't hold an in-memory reference.
   */
  async route(ticket: TicketLedgerEntry): Promise<TicketRouteResult> {
    const resolved = this.resolveAlias(ticket);
    if (resolved.kind === "unresolved") {
      await this.surfaceUnroutable(ticket, resolved.reason, resolved.attempted);
      return {
        kind: "unroutable",
        reason: resolved.reason,
        ...(resolved.attempted ? { attemptedAlias: resolved.attempted } : {}),
      };
    }

    const alias = resolved.alias;
    const session = this.pool.getSession(alias);
    if (!session) {
      const reason: TicketRouteReason = `no-admin-for-alias:${alias}`;
      await this.surfaceUnroutable(ticket, reason, alias);
      return { kind: "unroutable", reason, attemptedAlias: alias };
    }

    // AL-14's job is what happens inside `dispatchTicket`. The router just
    // hands off.
    await session.dispatchTicket(ticket);
    return { kind: "routed", alias };
  }

  // --- internals ----------------------------------------------------------

  private resolveAlias(
    ticket: TicketLedgerEntry
  ):
    | { kind: "resolved"; alias: string }
    | { kind: "unresolved"; reason: TicketRouteReason; attempted?: string } {
    const assignments = this.channel.repoAssignments ?? [];

    if (ticket.assignedAlias) {
      const match = assignments.find((a) => a.alias === ticket.assignedAlias);
      if (!match) {
        return {
          kind: "unresolved",
          reason: `unknown-alias:${ticket.assignedAlias}`,
          attempted: ticket.assignedAlias,
        };
      }
      return { kind: "resolved", alias: match.alias };
    }

    const primary = this.channelStore.getPrimaryAssignment(this.channel);
    if (!primary) {
      return { kind: "unresolved", reason: "no-primary-assignment" };
    }
    return { kind: "resolved", alias: primary.alias };
  }

  /**
   * Mark the ticket blocked + mirror to the channel board + post a
   * `status_update` to the feed. Best-effort writes are awaited so the
   * caller sees the persisted state — AL-13's acceptance criteria require
   * the block to be visible, not just attempted.
   *
   * Errors from the channel store are caught and logged, never thrown:
   * losing the mirror write shouldn't mask the routing failure that the
   * autonomous-loop driver is about to log separately.
   */
  private async surfaceUnroutable(
    ticket: TicketLedgerEntry,
    reason: TicketRouteReason,
    attemptedAlias: string | undefined
  ): Promise<void> {
    const rationale = buildRationale(reason);
    const nextAction = buildNextAction(reason);

    ticket.status = "blocked";
    ticket.lastClassification = {
      category: "routing_error",
      rationale,
      nextAction,
    };
    ticket.updatedAt = this.now();

    try {
      await this.channelStore.upsertChannelTickets(this.channel.channelId, [ticket]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.warn(
        `[ticket-router] failed to mirror blocked ticket ${ticket.ticketId} onto channel ` +
          `${this.channel.channelId}: ${message}`
      );
    }

    try {
      await this.channelStore.postEntry(this.channel.channelId, {
        type: "status_update",
        fromAgentId: null,
        fromDisplayName: "Router",
        content:
          `Ticket ${ticket.ticketId} is unroutable: ${rationale} ` +
          `Fix ticket's assignedAlias or the channel's repoAssignments.`,
        metadata: {
          ticketId: ticket.ticketId,
          routingReason: reason,
          ...(attemptedAlias ? { attemptedAlias } : {}),
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.warn(
        `[ticket-router] failed to post block entry for ticket ${ticket.ticketId} on channel ` +
          `${this.channel.channelId}: ${message}`
      );
    }
  }
}

function buildRationale(reason: TicketRouteReason): string {
  if (reason.startsWith("unknown-alias:")) {
    const alias = reason.slice("unknown-alias:".length);
    return `Ticket's assignedAlias "${alias}" does not match any repoAssignment on the channel.`;
  }
  if (reason.startsWith("no-admin-for-alias:")) {
    const alias = reason.slice("no-admin-for-alias:".length);
    return `No repo-admin session is running for alias "${alias}" — the pool filtered it via --allow-repo or gave up after rapid restarts.`;
  }
  // Exhaustive: narrow reason to the remaining literal.
  return "Channel has no repoAssignments, so the ticket cannot be routed to any primary repo.";
}

function buildNextAction(_reason: TicketRouteReason): string {
  return "fix ticket's assignedAlias or the channel's repoAssignments";
}
