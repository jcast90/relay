import type { Channel, ChannelMember, ChannelTier, RepoAssignment } from "../types";

/**
 * UI-facing projection of a Channel. Collapses the backend's workspaceId-
 * centric shape into the alias-centric shape the Tidewater design uses
 * throughout: `repos: string[]` of aliases, `primaryRepo: string` alias,
 * `topic` instead of `description`, etc.
 *
 * Keep all rename churn in this file so components consume UiChannel
 * directly and don't deal with both spellings.
 */
export type UiChannel = {
  id: string;
  name: string;
  topic: string;
  tier?: ChannelTier;
  starred: boolean;
  status: string;
  repos: string[];
  primaryRepo: string;
  primaryWorkspaceId?: string;
  agents: string[];
  members: ChannelMember[];
  repoAssignments: RepoAssignment[];
  activeAt: string;
  createdAt?: string;
  updatedAt?: string;
};

export function toUiChannel(c: Channel, now: Date = new Date()): UiChannel {
  const primaryAssignment =
    (c.primaryWorkspaceId &&
      c.repoAssignments.find((r) => r.workspaceId === c.primaryWorkspaceId)) ||
    c.repoAssignments[0];
  const primaryRepo = primaryAssignment?.alias ?? "";
  const repos = sortPrimaryFirst(c.repoAssignments, primaryRepo).map((r) => r.alias);
  return {
    id: c.channelId,
    name: c.name,
    topic: c.description,
    tier: c.tier,
    starred: c.starred ?? false,
    status: c.status,
    repos,
    primaryRepo,
    primaryWorkspaceId: c.primaryWorkspaceId,
    agents: c.members.map((m) => m.agentId),
    members: c.members,
    repoAssignments: c.repoAssignments,
    activeAt: humanizeRelative(c.updatedAt ?? c.createdAt, now),
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

export function primaryAlias(c: Channel): string | null {
  if (c.repoAssignments.length === 0) return null;
  if (c.primaryWorkspaceId) {
    const match = c.repoAssignments.find((r) => r.workspaceId === c.primaryWorkspaceId);
    if (match) return match.alias;
  }
  return c.repoAssignments[0].alias;
}

export function aliasToWorkspaceId(c: Channel, alias: string): string | undefined {
  return c.repoAssignments.find((r) => r.alias === alias)?.workspaceId;
}

export function workspaceIdToAlias(c: Channel, workspaceId: string): string | undefined {
  return c.repoAssignments.find((r) => r.workspaceId === workspaceId)?.alias;
}

function sortPrimaryFirst<T extends { alias: string }>(rows: T[], primary: string): T[] {
  if (!primary) return rows;
  return [...rows].sort((a, b) => {
    if (a.alias === primary) return -1;
    if (b.alias === primary) return 1;
    return 0;
  });
}

/**
 * Humanize an ISO timestamp as a short "2m" / "3h" / "4d" / "2w" string.
 * Falls back to the raw ISO date for anything older than ~4 weeks, and
 * returns an empty string for missing input so callers can render `—`.
 */
export function humanizeRelative(iso: string | undefined, now: Date = new Date()): string {
  if (!iso) return "";
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return "";
  const seconds = Math.floor((now.getTime() - parsed) / 1000);
  if (seconds < 45) return `${Math.max(seconds, 1)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 4) return `${weeks}w`;
  return new Date(parsed).toISOString().slice(0, 10);
}
