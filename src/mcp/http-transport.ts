import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
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

/**
 * Thrown by `readBody` when the POST body exceeds MAX_BYTES. Exported so the
 * outer request handler can distinguish it from other errors and map to 413
 * (Payload Too Large) instead of a generic 500.
 */
export class BodyTooLargeError extends Error {
  public readonly byteCount: number;
  public readonly limit: number;

  constructor(byteCount: number, limit: number) {
    super(`request body too large: ${byteCount} bytes exceeds ${limit} byte limit`);
    this.name = "BodyTooLargeError";
    this.byteCount = byteCount;
    this.limit = limit;
  }
}

interface SseSession {
  sessionId: string;
  response: ServerResponse;
  handler: McpMessageHandler;
  cleanup: () => void;
  /** Promises for in-flight POST handler invocations. Drained on stop(). */
  inflight: Set<Promise<unknown>>;
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
  // Loopback-by-default: MCP surface exposes sensitive tools (harness_dispatch,
  // plan approval). Opt-in to non-loopback via --host.
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
      if (error instanceof BodyTooLargeError) {
        // eslint-disable-next-line no-console
        console.warn(`[http-mcp] rejecting oversized body: ${error.message}`);
        if (!res.headersSent) {
          res.statusCode = 413;
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              error: "payload_too_large",
              error_detail: `body exceeded ${error.limit} byte limit (received ${error.byteCount} bytes)`
            })
          );
        } else {
          res.end();
        }
        return;
      }

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
    // Drain in-flight handler invocations across all sessions so their results
    // get a last chance to write to the SSE stream before we close it. Without
    // this, a SIGINT during an in-flight tool call silently drops the response.
    const inflight: Array<Promise<unknown>> = [];
    for (const session of sessions.values()) {
      for (const p of session.inflight) inflight.push(p);
    }
    if (inflight.length > 0) {
      await Promise.allSettled(inflight);
    }

    for (const session of sessions.values()) {
      try {
        session.cleanup();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.warn(`[http-mcp] session cleanup failed (sessionId=${session.sessionId}): ${msg}`);
      }
      try {
        session.response.end();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.warn(`[http-mcp] stream close failed (sessionId=${session.sessionId}): ${msg}`);
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
  // Check auth before upgrading the SSE stream to avoid leaking the
  // session-endpoint frame to unauthenticated clients; also re-check on POST
  // because sessionId alone is not a credential.
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

  // 25s beats common proxy idle timeouts (nginx default 60s, CDNs ~30s) to
  // prevent connection drops on long-lived SSE streams.
  const keepAlive = setInterval(() => {
    try {
      res.write(`: keep-alive\n\n`);
    } catch (err) {
      // If this fires it likely means the client disconnected; the session
      // close handler below will tear down state shortly. Logging is still
      // useful for diagnosing unexpected write failures.
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.warn(`[http-mcp] keep-alive write failed (sessionId=${sessionId}): ${msg}`);
    }
  }, 25_000);

  const sessionCleanup = (): void => {
    clearInterval(keepAlive);
    sessions.delete(sessionId);
    cleanup();
  };

  const session: SseSession = {
    sessionId,
    response: res,
    handler,
    cleanup: sessionCleanup,
    inflight: new Set()
  };
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
  // Re-check auth on POST even though the SSE endpoint already checked it:
  // sessionId alone is not a credential and must not be treated as one.
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
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.warn(`[http-mcp] invalid JSON body on POST /message: ${detail}`);
    respondJson(res, 400, { error: "invalid_json", error_detail: detail });
    return;
  }

  // MCP HTTP transport: ack the POST with 202 and push the response back
  // through the SSE stream so requests aren't bound to per-POST lifetimes.
  res.statusCode = 202;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ status: "accepted" }));

  // Track the handler promise so stop() can drain it. Removed on settle so the
  // set doesn't grow unbounded for long-lived sessions.
  const work = (async () => {
    try {
      const response = await session.handler(message);
      if (response) {
        writeSseMessage(session.response, response, sessionId);
      }
    } catch (error) {
      writeSseMessage(
        session.response,
        {
          jsonrpc: "2.0",
          id: message.id ?? null,
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : "Internal error"
          }
        },
        sessionId
      );
    }
  })();

  session.inflight.add(work);
  work.finally(() => {
    session.inflight.delete(work);
  });
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
  if (!compareTokens(provided, expected)) {
    respondJson(res, 401, { error: "unauthorized" });
    return false;
  }
  return true;
}

/**
 * Constant-time bearer-token compare. A naive `provided !== expected` leaks
 * the token bit-by-bit over slow / non-loopback links because JavaScript's
 * string comparison short-circuits on the first mismatching byte — an
 * attacker measures per-byte response latency and recovers the secret. We
 * compare in fixed time via `timingSafeEqual`, which requires equal-length
 * buffers (it throws otherwise — itself a side channel), so we guard with
 * an explicit length check first. The length check is unavoidable; an
 * attacker who can probe lengths still learns only the length, not the
 * bytes.
 */
export function compareTokens(provided: string, expected: string): boolean {
  const p = Buffer.from(provided, "utf8");
  const e = Buffer.from(expected, "utf8");
  if (p.length !== e.length) return false;
  return timingSafeEqual(p, e);
}

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function writeSseMessage(res: ServerResponse, message: JsonRpcMessage, sessionId: string): void {
  try {
    res.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.warn(`[http-mcp] SSE write failed on session ${sessionId}: ${msg}`);
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  // 1 MB generous headroom for large tool-call arguments; MCP messages are
  // typically <10 KB. Adjust if a real use case demands it.
  const MAX_BYTES = 1_000_000;

  for await (const chunk of req) {
    const buf = chunk instanceof Buffer ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > MAX_BYTES) {
      throw new BodyTooLargeError(total, MAX_BYTES);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}
