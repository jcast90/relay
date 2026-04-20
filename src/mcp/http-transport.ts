import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";

import type { JsonRpcMessage, McpMessageHandler } from "./server.js";

export interface HttpMcpServerOptions {
  port: number;
  host?: string;
  authToken?: string;
  workspaceId?: string;
}

export interface HttpMcpServerHandle {
  stop: () => Promise<void>;
  url: string;
  port: number;
  host: string;
}

interface SseSession {
  sessionId: string;
  response: ServerResponse;
  handler: McpMessageHandler;
  cleanup: () => void;
}

/**
 * Start an HTTP server that exposes an MCP endpoint over SSE.
 *
 * Protocol (mirrors the MCP SSE transport shipped by @modelcontextprotocol/sdk):
 *  - GET /sse — opens the SSE stream. The server sends an initial
 *    `event: endpoint\n data: /message?sessionId=...` frame so the client knows
 *    where to POST JSON-RPC requests for this session.
 *  - POST /message?sessionId=... — accepts a single JSON-RPC message. Responses
 *    are delivered back over the SSE stream as `event: message` frames.
 *
 * Each incoming GET /sse builds its own McpMessageHandler via `buildHandler`,
 * so each client gets an isolated MCP session.
 */
export async function startHttpMcpServer(
  buildHandler: () => Promise<{ handler: McpMessageHandler; cleanup: () => void }>,
  opts: HttpMcpServerOptions
): Promise<HttpMcpServerHandle> {
  const host = opts.host ?? "127.0.0.1";
  const sessions = new Map<string, SseSession>();

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

      if (req.method === "GET" && url.pathname === "/sse") {
        await handleSse(req, res, url, sessions, buildHandler, opts);
        return;
      }

      if (req.method === "POST" && url.pathname === "/message") {
        await handleMessagePost(req, res, url, sessions, opts);
        return;
      }

      res.statusCode = 404;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "not_found", path: url.pathname }));
    } catch (error) {
      // Defensive: never leak a stack trace to a remote client, but keep a
      // trace on the server side.
      // eslint-disable-next-line no-console
      console.error("[rly serve] request failed:", error);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "internal_error" }));
      } else {
        res.end();
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : opts.port;

  const stop = async (): Promise<void> => {
    for (const session of sessions.values()) {
      try {
        session.cleanup();
      } catch {
        // best-effort
      }
      try {
        session.response.end();
      } catch {
        // best-effort
      }
    }
    sessions.clear();

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // Force-close any idle keep-alive sockets so close() resolves promptly.
      const maybeCloseAll = (server as Server & { closeAllConnections?: () => void }).closeAllConnections;
      if (typeof maybeCloseAll === "function") {
        maybeCloseAll.call(server);
      }
    });
  };

  return {
    stop,
    url: `http://${host}:${boundPort}/sse`,
    port: boundPort,
    host
  };
}

async function handleSse(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  sessions: Map<string, SseSession>,
  buildHandler: () => Promise<{ handler: McpMessageHandler; cleanup: () => void }>,
  opts: HttpMcpServerOptions
): Promise<void> {
  if (!authorizeRequest(req, res, opts.authToken)) return;

  const sessionId = randomUUID();
  const { handler, cleanup } = await buildHandler();

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (opts.workspaceId) {
    res.setHeader("X-Relay-Workspace", opts.workspaceId);
  }
  res.flushHeaders?.();

  const messagePath = `/message?sessionId=${encodeURIComponent(sessionId)}`;
  res.write(`event: endpoint\ndata: ${messagePath}\n\n`);

  const keepAlive = setInterval(() => {
    try {
      res.write(`: keep-alive\n\n`);
    } catch {
      // Socket likely closed; session cleanup handles teardown.
    }
  }, 25_000);

  const sessionCleanup = (): void => {
    clearInterval(keepAlive);
    sessions.delete(sessionId);
    cleanup();
  };

  const session: SseSession = { sessionId, response: res, handler, cleanup: sessionCleanup };
  sessions.set(sessionId, session);

  req.on("close", () => {
    sessionCleanup();
  });
  req.on("error", () => {
    sessionCleanup();
  });
}

async function handleMessagePost(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  sessions: Map<string, SseSession>,
  opts: HttpMcpServerOptions
): Promise<void> {
  if (!authorizeRequest(req, res, opts.authToken)) return;

  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) {
    respondJson(res, 400, { error: "missing_session_id" });
    return;
  }

  const session = sessions.get(sessionId);
  if (!session) {
    respondJson(res, 404, { error: "unknown_session" });
    return;
  }

  const raw = await readBody(req);
  let message: JsonRpcMessage;
  try {
    message = JSON.parse(raw) as JsonRpcMessage;
  } catch {
    respondJson(res, 400, { error: "invalid_json" });
    return;
  }

  // MCP HTTP transport: ack the POST with 202 and push the response back
  // through the SSE stream so requests aren't bound to per-POST lifetimes.
  res.statusCode = 202;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ status: "accepted" }));

  try {
    const response = await session.handler(message);
    if (response) {
      writeSseMessage(session.response, response);
    }
  } catch (error) {
    writeSseMessage(session.response, {
      jsonrpc: "2.0",
      id: message.id ?? null,
      error: {
        code: -32603,
        message: error instanceof Error ? error.message : "Internal error"
      }
    });
  }
}

function authorizeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expected: string | undefined
): boolean {
  if (!expected) return true;

  const header = req.headers["authorization"];
  if (typeof header !== "string" || !header.startsWith("Bearer ")) {
    respondJson(res, 401, { error: "unauthorized" });
    return false;
  }
  const provided = header.slice("Bearer ".length).trim();
  if (provided !== expected) {
    respondJson(res, 401, { error: "unauthorized" });
    return false;
  }
  return true;
}

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function writeSseMessage(res: ServerResponse, message: JsonRpcMessage): void {
  try {
    res.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
  } catch {
    // Stream likely gone; the close handler will clean up.
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  const MAX_BYTES = 1_000_000; // 1 MB guard against runaway POSTs.

  for await (const chunk of req) {
    const buf = chunk instanceof Buffer ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > MAX_BYTES) {
      throw new Error("request body too large");
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}
