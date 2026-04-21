import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  Channel,
  ChannelEntry,
  ChannelRunLink,
  ChatSession,
  Decision,
  PersistedChatMessage,
  RewindResult,
  RewindSnapshot,
  RunIndexEntry,
  Spawn,
  TicketLedgerEntry,
  WorkspaceEntry,
  AgentNameEntry,
} from "./types";

export const api = {
  listWorkspaces: () => invoke<WorkspaceEntry[]>("list_workspaces"),
  listChannels: () => invoke<Channel[]>("list_channels"),
  getChannel: (channelId: string) =>
    invoke<Channel | null>("get_channel", { channelId }),
  listFeed: (channelId: string, limit = 200) =>
    invoke<ChannelEntry[]>("list_feed", { channelId, limit }),
  listSessions: (channelId: string) =>
    invoke<ChatSession[]>("list_sessions", { channelId }),
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
  listRuns: (workspaceId: string) =>
    invoke<RunIndexEntry[]>("list_runs", { workspaceId }),
  listTicketLedger: (workspaceId: string, runId: string) =>
    invoke<TicketLedgerEntry[]>("list_ticket_ledger", { workspaceId, runId }),
  listAgentNames: () => invoke<AgentNameEntry[]>("list_agent_names"),
  runCli: (args: string[]) =>
    invoke<{ success: boolean; stdout: string; stderr: string; code: number | null }>(
      "run_cli",
      { args },
    ),

  createChannel: (
    name: string,
    description: string,
    repos: { alias: string; workspaceId: string; repoPath: string }[],
    primaryWorkspaceId?: string,
  ) =>
    invoke<{ channelId: string }>("create_channel", {
      name,
      description,
      repos,
      primaryWorkspaceId,
    }),
  archiveChannel: (channelId: string) =>
    invoke<unknown>("archive_channel", { channelId }),
  updateChannelRepos: (
    channelId: string,
    repos: { alias: string; workspaceId: string; repoPath: string }[],
  ) =>
    invoke<unknown>("update_channel_repos", { channelId, repos }),
  postToChannel: (
    channelId: string,
    content: string,
    from?: string,
    entryType?: string,
  ) =>
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
    metadata?: Record<string, string>,
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
  rewindApply: (
    channelId: string,
    sessionId: string,
    key: string,
    messageTimestamp: string,
  ) =>
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

  // Task #24 contract. These invoke wrappers are thin passthroughs that
  // assume the Rust side registers `spawn_agent`, `list_spawns`, and
  // `kill_spawned_agent` commands that accept / return camelCase via
  // serde rename_all. Until that lands, calls here will reject at runtime
  // with a "command not found"-style error — which surfaces inline in the
  // spawn UI rather than crashing the app.
  spawnAgent: (channelId: string, alias: string, repoPath: string) =>
    invoke<Spawn>("spawn_agent", { channelId, alias, repoPath }),
  listSpawns: (channelId: string) =>
    invoke<Spawn[]>("list_spawns", { channelId }),
  killSpawnedAgent: (channelId: string, alias: string) =>
    invoke<void>("kill_spawned_agent", { channelId, alias }),
};

export type ChatEvent =
  | { kind: "started"; streamId: number }
  | { kind: "chunk"; streamId: number; text: string }
  | { kind: "activity"; streamId: number; text: string }
  | { kind: "sessionId"; streamId: number; claudeSessionId: string }
  | { kind: "done"; streamId: number; finalText: string }
  | { kind: "error"; streamId: number; message: string };

export function subscribeChatEvents(
  cb: (event: ChatEvent) => void,
): Promise<UnlistenFn> {
  return listen<ChatEvent>("chat-event", (e) => cb(e.payload));
}
