import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { LocalArtifactStore } from "../execution/artifact-store.js";
import { submitApproval } from "../orchestrator/approval-gate.js";
import { getHarnessWorkspacePaths, readWorkspaceSummary } from "../cli/workspace.js";
import { CrosslinkStore } from "../crosslink/store.js";
import { ChannelStore } from "../channels/channel-store.js";
import {
  callChannelTool,
  getChannelToolDefinitions,
  isChannelTool,
  type ChannelToolState
} from "./channel-tools.js";
import {
  callCrosslinkTool,
  getCrosslinkToolDefinitions,
  isCrosslinkTool,
  type CrosslinkToolState
} from "../crosslink/tools.js";

interface JsonRpcMessage {
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

export async function startMcpServer(workspaceRoot: string): Promise<void> {
  const paths = getHarnessWorkspacePaths(workspaceRoot);
  const artifactStore = new LocalArtifactStore(paths.artifactsDir);
  const crosslinkStore = new CrosslinkStore();
  const crosslinkState: CrosslinkToolState = {
    sessionId: null,
    store: crosslinkStore
  };
  const channelStore = new ChannelStore();
  const channelState: ChannelToolState = {
    sessionId: null,
    channelStore
  };

  // Auto-register this session
  const agentProvider = (process.env.AGENT_HARNESS_PROVIDER ?? "unknown") as
    "claude" | "codex" | "unknown";
  const session = await crosslinkStore.registerSession({
    pid: process.pid,
    repoPath: workspaceRoot,
    description: `Agent session in ${workspaceRoot}`,
    capabilities: ["general"],
    agentProvider,
    status: "active"
  });
  crosslinkState.sessionId = session.sessionId;
  channelState.sessionId = session.sessionId;

  // Heartbeat every 30 seconds
  const heartbeatInterval = setInterval(() => {
    if (crosslinkState.sessionId) {
      crosslinkStore.updateHeartbeat(crosslinkState.sessionId).catch(() => {});
    }
  }, 30_000);

  // Cleanup on exit
  const cleanup = () => {
    clearInterval(heartbeatInterval);
    if (crosslinkState.sessionId) {
      crosslinkStore.deregisterSession(crosslinkState.sessionId).catch(() => {});
    }
  };

  process.on("exit", cleanup);
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });
  process.on("SIGINT", () => { cleanup(); process.exit(0); });

  const transport = new StdioJsonRpcTransport((message) =>
    handleMessage(message, workspaceRoot, artifactStore, crosslinkState, channelState)
  );

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
            tools: {}
          },
          serverInfo: {
            name: "agent-harness",
            version: "0.1.0"
          }
        }
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
              description: "Get Agent Harness workspace status and recent runs.",
              inputSchema: {
                type: "object",
                additionalProperties: false,
                properties: {}
              }
            },
            {
              name: "harness_list_runs",
              description: "List recent harness runs for the current workspace.",
              inputSchema: {
                type: "object",
                additionalProperties: false,
                properties: {
                  limit: { type: "integer", minimum: 1, maximum: 50 }
                }
              }
            },
            {
              name: "harness_get_run_detail",
              description: "Get full run snapshot including classification, tickets, evidence, artifacts, and optionally the event log.",
              inputSchema: {
                type: "object",
                additionalProperties: false,
                required: ["runId"],
                properties: {
                  runId: { type: "string" },
                  includeEvents: { type: "boolean" }
                }
              }
            },
            {
              name: "harness_get_artifact",
              description: "Read a harness artifact JSON file by absolute path.",
              inputSchema: {
                type: "object",
                additionalProperties: false,
                required: ["path"],
                properties: {
                  path: { type: "string" }
                }
              }
            },
            {
              name: "harness_approve_plan",
              description: "Approve the pending plan for a run, unblocking ticket execution.",
              inputSchema: {
                type: "object",
                additionalProperties: false,
                required: ["runId"],
                properties: {
                  runId: { type: "string" }
                }
              }
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
                  feedback: { type: "string" }
                }
              }
            }
          ]
        }
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
                text: JSON.stringify(toolResult, null, 2)
              }
            ],
            isError: false
          }
        };
      } catch (error) {
        return {
          jsonrpc: "2.0",
          id: message.id ?? null,
          result: {
            content: [
              {
                type: "text",
                text: error instanceof Error ? error.message : "Unknown MCP tool failure."
              }
            ],
            isError: true
          }
        };
      }
    default:
      return {
        jsonrpc: "2.0",
        id: message.id ?? null,
        error: {
          code: -32601,
          message: `Method not found: ${message.method}`
        }
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

      const events = includeEvents
        ? await artifactStore.readEventLog(runId)
        : [];

      return { ...snapshot, events };
    }
    case "harness_get_artifact": {
      const inputPath = String(args.path ?? "");
      const path = isAbsolute(inputPath)
        ? inputPath
        : resolve(workspacePaths.rootDir, inputPath);

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
        artifactStore
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
        artifactStore
      });
      return { runId, decision: "rejected", feedback, path };
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
