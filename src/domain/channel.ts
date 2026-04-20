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
  "decision",
  "artifact",
  "agent_joined",
  "agent_left",
  "ref_added",
  "run_started",
  "run_completed"
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
  metadata: Record<string, string>;
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
