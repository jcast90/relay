/**
 * Central namespace constants for `HarnessStore`. Referencing these rather
 * than inline string literals lets the Postgres impl map each ns to a
 * dedicated table (or filter on `ns`) without a mass string-find across
 * callers, and keeps typos from silently partitioning data.
 */

export const STORE_NS = {
  workspace: "workspace",
  channel: "channel",
  channelFeed: "channel-feed",
  channelTickets: "channel-tickets",
  run: "run",
  runEvents: "run-events",
  runArtifacts: "run-artifacts",
  agentName: "agent-name",
  session: "session",
  decision: "decision",
  crosslinkSession: "crosslink-session",
  crosslinkMailbox: "crosslink-mailbox",
} as const;

export type StoreNamespace = (typeof STORE_NS)[keyof typeof STORE_NS];
