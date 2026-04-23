import { z } from "zod";

import type { AgentProvider, AgentRole } from "./agent.js";

export const ChannelStatusSchema = z.enum(["active", "archived"]);
export type ChannelStatus = z.infer<typeof ChannelStatusSchema>;

/**
 * Classifier-assigned tier surfaced in the channel header pill. The
 * heuristic classifier in `harness-data` seeds this on channel create; the
 * LLM classifier (orchestrator) refines it when a run is dispatched into
 * the channel. Optional for back-compat with older channel files.
 */
export const ChannelTierSchema = z.enum([
  "feature_large",
  "feature",
  "bugfix",
  "chore",
  "question",
]);
export type ChannelTier = z.infer<typeof ChannelTierSchema>;

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
  /**
   * Classifier-assigned tier. Seeded by the heuristic classifier in
   * harness-data at channel-create time; refined by the orchestrator's LLM
   * classifier on first run dispatch. Optional for back-compat.
   */
  tier?: ChannelTier;
  /**
   * Pinned to the Starred section of the sidebar. Always written by the Rust
   * side; undefined on older files is treated as `false`.
   */
  starred?: boolean;
  /**
   * "channel" (default) or "dm". DMs are kickoff surfaces — same storage +
   * streaming path as a channel, but the sidebar segregates them.
   */
  kind?: "channel" | "dm";
  /**
   * Section (sidebar group) this channel belongs to. `undefined` means
   * "Uncategorized" — rendered at the bottom of the sidebar in its own
   * always-visible bucket. When the section this id references is
   * decommissioned, the UI auto-moves the channel to Uncategorized
   * on the next load.
   */
  sectionId?: string;
  /**
   * Provider profile ID that overrides the process-wide `HARNESS_PROVIDER`
   * env for agents dispatched on behalf of this channel. The profile itself
   * (adapter, default model, env overlay, `apiKeyEnvRef`) lives in the
   * provider-profile store (PR 1); the channel only stores the reference.
   * Absent = inherit whatever the dispatcher's default resolution chooses
   * (explicit default profile → `HARNESS_PROVIDER`). Optional for back-compat.
   */
  providerProfileId?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * A sidebar grouping for channels. Maps 1:1 to Slack's collapsible
 * sections. Stored as a list in `~/.relay/sections.json` — see
 * `crates/harness-data` for the Rust mirror.
 *
 * `status` implements soft delete: an `active` section shows in the
 * sidebar; a `decommissioned` section is hidden but retained so an
 * Undo flow can revive it without recreating the grouping from scratch.
 * Hard delete removes the entry outright; the CLI only permits it when
 * no active channel still references the id.
 */
export interface Section {
  sectionId: string;
  name: string;
  /** Smaller = higher in the sidebar. Auto-assigned on create. */
  order: number;
  status: "active" | "decommissioned";
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
