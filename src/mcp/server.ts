import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import {
  createPrLifecycle,
  advancePrStage,
  canTransition,
  type PrStage
} from "../domain/pr-lifecycle.js";
import { LocalArtifactStore } from "../execution/artifact-store.js";
import { submitApproval } from "../orchestrator/approval-gate.js";
import { getHarnessWorkspacePaths, readWorkspaceSummary } from "../cli/workspace.js";
import { CrosslinkStore } from "../crosslink/store.js";
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
    handleMessage(message, workspaceRoot, artifactStore, crosslinkState)
  );

  transport.start();
}

async function handleMessage(
  message: JsonRpcMessage,
  workspaceRoot: string,
  artifactStore: LocalArtifactStore,
  crosslinkState: CrosslinkToolState
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
                  limit: {
                    type: "integer",
                    minimum: 1,
                    maximum: 50
                  }
                }
              }
            },
            {
              name: "harness_get_run",
              description: "Get one run entry and its phase ledger by run id.",
              inputSchema: {
                type: "object",
                additionalProperties: false,
                required: ["runId"],
                properties: {
                  runId: {
                    type: "string"
                  }
                }
              }
            },
            {
              name: "harness_get_run_detail",
              description: "Get full run snapshot including evidence, artifacts, and event log.",
              inputSchema: {
                type: "object",
                additionalProperties: false,
                required: ["runId"],
                properties: {
                  runId: {
                    type: "string"
                  },
                  includeEvents: {
                    type: "boolean",
                    description: "Include the full event log. Defaults to false."
                  }
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
                  path: {
                    type: "string"
                  }
                }
              }
            },
            {
              name: "harness_get_classification",
              description: "Get the classification result (complexity tier) for a run.",
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
              name: "harness_list_tickets",
              description: "List all tickets and their status for a run.",
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
              name: "harness_get_ticket",
              description: "Get detailed status of a specific ticket in a run.",
              inputSchema: {
                type: "object",
                additionalProperties: false,
                required: ["runId", "ticketId"],
                properties: {
                  runId: { type: "string" },
                  ticketId: { type: "string" }
                }
              }
            },
            {
              name: "harness_ticket_status",
              description: "Get a summary of ticket execution progress (counts by status).",
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
              description: "Reject the pending plan for a run with optional feedback. Triggers re-planning.",
              inputSchema: {
                type: "object",
                additionalProperties: false,
                required: ["runId"],
                properties: {
                  runId: { type: "string" },
                  feedback: { type: "string" }
                }
              }
            },
            {
              name: "harness_pr_status",
              description: "Get the PR lifecycle status for a run.",
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
              name: "harness_pr_create",
              description: "Initialize PR lifecycle tracking for a run. Call this after creating a branch.",
              inputSchema: {
                type: "object",
                additionalProperties: false,
                required: ["runId", "branch"],
                properties: {
                  runId: { type: "string" },
                  branch: { type: "string" },
                  baseBranch: { type: "string" }
                }
              }
            },
            {
              name: "harness_pr_advance",
              description: "Advance the PR lifecycle to the next stage (e.g. commits_pushed, pr_opened, checks_passed, merged).",
              inputSchema: {
                type: "object",
                additionalProperties: false,
                required: ["runId", "stage"],
                properties: {
                  runId: { type: "string" },
                  stage: {
                    type: "string",
                    enum: [
                      "branch_created",
                      "commits_pushed",
                      "pr_opened",
                      "checks_running",
                      "checks_passed",
                      "checks_failed",
                      "review_requested",
                      "changes_requested",
                      "approved",
                      "merged",
                      "closed"
                    ]
                  },
                  prNumber: { type: "string" },
                  prUrl: { type: "string" }
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
      return {
        workspaceRoot,
        runs: runs.slice(0, limit)
      };
    }
    case "harness_get_run": {
      const runs = await artifactStore.readRunsIndex();
      const runId = String(args.runId ?? "");
      const run = runs.find((entry) => entry.runId === runId);

      if (!run) {
        throw new Error(`Run not found: ${runId}`);
      }

      const phaseLedger = run.phaseLedgerPath
        ? JSON.parse(await readFile(run.phaseLedgerPath, "utf8"))
        : null;

      return {
        run,
        phaseLedger
      };
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

      return {
        ...snapshot,
        events
      };
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
    case "harness_get_classification": {
      const runId = String(args.runId ?? "");
      const snapshot = await artifactStore.readRunSnapshot(runId);

      if (!snapshot) {
        throw new Error(`Run not found: ${runId}`);
      }

      return {
        runId,
        classification: snapshot.classification ?? null
      };
    }
    case "harness_list_tickets": {
      const runId = String(args.runId ?? "");
      const tickets = await artifactStore.readTicketLedger(runId);

      return {
        runId,
        tickets: tickets ?? [],
        count: tickets?.length ?? 0
      };
    }
    case "harness_get_ticket": {
      const runId = String(args.runId ?? "");
      const ticketId = String(args.ticketId ?? "");
      const tickets = await artifactStore.readTicketLedger(runId);
      const ticket = tickets?.find((t) => t.ticketId === ticketId);

      if (!ticket) {
        throw new Error(`Ticket not found: ${ticketId} in run ${runId}`);
      }

      return ticket;
    }
    case "harness_ticket_status": {
      const runId = String(args.runId ?? "");
      const tickets = await artifactStore.readTicketLedger(runId);

      if (!tickets || tickets.length === 0) {
        return { runId, total: 0, byStatus: {} };
      }

      const byStatus: Record<string, number> = {};

      for (const ticket of tickets) {
        byStatus[ticket.status] = (byStatus[ticket.status] ?? 0) + 1;
      }

      return {
        runId,
        total: tickets.length,
        byStatus
      };
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
    case "harness_pr_status": {
      const runId = String(args.runId ?? "");
      const lifecycle = await artifactStore.readPrLifecycle(runId);

      if (!lifecycle) {
        return { runId, status: "no_pr_lifecycle", message: "No PR lifecycle found for this run. Use harness_pr_create to start one." };
      }

      return lifecycle;
    }
    case "harness_pr_create": {
      const runId = String(args.runId ?? "");
      const branch = String(args.branch ?? "");
      const baseBranch = args.baseBranch ? String(args.baseBranch) : undefined;

      if (!runId || !branch) {
        throw new Error("runId and branch are required.");
      }

      const existing = await artifactStore.readPrLifecycle(runId);

      if (existing) {
        throw new Error(`PR lifecycle already exists for run ${runId}. Current stage: ${existing.currentStage}`);
      }

      const lifecycle = createPrLifecycle({ runId, branch, baseBranch });
      const path = await artifactStore.savePrLifecycle(lifecycle);

      return { ...lifecycle, path };
    }
    case "harness_pr_advance": {
      const runId = String(args.runId ?? "");
      const stage = String(args.stage ?? "") as PrStage;

      const lifecycle = await artifactStore.readPrLifecycle(runId);

      if (!lifecycle) {
        throw new Error(`No PR lifecycle found for run ${runId}.`);
      }

      if (!canTransition(lifecycle.currentStage, stage)) {
        throw new Error(`Cannot transition from ${lifecycle.currentStage} to ${stage}.`);
      }

      const details: Record<string, string> = {};

      if (args.prNumber) {
        details.prNumber = String(args.prNumber);
      }

      if (args.prUrl) {
        details.prUrl = String(args.prUrl);
      }

      const updated = advancePrStage(lifecycle, stage, details);
      await artifactStore.savePrLifecycle(updated);

      return updated;
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
