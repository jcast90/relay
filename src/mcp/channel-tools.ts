import { getAgentName } from "../domain/agent-names.js";
import { ChannelStore } from "../channels/channel-store.js";
import { resolveBoardTickets } from "../channels/board-resolver.js";
import { LocalArtifactStore } from "../execution/artifact-store.js";
import {
  getGlobalRoot,
  listRegisteredWorkspaces
} from "../cli/workspace-registry.js";
import { getHarnessStore } from "../storage/factory.js";

export interface ChannelToolState {
  sessionId: string | null;
  channelStore: ChannelStore;
}

const ACTIVE_RUN_STATES = new Set([
  "CLASSIFYING", "DRAFT_PLAN", "PLAN_REVIEW", "AWAITING_APPROVAL",
  "DESIGN_DOC", "PHASE_READY", "PHASE_EXECUTE", "TEST_FIX_LOOP",
  "REVIEW_FIX_LOOP", "TICKETS_EXECUTING", "TICKETS_COMPLETE"
]);

export function isChannelTool(name: string): boolean {
  return name.startsWith("channel_") || name === "harness_running_tasks";
}

export function getChannelToolDefinitions(): object[] {
  return [
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
      name: "channel_get",
      description: "Get channel details including members, pinned refs, recent feed, and active runs.",
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
      name: "channel_record_decision",
      description: "Record a decision in this channel with rationale and alternatives considered.",
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
          ticketId: { type: "string" }
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
      name: "harness_running_tasks",
      description: "Cross-workspace view of all active tasks and agents.",
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

    case "channel_get": {
      const channelId = String(args.channelId ?? "");
      const channel = await store.getChannel(channelId);
      if (!channel) throw new Error(`Channel not found: ${channelId}`);

      const [feed, runLinks, decisions] = await Promise.all([
        store.readFeed(channelId, Number(args.feedLimit ?? 20)),
        store.readRunLinks(channelId),
        store.listDecisions(channelId)
      ]);

      const activeMembers = channel.members.filter((m) => m.status === "active");

      return {
        ...channel,
        activeMembers,
        recentFeed: feed,
        runLinks,
        recentDecisions: decisions.slice(0, 5)
      };
    }

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
        linkedArtifacts: []
      });
    }

    case "channel_task_board": {
      const channelId = String(args.channelId ?? "");
      const board: Record<string, Array<{ ticketId: string; title: string; runId: string | null }>> = {};

      const tickets = await resolveBoardTickets(store, channelId, async (
        workspaceId,
        runId
      ) => {
        const artifactStore = buildArtifactStoreForWorkspace(workspaceId);
        return artifactStore.readTicketLedger(runId);
      });

      for (const { entry, runId } of tickets) {
        if (!board[entry.status]) board[entry.status] = [];
        board[entry.status].push({
          ticketId: entry.ticketId,
          title: entry.title,
          runId
        });
      }

      return { channelId, board };
    }

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
  return new LocalArtifactStore(`${globalRoot}/workspaces/${workspaceId}/artifacts`, getHarnessStore());
}
