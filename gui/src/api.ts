import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AgentNameEntry,
  ApprovalQueueRecord,
  AutonomousSessionState,
  AutonomousSessionSummary,
  Channel,
  ChannelEntry,
  ChannelRunLink,
  ChatSession,
  Decision,
  GuiSettings,
  PendingPlan,
  PersistedChatMessage,
  RewindResult,
  RewindSnapshot,
  RunIndexEntry,
  Section,
  Spawn,
  TicketLedgerEntry,
  TrackedPrRow,
  WorkspaceEntry,
} from "./types";

export const api = {
  listWorkspaces: () => invoke<WorkspaceEntry[]>("list_workspaces"),
  listChannels: (includeArchived = false) =>
    invoke<Channel[]>("list_channels", { includeArchived }),
  getChannel: (channelId: string) => invoke<Channel | null>("get_channel", { channelId }),
  listFeed: (channelId: string, limit = 200) =>
    invoke<ChannelEntry[]>("list_feed", { channelId, limit }),
  listSessions: (channelId: string) => invoke<ChatSession[]>("list_sessions", { channelId }),
  listSessionCounts: () => invoke<Record<string, number>>("list_session_counts"),
  loadSession: (channelId: string, sessionId: string, limit = 500) =>
    invoke<PersistedChatMessage[]>("load_session", {
      channelId,
      sessionId,
      limit,
    }),
  listChannelTickets: (channelId: string) =>
    invoke<TicketLedgerEntry[]>("list_channel_tickets", { channelId }),
  listChannelDecisions: (channelId: string) =>
    invoke<Decision[]>("list_channel_decisions", { channelId }),
  listChannelRuns: (channelId: string) =>
    invoke<ChannelRunLink[]>("list_channel_runs", { channelId }),
  listRuns: (workspaceId: string) => invoke<RunIndexEntry[]>("list_runs", { workspaceId }),
  listTicketLedger: (workspaceId: string, runId: string) =>
    invoke<TicketLedgerEntry[]>("list_ticket_ledger", { workspaceId, runId }),
  listAgentNames: () => invoke<AgentNameEntry[]>("list_agent_names"),
  runCli: (args: string[]) =>
    invoke<{ success: boolean; stdout: string; stderr: string; code: number | null }>("run_cli", {
      args,
    }),

  createChannel: (
    name: string,
    description: string,
    repos: { alias: string; workspaceId: string; repoPath: string }[],
    primaryWorkspaceId?: string
  ) =>
    invoke<{ channelId: string; droppedRepos?: string[] }>("create_channel", {
      name,
      description,
      repos,
      primaryWorkspaceId,
    }),
  archiveChannel: (channelId: string) => invoke<unknown>("archive_channel", { channelId }),
  unarchiveChannel: (channelId: string) => invoke<unknown>("unarchive_channel", { channelId }),

  // Sections — sidebar grouping above channels.
  listSections: (includeDecommissioned = false) =>
    invoke<Section[]>("list_sections", { includeDecommissioned }),
  createSection: (name: string) => invoke<Section>("create_section", { name }),
  renameSection: (sectionId: string, name: string) =>
    invoke<Section>("rename_section", { sectionId, name }),
  decommissionSection: (sectionId: string) =>
    invoke<Section>("decommission_section", { sectionId }),
  restoreSection: (sectionId: string) => invoke<Section>("restore_section", { sectionId }),
  deleteSection: (sectionId: string) => invoke<{ ok: boolean }>("delete_section", { sectionId }),
  assignChannelSection: (channelId: string, sectionId: string | null) =>
    invoke<Channel>("assign_channel_section", { channelId, sectionId }),
  createDm: (workspaceId: string, workspacePath: string, alias: string) =>
    invoke<{ channelId: string }>("create_dm", { workspaceId, workspacePath, alias }),
  promoteDm: (
    channelId: string,
    name: string,
    description: string,
    repos: { alias: string; workspaceId: string; repoPath: string }[],
    primaryWorkspaceId?: string
  ) =>
    invoke<void>("promote_dm", {
      channelId,
      name,
      description,
      repos,
      primaryWorkspaceId,
    }),
  setChannelFullAccess: (channelId: string, on: boolean) =>
    invoke<unknown>("set_channel_full_access", { channelId, on }),
  updateChannelRepos: (
    channelId: string,
    repos: { alias: string; workspaceId: string; repoPath: string }[]
  ) =>
    invoke<{ droppedRepos?: string[] } & Record<string, unknown>>("update_channel_repos", {
      channelId,
      repos,
    }),
  setChannelStarred: (channelId: string, starred: boolean) =>
    invoke<void>("set_channel_starred", { channelId, starred }),
  setChannelTier: (channelId: string, tier: string | null) =>
    invoke<void>("set_channel_tier", { channelId, tier }),
  setPrimaryRepo: (channelId: string, workspaceId: string) =>
    invoke<void>("set_primary_repo", { channelId, workspaceId }),
  getSettings: () => invoke<GuiSettings>("get_settings"),
  updateSettings: (settings: GuiSettings) => invoke<void>("update_settings", { settings }),
  postToChannel: (channelId: string, content: string, from?: string, entryType?: string) =>
    invoke<unknown>("post_to_channel", {
      channelId,
      content,
      from,
      entryType,
    }),
  createSession: (channelId: string, title: string) =>
    invoke<ChatSession>("create_session", { channelId, title }),
  deleteSession: (channelId: string, sessionId: string) =>
    invoke<unknown>("delete_session", { channelId, sessionId }),
  appendSessionMessage: (
    channelId: string,
    sessionId: string,
    role: string,
    content: string,
    agentAlias?: string,
    metadata?: Record<string, string>
  ) =>
    invoke<unknown>("append_session_message", {
      channelId,
      sessionId,
      role,
      content,
      agentAlias,
      metadata,
    }),

  rewindSnapshot: (channelId: string, sessionId: string) =>
    invoke<RewindSnapshot>("rewind_snapshot", { channelId, sessionId }),
  rewindApply: (channelId: string, sessionId: string, key: string, messageTimestamp: string) =>
    invoke<RewindResult>("rewind_apply", {
      channelId,
      sessionId,
      key,
      messageTimestamp,
    }),

  startChat: (params: {
    channelId: string;
    sessionId: string;
    message: string;
    alias?: string;
    cwd?: string;
    claudeSessionId?: string;
    autoApprove: boolean;
    rewindKey?: string;
  }) => invoke<number>("start_chat", params),

  // Best-effort: signal a running `start_chat` thread to exit without
  // persisting the assistant message. Called by the rewind flow BEFORE
  // truncating the session log so the stream can't race truncation and
  // append a stale assistant turn afterwards.
  cancelChatStream: (streamId: number) => invoke<void>("cancel_chat_stream", { streamId }),

  spawnAgent: (channelId: string, alias: string, repoPath: string) =>
    invoke<Spawn>("spawn_agent", { channelId, alias, repoPath }),
  listSpawns: (channelId: string) => invoke<Spawn[]>("list_spawns", { channelId }),
  killSpawnedAgent: (channelId: string, alias: string) =>
    invoke<void>("kill_spawned_agent", { channelId, alias }),

  // Tracked-PR mirror + plan approval. `approve` / `reject` shell out to
  // the same `rly approve` / `rly reject` paths the CLI uses so approval
  // records are written through a single code path.
  listTrackedPrs: (channelId: string) => invoke<TrackedPrRow[]>("list_tracked_prs", { channelId }),
  listPendingPlans: () => invoke<PendingPlan[]>("list_pending_plans"),
  approvePlan: (runId: string) => invoke<unknown>("approve_plan", { runId }),
  rejectPlan: (runId: string, feedback?: string) =>
    invoke<unknown>("reject_plan", { runId, feedback }),

  // AL-7/AL-8 approvals queue. Distinct from plan-approval above — these
  // drain per-session queue.jsonl files rather than run artifacts.
  listPendingApprovals: (sessionId?: string) =>
    invoke<ApprovalQueueRecord[]>("list_pending_approvals", { sessionId }),
  approveQueueEntry: (id: string) => invoke<unknown>("approve_queue_entry", { id }),
  rejectQueueEntry: (id: string, feedback?: string) =>
    invoke<unknown>("reject_queue_entry", { id, feedback }),
  approveQueueAll: (sessionId?: string) => invoke<unknown>("approve_queue_all", { sessionId }),

  // AL-10: autonomous-session status readers. All three are no-op friendly —
  // they return empty / None when the on-disk files are missing, so the GUI
  // can poll them every 5s without plumbing a "session exists" predicate
  // ahead of each call.
  listAutonomousSessions: () => invoke<AutonomousSessionSummary[]>("list_autonomous_sessions"),
  getSessionState: (sessionId: string) =>
    invoke<AutonomousSessionState | null>("get_session_state", { sessionId }),
  // AL-9 owns the kill-switch command — writes a STOP file under the
  // session dir for the autonomous driver to observe. AL-10 reuses it
  // for the session-header stop button.
  stopSession: (sessionId: string) => invoke<void>("stop_session", { sessionId }),
};

export type ChatEvent =
  | { kind: "started"; streamId: number }
  | { kind: "chunk"; streamId: number; text: string }
  | { kind: "activity"; streamId: number; text: string }
  | { kind: "sessionId"; streamId: number; claudeSessionId: string }
  | { kind: "done"; streamId: number; finalText: string }
  | { kind: "error"; streamId: number; message: string };

export function subscribeChatEvents(cb: (event: ChatEvent) => void): Promise<UnlistenFn> {
  return listen<ChatEvent>("chat-event", (e) => cb(e.payload));
}
