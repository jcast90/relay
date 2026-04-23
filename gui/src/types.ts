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

export type ChannelTier = "feature_large" | "feature" | "bugfix" | "chore" | "question";

// Must stay in sync with the Rust `TicketProvider` enum in
// `crates/harness-data/src/lib.rs`. `unknown` is the forward-compat catch-all
// for provider strings this GUI build doesn't recognise yet; treat it as
// equivalent to `none` at the UI layer.
export type TicketProvider = "relay" | "linear" | "none" | "unknown";

export type GuiSettings = {
  ticketProvider: TicketProvider;
  linearApiToken: string;
  linearWorkspace: string;
  linearPollSeconds: number;
  rightRailOpen: boolean;
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
  // Classifier-assigned tier. Optional — older channels omit.
  tier?: ChannelTier;
  // Pinned to the Starred section of the sidebar. Always serialized by the
  // Rust side (no skip_serializing_if) so it's non-optional at the TS layer.
  starred: boolean;
  // Per-channel opt-in for unattended agent runs (AL-0). When `true`, agent
  // subprocesses dispatched for this channel skip permission prompts.
  // Optional for back-compat; a missing field means "off".
  fullAccess?: boolean;
  // "channel" (default) or "dm". DMs are kickoff surfaces — same storage
  // + streaming path as a channel, but the sidebar segregates them and the
  // UI hides tabs + shows a Promote-to-channel affordance.
  kind?: "channel" | "dm";
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
  // Provenance. Absent = Relay-authored. "linear" = read-only mirror of
  // a Linear issue surfaced by the Linear → channel-board poller.
  source?: "relay" | "linear";
  linearIssueId?: string;
  linearIdentifier?: string;
  linearState?: string;
  linearUrl?: string;
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
// spawn flow. Fields other than alias/repoPath are populated best-effort by
// the platform Terminal adapter and may be undefined when the adapter can't
// report them.
export type Spawn = {
  alias: string;
  repoPath: string;
  spawnedAt: string;
  terminalWindowId?: number;
  terminalTabId?: number;
};

// Persisted snapshot of a tracked PR row. Written by the CLI PR watcher;
// read by the GUI's PR strip + TUI's Prs tab. Mirrors the Rust
// `TrackedPrRow` struct (`crates/harness-data`). `ci`/`review`/`prState`
// are null when the row has been tracked but not yet polled.
export type TrackedPrRow = {
  ticketId: string;
  channelId: string;
  owner: string;
  name: string;
  number: number;
  url: string;
  branch: string;
  ci: string | null;
  review: string | null;
  prState: string | null;
  updatedAt: string;
};

// A run whose plan is awaiting approval. Surfaced in the GUI's approval CTA
// card. Collected from the workspace-level runs-index + per-run approval
// record; see `src/index.ts` `handlePendingPlansCommand` for the matching
// CLI view.
export type PendingPlan = {
  runId: string;
  workspaceId: string;
  featureRequest: string;
  channelId?: string | null;
  state: string;
  updatedAt: string;
};

// AL-7/AL-8 approvals queue record. Mirrors `src/approvals/queue.ts`
// `ApprovalRecord` and the Rust `ApprovalQueueRecord` in
// `crates/harness-data/src/lib.rs`. `payload` is intentionally opaque so
// the GUI can render new kinds without a schema bump.
export type ApprovalQueueRecord = {
  id: string;
  sessionId: string;
  kind: string;
  payload: Record<string, unknown>;
  createdAt: string;
  status: "pending" | "approved" | "rejected";
  decidedAt?: string | null;
  feedback?: string | null;
  // AL-7 god-mode marker. Present on records auto-approved by the trust
  // gate without an operator in the loop. Only value today is "god-mode".
  autoApprovedBy?: string | null;
};

// AL-10: summary row returned by `list_autonomous_sessions`. One per
// session directory under `~/.relay/sessions/` whose metadata.json is
// parseable. The CenterPane uses these to resolve `channel -> session`.
export type AutonomousSessionSummary = {
  sessionId: string;
  channelId: string;
  state: string;
  startedAt: string;
  trust: string;
};

// AL-10: deep session state returned by `get_session_state`. Renders the
// AutonomousSessionHeader; all fields are already pre-computed on the Rust
// side so the component stays dumb.
export type AutonomousSessionState = {
  sessionId: string;
  channelId: string;
  // Lifecycle state — matches the `LifecycleState` enum in
  // `src/lifecycle/types.ts` (planning / dispatching / winding_down /
  // audit / done / killed).
  state: string;
  trust: string;
  budgetTokens: number;
  budgetUsed: number;
  budgetPct: number;
  maxHours: number;
  startedAt: string;
  // ISO timestamp of the most recent lifecycle transition.
  updatedAt: string;
  hoursRemaining: number;
  currentTicketId?: string | null;
  allowedRepos: string[];
};

// AL-10 previously defined `SessionApproval` here. Dropped — AL-8 owns the
// GUI approvals surface via `ApprovalQueueRecord` above.
