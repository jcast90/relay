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
