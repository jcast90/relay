import { getAgentName, listAgentNames, setAgentName } from "../domain/agent-names.js";
import type { AgentProvider, AgentRole } from "../domain/agent.js";
import { ChannelStore } from "../channels/channel-store.js";
import type { ChannelRefType, ChannelStatus } from "../domain/channel.js";
import { LocalArtifactStore } from "../execution/artifact-store.js";
import {
  getGlobalRoot,
  listRegisteredWorkspaces
} from "../cli/workspace-registry.js";

export interface ChannelToolState {
  sessionId: string | null;
  channelStore: ChannelStore;
}

const ACTIVE_RUN_STATES = new Set([
  "CLASSIFYING",
  "DRAFT_PLAN",
  "PLAN_REVIEW",
  "AWAITING_APPROVAL",
  "DESIGN_DOC",
  "PHASE_READY",
  "PHASE_EXECUTE",
  "TEST_FIX_LOOP",
  "REVIEW_FIX_LOOP",
  "TICKETS_EXECUTING",
  "TICKETS_COMPLETE"
]);

export function isChannelTool(name: string): boolean {
  return name.startsWith("channel_") || name.startsWith("agent_name_") || name === "harness_running_tasks";
}

export function getChannelToolDefinitions(): object[] {
  return [
    // Channel management
    {
      name: "channel_create",
      description: "Create a new channel for agents to collaborate in.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["name", "description"],
        properties: {
          name: { type: "string", description: "Channel name, e.g. #feature-auth" },
          description: { type: "string" },
          workspaceIds: { type: "array", items: { type: "string" } }
        }
      }
    },
    {
      name: "channel_list",
      description: "List all channels, optionally filtered by status.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          status: { type: "string", enum: ["active", "archived"] }
        }
      }
    },
    {
      name: "channel_get",
      description: "Get channel details including members, refs, and recent feed.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["channelId"],
        properties: {
          channelId: { type: "string" },
          feedLimit: { type: "integer", minimum: 1, maximum: 100 }
        }
      }
    },
    {
      name: "channel_update",
      description: "Update channel name, description, or status.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["channelId"],
        properties: {
          channelId: { type: "string" },
          name: { type: "string" },
          description: { type: "string" },
          status: { type: "string", enum: ["active", "archived"] }
        }
      }
    },
    {
      name: "channel_archive",
      description: "Archive a channel.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["channelId"],
        properties: { channelId: { type: "string" } }
      }
    },
    // Members
    {
      name: "channel_join",
      description: "Add an agent to the channel.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["channelId", "agentId", "displayName", "role", "provider"],
        properties: {
          channelId: { type: "string" },
          agentId: { type: "string" },
          displayName: { type: "string" },
          role: { type: "string" },
          provider: { type: "string" },
          sessionId: { type: "string" }
        }
      }
    },
    {
      name: "channel_leave",
      description: "Remove an agent from the channel.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["channelId", "agentId"],
        properties: {
          channelId: { type: "string" },
          agentId: { type: "string" }
        }
      }
    },
    // Feed
    {
      name: "channel_post",
      description: "Post a message to the channel feed.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["channelId", "content"],
        properties: {
          channelId: { type: "string" },
          content: { type: "string" },
          agentId: { type: "string" }
        }
      }
    },
    {
      name: "channel_feed",
      description: "Read recent channel feed entries.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["channelId"],
        properties: {
          channelId: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 200 }
        }
      }
    },
    // References
    {
      name: "channel_add_ref",
      description: "Pin a reference to another channel, repo, run, or ticket.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["channelId", "type", "targetId", "label"],
        properties: {
          channelId: { type: "string" },
          type: { type: "string", enum: ["channel", "repo", "run", "ticket"] },
          targetId: { type: "string" },
          label: { type: "string" }
        }
      }
    },
    {
      name: "channel_remove_ref",
      description: "Unpin a reference from a channel.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["channelId", "targetId"],
        properties: {
          channelId: { type: "string" },
          targetId: { type: "string" }
        }
      }
    },
    // Runs & Tasks
    {
      name: "channel_link_run",
      description: "Associate a run with this channel.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["channelId", "runId", "workspaceId"],
        properties: {
          channelId: { type: "string" },
          runId: { type: "string" },
          workspaceId: { type: "string" }
        }
      }
    },
    {
      name: "channel_task_board",
      description: "Get tickets grouped by status for this channel (kanban view).",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["channelId"],
        properties: { channelId: { type: "string" } }
      }
    },
    {
      name: "channel_running",
      description: "Show active tasks and agents in this channel.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["channelId"],
        properties: { channelId: { type: "string" } }
      }
    },
    // Decisions
    {
      name: "channel_record_decision",
      description: "Record a decision in this channel with rationale and alternatives.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["channelId", "title", "description", "rationale"],
        properties: {
          channelId: { type: "string" },
          title: { type: "string" },
          description: { type: "string" },
          rationale: { type: "string" },
          alternatives: { type: "array", items: { type: "string" } },
          runId: { type: "string" },
          ticketId: { type: "string" },
          linkedArtifacts: { type: "array", items: { type: "string" } }
        }
      }
    },
    {
      name: "channel_list_decisions",
      description: "List decisions in a channel.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["channelId"],
        properties: { channelId: { type: "string" } }
      }
    },
    {
      name: "channel_get_decision",
      description: "Get full details of a decision.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["channelId", "decisionId"],
        properties: {
          channelId: { type: "string" },
          decisionId: { type: "string" }
        }
      }
    },
    // Agent names
    {
      name: "agent_name_set",
      description: "Set a display name for an agent.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["agentId", "displayName", "provider", "role"],
        properties: {
          agentId: { type: "string" },
          displayName: { type: "string" },
          provider: { type: "string" },
          role: { type: "string" }
        }
      }
    },
    {
      name: "agent_name_list",
      description: "List all named agents.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {}
      }
    },
    // Cross-channel
    {
      name: "harness_running_tasks",
      description: "Cross-channel view of all active tasks and agents across all workspaces.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {}
      }
    }
  ];
}

export async function callChannelTool(
  name: string,
  args: Record<string, unknown>,
  state: ChannelToolState
): Promise<unknown> {
  const store = state.channelStore;

  switch (name) {
    case "channel_create":
      return store.createChannel({
        name: String(args.name ?? ""),
        description: String(args.description ?? ""),
        workspaceIds: Array.isArray(args.workspaceIds)
          ? (args.workspaceIds as string[])
          : undefined
      });

    case "channel_list":
      return {
        channels: await store.listChannels(
          args.status ? (String(args.status) as ChannelStatus) : undefined
        )
      };

    case "channel_get": {
      const channelId = String(args.channelId ?? "");
      const channel = await store.getChannel(channelId);
      if (!channel) throw new Error(`Channel not found: ${channelId}`);
      const feed = await store.readFeed(channelId, Number(args.feedLimit ?? 20));
      return { ...channel, recentFeed: feed };
    }

    case "channel_update":
      return store.updateChannel(String(args.channelId ?? ""), {
        ...(args.name ? { name: String(args.name) } : {}),
        ...(args.description ? { description: String(args.description) } : {}),
        ...(args.status ? { status: String(args.status) as ChannelStatus } : {})
      });

    case "channel_archive":
      return store.archiveChannel(String(args.channelId ?? ""));

    case "channel_join":
      return store.joinChannel(String(args.channelId ?? ""), {
        agentId: String(args.agentId ?? ""),
        displayName: String(args.displayName ?? ""),
        role: String(args.role ?? "implementer") as AgentRole,
        provider: String(args.provider ?? "claude") as AgentProvider,
        sessionId: args.sessionId ? String(args.sessionId) : null
      });

    case "channel_leave":
      return store.leaveChannel(
        String(args.channelId ?? ""),
        String(args.agentId ?? "")
      );

    case "channel_post": {
      const agentId = args.agentId ? String(args.agentId) : null;
      const displayName = agentId ? await getAgentName(agentId) : null;
      return store.postEntry(String(args.channelId ?? ""), {
        type: "message",
        fromAgentId: agentId,
        fromDisplayName: displayName,
        content: String(args.content ?? ""),
        metadata: {}
      });
    }

    case "channel_feed":
      return {
        entries: await store.readFeed(
          String(args.channelId ?? ""),
          Number(args.limit ?? 50)
        )
      };

    case "channel_add_ref":
      return store.addRef(String(args.channelId ?? ""), {
        type: String(args.type ?? "channel") as ChannelRefType,
        targetId: String(args.targetId ?? ""),
        label: String(args.label ?? "")
      });

    case "channel_remove_ref":
      return store.removeRef(
        String(args.channelId ?? ""),
        String(args.targetId ?? "")
      );

    case "channel_link_run":
      await store.linkRun(
        String(args.channelId ?? ""),
        String(args.runId ?? ""),
        String(args.workspaceId ?? "")
      );
      return { linked: true };

    case "channel_task_board": {
      const channelId = String(args.channelId ?? "");
      const runLinks = await store.readRunLinks(channelId);
      const board: Record<string, Array<{ ticketId: string; title: string; runId: string }>> = {};

      for (const link of runLinks) {
        const artifactStore = buildArtifactStoreForWorkspace(link.workspaceId);
        const tickets = await artifactStore.readTicketLedger(link.runId);
        if (!tickets) continue;

        for (const ticket of tickets) {
          if (!board[ticket.status]) board[ticket.status] = [];
          board[ticket.status].push({
            ticketId: ticket.ticketId,
            title: ticket.title,
            runId: link.runId
          });
        }
      }

      return { channelId, board };
    }

    case "channel_running": {
      const channelId = String(args.channelId ?? "");
      const channel = await store.getChannel(channelId);
      const runLinks = await store.readRunLinks(channelId);
      const activeAgents = channel?.members.filter((m) => m.status === "active") ?? [];
      const activeRuns: Array<{ runId: string; state: string }> = [];

      for (const link of runLinks) {
        const artifactStore = buildArtifactStoreForWorkspace(link.workspaceId);
        const snapshot = await artifactStore.readRunSnapshot(link.runId);
        if (snapshot && ACTIVE_RUN_STATES.has(snapshot.state)) {
          activeRuns.push({ runId: snapshot.runId, state: snapshot.state });
        }
      }

      return { channelId, activeAgents, activeRuns };
    }

    case "channel_record_decision": {
      const channelId = String(args.channelId ?? "");
      const agentId = state.sessionId ?? "unknown";
      const displayName = await getAgentName(agentId);
      return store.recordDecision(channelId, {
        runId: args.runId ? String(args.runId) : null,
        ticketId: args.ticketId ? String(args.ticketId) : null,
        title: String(args.title ?? ""),
        description: String(args.description ?? ""),
        rationale: String(args.rationale ?? ""),
        alternatives: Array.isArray(args.alternatives) ? args.alternatives as string[] : [],
        decidedBy: agentId,
        decidedByName: displayName,
        linkedArtifacts: Array.isArray(args.linkedArtifacts) ? args.linkedArtifacts as string[] : []
      });
    }

    case "channel_list_decisions":
      return {
        decisions: await store.listDecisions(String(args.channelId ?? ""))
      };

    case "channel_get_decision":
      return store.getDecision(
        String(args.channelId ?? ""),
        String(args.decisionId ?? "")
      );

    case "agent_name_set":
      return setAgentName(
        String(args.agentId ?? ""),
        String(args.displayName ?? ""),
        String(args.provider ?? "claude") as AgentProvider,
        String(args.role ?? "implementer") as AgentRole
      );

    case "agent_name_list":
      return { agents: await listAgentNames() };

    case "harness_running_tasks": {
      const workspaces = await listRegisteredWorkspaces();
      const activeTasks: Array<{
        workspaceId: string;
        repoPath: string;
        runId: string;
        state: string;
        featureRequest: string;
        channelId: string | null;
      }> = [];

      for (const ws of workspaces) {
        const artifactStore = buildArtifactStoreForWorkspace(ws.workspaceId);
        const runs = await artifactStore.readRunsIndex();

        for (const run of runs) {
          if (ACTIVE_RUN_STATES.has(run.state)) {
            activeTasks.push({
              workspaceId: ws.workspaceId,
              repoPath: ws.repoPath,
              runId: run.runId,
              state: run.state,
              featureRequest: run.featureRequest,
              channelId: run.channelId ?? null
            });
          }
        }
      }

      return { activeTasks, count: activeTasks.length };
    }

    default:
      throw new Error(`Unknown channel tool: ${name}`);
  }
}

function buildArtifactStoreForWorkspace(workspaceId: string): LocalArtifactStore {
  const globalRoot = getGlobalRoot();
  return new LocalArtifactStore(`${globalRoot}/workspaces/${workspaceId}/artifacts`);
}
