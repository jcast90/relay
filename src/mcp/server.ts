import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { LocalArtifactStore } from "../execution/artifact-store.js";
import { readWorkspaceSummary } from "../cli/workspace.js";

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
  const artifactStore = new LocalArtifactStore(
    `${workspaceRoot}/.agent-harness/artifacts`
  );
  const transport = new StdioJsonRpcTransport((message) =>
    handleMessage(message, workspaceRoot, artifactStore)
  );

  transport.start();
}

async function handleMessage(
  message: JsonRpcMessage,
  workspaceRoot: string,
  artifactStore: LocalArtifactStore
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
            }
          ]
        }
      };
    case "tools/call":
      try {
        return {
          jsonrpc: "2.0",
          id: message.id ?? null,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  await callTool(
                    String(message.params?.name ?? ""),
                    (message.params?.arguments as Record<string, unknown> | undefined) ?? {},
                    workspaceRoot,
                    artifactStore
                  ),
                  null,
                  2
                )
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
    case "harness_get_artifact": {
      const inputPath = String(args.path ?? "");
      const path = isAbsolute(inputPath)
        ? inputPath
        : resolve(workspaceRoot, inputPath);

      if (!path.startsWith(`${workspaceRoot}/.agent-harness/`)) {
        throw new Error("Artifact path must be inside the current workspace harness directory.");
      }

      return JSON.parse(await readFile(path, "utf8"));
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
