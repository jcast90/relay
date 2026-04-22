import type { ChannelStore } from "./channel-store.js";
import type { TicketLedgerEntry } from "../domain/ticket.js";

/**
 * Tickets as they appear on a channel board, paired with the runId of the
 * originating orchestrator run when known. runId is null for chat-created
 * entries and for legacy-fallback entries whose workspace could not be
 * resolved.
 */
export interface BoardTicket {
  entry: TicketLedgerEntry;
  runId: string | null;
}

/**
 * Loader for per-run ticket ledgers, injected by callers that want the
 * fallback path. The MCP tool and the CLI both need this; unit tests can
 * supply a fake to exercise the fallback without a real filesystem.
 */
export type RunLedgerLoader = (
  workspaceId: string,
  runId: string
) => Promise<TicketLedgerEntry[] | null>;

/**
 * Resolve the canonical ticket list for a channel board. The channel file
 * (`channels/<id>/tickets.json`) is the live, unified source for both chat-
 * created and orchestrator-generated tickets; when it's empty, we fall back
 * to traversing the channel's linked runs and reading their per-run ledgers
 * (legacy data written before PR #10's unification).
 *
 * Remove the fallback branch once all workspaces have a non-empty channel
 * board — this helper is the single place to do that.
 */
export async function resolveBoardTickets(
  channelStore: ChannelStore,
  channelId: string,
  loadRunLedger?: RunLedgerLoader
): Promise<BoardTicket[]> {
  const channelTickets = await channelStore.readChannelTickets(channelId);

  if (channelTickets.length > 0) {
    return channelTickets.map((entry) => ({
      entry,
      runId: entry.runId ?? null,
    }));
  }

  if (!loadRunLedger) return [];

  const runLinks = await channelStore.readRunLinks(channelId);
  const out: BoardTicket[] = [];

  for (const link of runLinks) {
    const tickets = await loadRunLedger(link.workspaceId, link.runId);
    if (!tickets) continue;
    for (const entry of tickets) {
      out.push({ entry, runId: link.runId });
    }
  }

  return out;
}
