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
import {
  callCoordinationTool,
  getCoordinationToolDefinitions,
  isCoordinationTool,
  type CoordinationToolState,
} from "./coordination-tools.js";
import type { Coordinator } from "../crosslink/coordinator.js";
import {
  allowlistForRole,
  denyToolEnvelope,
  isToolAllowedForRole,
  resolveCurrentRole,
  warnIfUnknownRole,
} from "./role-allowlist.js";
import { REPO_ADMIN_TOOL_STUBS, spawnWorkerStub } from "../agents/repo-admin.js";

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
  /**
   * AL-16 coordination tool state. Populated from
   * {@link McpHandlerOptions} at construction time. When the caller
   * wires a Coordinator + alias in, `coordination_send` routes through
   * the live bus. When either is absent, the tool surfaces a
   * structured error envelope (never a silent drop).
   */
  coordinationState: CoordinationToolState;
  cleanup: () => void;
}

/**
 * Optional wiring for the AL-16 coordination tool surface. When the MCP
 * server is constructed in-process (e.g. inside the autonomous-loop
 * driver's test harness, or in a future in-process MCP host for
 * repo-admin sessions), the caller passes the shared {@link Coordinator}
 * and the session's own admin alias here so `coordination_send` calls
 * route to a live bus instead of returning `coordinator-not-configured`.
 *
 * When the MCP server runs as a subprocess of the Claude CLI (the
 * default production path), the coordinator can't cross the process
 * boundary as a direct reference — the parent relays sends through a
 * separate IPC channel. This parameter is still populated there via an
 * in-parent bridge so the tool surface stays unified; subprocess
 * transports that have no bridge at all leave both fields null and the
 * tool surfaces a structured `coordinator-not-configured` error.
 */
export interface McpHandlerOptions {
  /** Per-run coordinator wired by the autonomous-loop driver. */
  coordinator?: Coordinator | null;
  /** Admin alias the enclosing session represents. */
  alias?: string | null;
}

/**
 * Build the JSON-RPC message handler + supporting state for an MCP server
 * instance. Shared between the stdio and HTTP/SSE transports so both paths
 * serve the same tool surface.
 *
 * When `options.coordinator` + `options.alias` are both provided, the
 * resulting handler's `coordination_send` dispatch routes through the
 * live bus. When either is absent, the tool returns a structured error
 * envelope identifying the missing piece — never a silent drop.
 */
export async function buildMcpMessageHandler(
  workspaceRoot: string,
  options: McpHandlerOptions = {}
): Promise<{ handler: McpMessageHandler; context: McpHandlerContext }> {
  // AL-11 (I1 fix): if RELAY_AGENT_ROLE is set to a value we don't recognise,
  // log a one-shot warning to stderr on startup. The allowlist fall-through
  // on unknown roles is still the documented behaviour (new roles opt IN by
  // adding a map entry), but an unrecognised value running with no
  // enforcement needs to be visible in logs — a silent typo shipping as
  // cosmetic security is the opposite of what this layer is for.
  warnIfUnknownRole(resolveCurrentRole());

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
  // AL-16: the server always constructs a coordination state so the
  // tool surface is stable. When the caller supplies a Coordinator
  // + alias (in-process path — autonomous-loop driver or integration
  // test), `coordination_send` routes through the live bus. Otherwise
  // both fields stay null and the tool returns a structured
  // `coordinator-not-configured` / `session-not-repo-admin` error
  // rather than throwing. Null-coercion below keeps the type contract
  // explicit — `undefined` and omitted both collapse to null.
  const coordinationState: CoordinationToolState = {
    alias: options.alias ?? process.env.RELAY_AGENT_ALIAS ?? null,
    coordinator: options.coordinator ?? null,
    // AL-16 IPC follow-up: when this server is spawned as a child
    // process (no in-process Coordinator ref), `coordination_send`
    // falls back to appending the outbox file at
    // `~/.relay/sessions/<sessionId>/coordination/`. Read the parent
    // autonomous-session id from RELAY_SESSION_ID; absent → the tool
    // returns a clear "coordinator-not-configured" error instead of
    // writing to a bogus path.
    sessionId: process.env.RELAY_SESSION_ID ?? null,
  };

  // Auto-register this session
  const agentProvider = (process.env.RELAY_PROVIDER ?? "unknown") as "claude" | "codex" | "unknown";
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
    handleMessage(
      message,
      workspaceRoot,
      artifactStore,
      crosslinkState,
      channelState,
      coordinationState
    );

  return {
    handler,
    context: {
      workspaceRoot,
      artifactStore,
      crosslinkState,
      channelState,
      coordinationState,
      cleanup,
    },
  };
}

export async function startMcpServer(
  workspaceRoot: string,
  options: McpHandlerOptions = {}
): Promise<void> {
  const { handler, context } = await buildMcpMessageHandler(workspaceRoot, options);

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
  channelState: ChannelToolState,
  coordinationState: CoordinationToolState
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
    case "tools/list": {
      // AL-11: when the session runs under a role (RELAY_AGENT_ROLE set),
      // the tools/list report is filtered to the role's allowlist. Unknown
      // or absent role returns the full set, preserving pre-AL-11 behavior.
      const role = resolveCurrentRole();
      const allowlist = allowlistForRole(role);
      const allTools: Array<{ name: string; description: string; inputSchema: unknown }> = [
        ...(getCrosslinkToolDefinitions() as Array<{
          name: string;
          description: string;
          inputSchema: unknown;
        }>),
        ...(getChannelToolDefinitions() as Array<{
          name: string;
          description: string;
          inputSchema: unknown;
        }>),
        ...(getCoordinationToolDefinitions() as Array<{
          name: string;
          description: string;
          inputSchema: unknown;
        }>),
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
        {
          // AL-11 declares the name; AL-14 fills in the handler. Advertised
          // here so the repo-admin capability report is stable from day one.
          name: "spawn_worker",
          description:
            "[STUB — implemented in AL-14] Spawn an ephemeral worker agent into an " +
            "isolated worktree to execute a ticket. Calling this today returns a " +
            "structured `stubbed` error that points at AL-14.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["ticketId", "specialty"],
            properties: {
              ticketId: { type: "string" },
              specialty: { type: "string" },
              rationale: { type: "string" },
            },
          },
        },
      ];

      const filteredTools = allowlist
        ? allTools.filter((tool) => allowlist.has(tool.name))
        : allTools;

      return {
        jsonrpc: "2.0",
        id: message.id ?? null,
        result: {
          tools: filteredTools,
        },
      };
    }
    case "tools/call":
      try {
        const toolName = String(message.params?.name ?? "");
        const toolArgs = (message.params?.arguments as Record<string, unknown> | undefined) ?? {};

        // AL-11: consult the per-role allowlist before dispatching. When a
        // role (e.g. repo-admin) is active and the tool isn't on its list,
        // return a STRUCTURED denial envelope (NOT a silent failure) so the
        // caller sees the reason and can choose a different path.
        const currentRole = resolveCurrentRole();
        if (currentRole && !isToolAllowedForRole(currentRole, toolName)) {
          const envelope = denyToolEnvelope(currentRole, toolName);
          return {
            jsonrpc: "2.0",
            id: message.id ?? null,
            result: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(envelope, null, 2),
                },
              ],
              isError: true,
            },
          };
        }

        // AL-11 stub: spawn_worker is in the repo-admin allowlist so the
        // capability surface is stable, but the actual handler lands in
        // AL-14. Call the stub so repo-admin sees the pending-capability
        // reason rather than an "unknown tool" error.
        if (toolName === "spawn_worker") {
          try {
            spawnWorkerStub(toolArgs);
          } catch (err) {
            return {
              jsonrpc: "2.0",
              id: message.id ?? null,
              result: {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(
                      {
                        error: "tool-stubbed",
                        tool: "spawn_worker",
                        reason:
                          err instanceof Error ? err.message : REPO_ADMIN_TOOL_STUBS.spawn_worker,
                        landsIn: "AL-14",
                      },
                      null,
                      2
                    ),
                  },
                ],
                isError: true,
              },
            };
          }
        }

        const toolResult = isCrosslinkTool(toolName)
          ? await callCrosslinkTool(toolName, toolArgs, crosslinkState)
          : isChannelTool(toolName)
            ? await callChannelTool(toolName, toolArgs, channelState)
            : isCoordinationTool(toolName)
              ? await callCoordinationTool(toolName, toolArgs, coordinationState)
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
