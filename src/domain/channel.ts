import { z } from "zod";

import type { AgentProvider, AgentRole } from "./agent.js";

export const ChannelStatusSchema = z.enum(["active", "archived"]);
export type ChannelStatus = z.infer<typeof ChannelStatusSchema>;

export const MemberStatusSchema = z.enum(["active", "idle", "offline"]);
export type MemberStatus = z.infer<typeof MemberStatusSchema>;

export const ChannelRefTypeSchema = z.enum(["channel", "repo", "run", "ticket"]);
export type ChannelRefType = z.infer<typeof ChannelRefTypeSchema>;

export const ChannelEntryTypeSchema = z.enum([
  "message",
  "status_update",
  "event",
  "decision",
  "artifact",
  "agent_joined",
  "agent_left",
  "ref_added",
  "run_started",
  "run_completed",
]);
export type ChannelEntryType = z.infer<typeof ChannelEntryTypeSchema>;

export interface ChannelMember {
  agentId: string;
  displayName: string;
  role: AgentRole;
  provider: AgentProvider;
  sessionId: string | null;
  joinedAt: string;
  status: MemberStatus;
}

export interface ChannelRef {
  type: ChannelRefType;
  targetId: string;
  label: string;
  addedAt: string;
}

export interface RepoAssignment {
  alias: string;
  workspaceId: string;
  repoPath: string;
}

export interface Channel {
  channelId: string;
  name: string;
  description: string;
  status: ChannelStatus;
  workspaceIds: string[];
  members: ChannelMember[];
  pinnedRefs: ChannelRef[];
  repoAssignments?: RepoAssignment[];
  /**
   * When set, identifies which entry in `repoAssignments` is the "primary"
   * repo for this channel — the one the user chats in by default and the
   * one orchestrator/agents route to when a ticket has no explicit
   * `assignedAlias`. When unset, callers fall back to `repoAssignments[0]`.
   * Optional for back-compat with channel.json files written before the
   * primary/associated model existed.
   */
  primaryWorkspaceId?: string;
  /**
   * Linear project ID this channel mirrors onto its ticket board. Read-only
   * mirror — tickets created from Linear issues are tagged with
   * `source: "linear"` and are never scheduled by the orchestrator. Absence
   * means no mirror is configured; Relay still functions normally.
   */
  linearProjectId?: string;
  /**
   * Per-channel opt-in for unattended agent runs. When `true`, subprocesses
   * Relay spawns on behalf of this channel are launched with
   * `--dangerously-skip-permissions` (Claude) / `--sandbox workspace-write
   * --ask-for-approval never` (Codex) so they don't prompt for permission on
   * every tool call. Scoped per-channel — toggling this on one channel never
   * affects another channel, even when both assign the same repo. Optional
   * for back-compat with older channel files: a missing field is treated as
   * `false` at every read site.
   */
  fullAccess?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ChannelEntry {
  entryId: string;
  channelId: string;
  type: ChannelEntryType;
  fromAgentId: string | null;
  fromDisplayName: string | null;
  content: string;
  /**
   * Free-form metadata for the entry. Callers may pass any JSON-serializable
   * values; the channel store serializes non-string values to JSON strings on
   * write (tagged with an `__ah_meta_json::` prefix) so downstream Rust
   * readers (`crates/harness-data`) and the GUI (`gui/src/types.ts`), which
   * type metadata as `Record<string, string>`, continue to deserialize the
   * feed without changes. TypeScript callers see the original types round-
   * tripped back on read via `denormalizeMetadata`.
   */
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface ChannelRunLink {
  runId: string;
  workspaceId: string;
  linkedAt: string;
}

export function buildChannelId(): string {
  return `channel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function buildEntryId(): string {
  return `entry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
