import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { LocalArtifactStore } from "../execution/artifact-store.js";
import { submitApproval } from "../orchestrator/approval-gate.js";
import { dispatch } from "../orchestrator/dispatch.js";
import { getHarnessWorkspacePaths, readWorkspaceSummary } from "../cli/workspace.js";
import { buildWorkspaceId } from "../cli/workspace-registry.js";
import { CrosslinkStore } from "../crosslink/store.js";
import { ChannelStore } from "../channels/channel-store.js";
import { getHarnessStore } from "../storage/factory.js";
import {
  callChannelTool,
  getChannelToolDefinitions,
  isChannelTool,
  type ChannelToolState,
} from "./channel-tools.js";
import {
  callCrosslinkTool,
  getCrosslinkToolDefinitions,
  isCrosslinkTool,
  type CrosslinkToolState,
} from "../crosslink/tools.js";

export interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: {
    code: number;
    message: string;
  };
}

export type McpMessageHandler = (message: JsonRpcMessage) => Promise<JsonRpcMessage | null>;

export interface McpHandlerContext {
  workspaceRoot: string;
  artifactStore: LocalArtifactStore;
  crosslinkState: CrosslinkToolState;
  channelState: ChannelToolState;
  cleanup: () => void;
}

/**
 * Build the JSON-RPC message handler + supporting state for an MCP server
 * instance. Shared between the stdio and HTTP/SSE transports so both paths
 * serve the same tool surface.
 */
export async function buildMcpMessageHandler(
  workspaceRoot: string
): Promise<{ handler: McpMessageHandler; context: McpHandlerContext }> {
  const paths = getHarnessWorkspacePaths(workspaceRoot);
  const artifactStore = new LocalArtifactStore(paths.artifactsDir, getHarnessStore());
  const crosslinkStore = new CrosslinkStore(undefined, getHarnessStore());
  const crosslinkState: CrosslinkToolState = {
    sessionId: null,
    store: crosslinkStore,
  };
  const channelStore = new ChannelStore(undefined, getHarnessStore());
  const channelState: ChannelToolState = {
    sessionId: null,
    channelStore,
  };

  // Auto-register this session
  const agentProvider = (process.env.AGENT_HARNESS_PROVIDER ?? "unknown") as
    | "claude"
    | "codex"
    | "unknown";
  const session = await crosslinkStore.registerSession({
    pid: process.pid,
    repoPath: workspaceRoot,
    description: `Agent session in ${workspaceRoot}`,
    capabilities: ["general"],
    agentProvider,
    status: "active",
  });
  crosslinkState.sessionId = session.sessionId;
  channelState.sessionId = session.sessionId;

  // Heartbeat every 30 seconds
  const heartbeatInterval = setInterval(() => {
    if (crosslinkState.sessionId) {
      crosslinkStore.updateHeartbeat(crosslinkState.sessionId).catch(() => {});
    }
  }, 30_000);

  const cleanup = (): void => {
    clearInterval(heartbeatInterval);
    if (crosslinkState.sessionId) {
      crosslinkStore.deregisterSession(crosslinkState.sessionId).catch(() => {});
      crosslinkState.sessionId = null;
    }
  };

  const handler: McpMessageHandler = (message) =>
    handleMessage(message, workspaceRoot, artifactStore, crosslinkState, channelState);

  return {
    handler,
    context: { workspaceRoot, artifactStore, crosslinkState, channelState, cleanup },
  };
}

export async function startMcpServer(workspaceRoot: string): Promise<void> {
  const { handler, context } = await buildMcpMessageHandler(workspaceRoot);

  process.on("exit", context.cleanup);
  process.on("SIGTERM", () => {
    context.cleanup();
    process.exit(0);
  });
  process.on("SIGINT", () => {
    context.cleanup();
    process.exit(0);
  });

  const transport = new StdioJsonRpcTransport(handler);
  transport.start();
}

async function handleMessage(
  message: JsonRpcMessage,
  workspaceRoot: string,
  artifactStore: LocalArtifactStore,
  crosslinkState: CrosslinkToolState,
  channelState: ChannelToolState
): Promise<JsonRpcMessage | null> {
  if (!message.method) {
    return null;
  }

  switch (message.method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id: message.id ?? null,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: "relay",
            version: "0.1.0",
          },
        },
      };
    case "notifications/initialized":
      return null;
    case "tools/list":
      return {
        jsonrpc: "2.0",
        id: message.id ?? null,
        result: {
          tools: [
            ...getCrosslinkToolDefinitions(),
            ...getChannelToolDefinitions(),
            {
              name: "harness_status",
              description: "Get Relay workspace status and recent runs.",
              inputSchema: {
                type: "object",
                additionalProperties: false,
                properties: {},
              },
            },
            {
              name: "harness_list_runs",
              description: "List recent harness runs for the current workspace.",
              inputSchema: {
                type: "object",
                additionalProperties: false,
                properties: {
                  limit: { type: "integer", minimum: 1, maximum: 50 },
                },
              },
            },
            {
              name: "harness_get_run_detail",
              description:
                "Get full run snapshot including classification, tickets, evidence, artifacts, and optionally the event log.",
              inputSchema: {
                type: "object",
                additionalProperties: false,
                required: ["runId"],
                properties: {
                  runId: { type: "string" },
                  includeEvents: { type: "boolean" },
                },
              },
            },
            {
              name: "harness_get_artifact",
              description: "Read a harness artifact JSON file by absolute path.",
              inputSchema: {
                type: "object",
                additionalProperties: false,
                required: ["path"],
                properties: {
                  path: { type: "string" },
                },
              },
            },
            {
              name: "harness_approve_plan",
              description: "Approve the pending plan for a run, unblocking ticket execution.",
              inputSchema: {
                type: "object",
                additionalProperties: false,
                required: ["runId"],
                properties: {
                  runId: { type: "string" },
                },
              },
            },
            {
              name: "harness_reject_plan",
              description: "Reject the pending plan with optional feedback.",
              inputSchema: {
                type: "object",
                additionalProperties: false,
                required: ["runId"],
                properties: {
                  runId: { type: "string" },
                  feedback: { type: "string" },
                },
              },
            },
            {
              name: "project_create",
              description:
                "Create a new project. A project is a channel that groups related chats, runs, and decisions. " +
                "Use this when the user wants to kick off a new initiative or workstream.",
              inputSchema: {
                type: "object",
                additionalProperties: false,
                required: ["name"],
                properties: {
                  name: {
                    type: "string",
                    description: "Project name, e.g. 'Auth Refactor' or 'New Dashboard'",
                  },
                  description: {
                    type: "string",
                    description: "What the project is about",
                  },
                },
              },
            },
            {
              name: "harness_dispatch",
              description:
                "Dispatch a feature request to the agent team. This kicks off the orchestrator in the background: " +
                "classifies the request, creates a plan, decomposes into tickets, and assigns agents. " +
                "Progress is posted to the channel feed and visible in the dashboard. Returns immediately with run ID.",
              inputSchema: {
                type: "object",
                additionalProperties: false,
                required: ["featureRequest"],
                properties: {
                  featureRequest: {
                    type: "string",
                    description:
                      "The feature to build — should be well-defined from your chat discussion",
                  },
                  channelId: {
                    type: "string",
                    description:
                      "Channel/project to link this run to. If omitted, a new channel is created.",
                  },
                },
              },
            },
          ],
        },
      };
    case "tools/call":
      try {
        const toolName = String(message.params?.name ?? "");
        const toolArgs = (message.params?.arguments as Record<string, unknown> | undefined) ?? {};
        const toolResult = isCrosslinkTool(toolName)
          ? await callCrosslinkTool(toolName, toolArgs, crosslinkState)
          : isChannelTool(toolName)
            ? await callChannelTool(toolName, toolArgs, channelState)
            : await callTool(toolName, toolArgs, workspaceRoot, artifactStore);

        return {
          jsonrpc: "2.0",
          id: message.id ?? null,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify(toolResult, null, 2),
              },
            ],
            isError: false,
          },
        };
      } catch (error) {
        return {
          jsonrpc: "2.0",
          id: message.id ?? null,
          result: {
            content: [
              {
                type: "text",
                text: error instanceof Error ? error.message : "Unknown MCP tool failure.",
              },
            ],
            isError: true,
          },
        };
      }
    default:
      return {
        jsonrpc: "2.0",
        id: message.id ?? null,
        error: {
          code: -32601,
          message: `Method not found: ${message.method}`,
        },
      };
  }
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  workspaceRoot: string,
  artifactStore: LocalArtifactStore
): Promise<unknown> {
  const workspacePaths = getHarnessWorkspacePaths(workspaceRoot);

  switch (name) {
    case "harness_status":
      return readWorkspaceSummary(artifactStore, workspaceRoot);
    case "harness_list_runs": {
      const runs = await artifactStore.readRunsIndex();
      const limit = Math.max(1, Math.min(Number(args.limit ?? 10), 50));
      return { workspaceRoot, runs: runs.slice(0, limit) };
    }
    case "harness_get_run_detail": {
      const runId = String(args.runId ?? "");
      const includeEvents = Boolean(args.includeEvents ?? false);
      const snapshot = await artifactStore.readRunSnapshot(runId);

      if (!snapshot) {
        throw new Error(`Run snapshot not found: ${runId}`);
      }

      const events = includeEvents ? await artifactStore.readEventLog(runId) : [];

      return { ...snapshot, events };
    }
    case "harness_get_artifact": {
      const inputPath = String(args.path ?? "");
      const path = isAbsolute(inputPath) ? inputPath : resolve(workspacePaths.rootDir, inputPath);

      if (!path.startsWith(workspacePaths.rootDir)) {
        throw new Error("Artifact path must be inside the workspace harness directory.");
      }

      return JSON.parse(await readFile(path, "utf8"));
    }
    case "harness_approve_plan": {
      const runId = String(args.runId ?? "");
      const path = await submitApproval({
        runId,
        decision: "approved",
        artifactStore,
      });
      return { runId, decision: "approved", path };
    }
    case "harness_reject_plan": {
      const runId = String(args.runId ?? "");
      const feedback = args.feedback ? String(args.feedback) : undefined;
      const path = await submitApproval({
        runId,
        decision: "rejected",
        feedback,
        artifactStore,
      });
      return { runId, decision: "rejected", feedback, path };
    }
    case "project_create": {
      const channelStore = new ChannelStore(undefined, getHarnessStore());
      const workspaceId = buildWorkspaceId(workspaceRoot);
      const name = String(args.name ?? "");
      const description = String(args.description ?? name);
      const channel = await channelStore.createChannel({
        name,
        description,
        workspaceIds: [workspaceId],
      });
      await channelStore.postEntry(channel.channelId, {
        type: "status_update",
        fromAgentId: null,
        fromDisplayName: "Orchestrator",
        content: `Project "${name}" created.`,
        metadata: { workspaceId },
      });
      return {
        projectId: channel.channelId,
        channelId: channel.channelId,
        name: channel.name,
        description: channel.description,
        workspaceId,
      };
    }
    case "harness_dispatch": {
      const featureRequest = String(args.featureRequest ?? "");
      if (!featureRequest) throw new Error("featureRequest is required");
      const channelId = args.channelId ? String(args.channelId) : undefined;
      const result = await dispatch({
        featureRequest,
        repoPath: workspaceRoot,
        channelId,
      });
      return result;
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

class StdioJsonRpcTransport {
  private buffer = Buffer.alloc(0);

  constructor(
    private readonly handler: (message: JsonRpcMessage) => Promise<JsonRpcMessage | null>
  ) {}

  start(): void {
    process.stdin.on("data", async (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      await this.processBuffer();
    });
  }

  private async processBuffer(): Promise<void> {
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");

      if (headerEnd === -1) {
        return;
      }

      const header = this.buffer.slice(0, headerEnd).toString("utf8");
      const match = header.match(/Content-Length:\s*(\d+)/i);

      if (!match) {
        throw new Error("Missing Content-Length header.");
      }

      const contentLength = Number(match[1]);
      const messageStart = headerEnd + 4;
      const messageEnd = messageStart + contentLength;

      if (this.buffer.length < messageEnd) {
        return;
      }

      const raw = this.buffer.slice(messageStart, messageEnd).toString("utf8");
      this.buffer = this.buffer.slice(messageEnd);

      const response = await this.handler(JSON.parse(raw) as JsonRpcMessage);

      if (response) {
        this.send(response);
      }
    }
  }

  private send(message: JsonRpcMessage): void {
    const payload = JSON.stringify(message);
    const header = `Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n`;
    process.stdout.write(header + payload);
  }
}
