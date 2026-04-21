// Mirror of harness-data Rust types (camelCase via serde rename_all).

export type WorkspaceEntry = {
  workspaceId: string;
  repoPath: string;
};

export type RepoAssignment = {
  alias: string;
  workspaceId: string;
  repoPath: string;
};

export type ChannelMember = {
  agentId: string;
  displayName: string;
  role: string;
  provider: string;
  status: string;
};

export type ChannelRef = {
  type: string;
  targetId: string;
  label: string;
};

export type Channel = {
  channelId: string;
  name: string;
  description: string;
  status: string;
  members: ChannelMember[];
  pinnedRefs: ChannelRef[];
  repoAssignments: RepoAssignment[];
  // workspaceId of the repo flagged as primary for this channel. Optional
  // for back-compat with older channel files; when unset, UI falls back to
  // the first entry in `repoAssignments`.
  primaryWorkspaceId?: string;
  // ISO 8601; optional for back-compat with older channel files.
  createdAt?: string;
  updatedAt?: string;
};

export type ChannelEntry = {
  entryId: string;
  channelId: string;
  type: string;
  fromAgentId?: string;
  fromDisplayName?: string;
  content: string;
  metadata: Record<string, string>;
  createdAt: string;
};

export type ChatSession = {
  sessionId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  claudeSessionIds: Record<string, string>;
};

export type PersistedChatMessage = {
  role: string;
  content: string;
  timestamp: string;
  agentAlias?: string;
  // Free-form per-message metadata. Rewind tags user turns with
  // `rewindKey` to identify which git refs to restore.
  metadata?: Record<string, string>;
};

export type RewindSnapshot = {
  key: string;
  snapshots: Array<{
    alias: string;
    repoPath: string;
    sha: string;
    ref: string;
  }>;
};

export type RewindResult = {
  reset: Array<{ alias: string; repoPath: string; sha: string }>;
  removedMessages: number;
  clearedClaudeSessions: boolean;
};

export type TicketLedgerEntry = {
  ticketId: string;
  title: string;
  specialty: string;
  status: string;
  dependsOn: string[];
  assignedAgentId?: string;
  assignedAgentName?: string;
  verification: string;
  attempt: number;
  // Alias of the channel repo assignment this ticket is routed to.
  // Optional; absent on tickets written before per-repo routing existed.
  assignedAlias?: string;
};

export type Decision = {
  decisionId: string;
  title: string;
  description: string;
  rationale: string;
  alternatives: string[];
  decidedByName: string;
  createdAt: string;
};

export type ChannelRunLink = {
  runId: string;
  workspaceId: string;
};

export type RunIndexEntry = {
  runId: string;
  featureRequest: string;
  state: string;
  channelId?: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
};

export type AgentNameEntry = {
  agentId: string;
  displayName: string;
  provider: string;
  role: string;
};

// An agent process launched into its own external terminal window via the
// spawn flow. Mirrors the shape documented in Task #24's contract. Fields
// other than alias/repoPath are populated best-effort by the platform
// Terminal adapter and may be undefined when the adapter can't report them.
export type Spawn = {
  alias: string;
  repoPath: string;
  spawnedAt: string;
  terminalWindowId?: number;
  terminalTabId?: number;
};
