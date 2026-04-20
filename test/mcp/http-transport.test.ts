import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startHttpMcpServer } from "../../src/mcp/http-transport.js";
import type { JsonRpcMessage, McpMessageHandler } from "../../src/mcp/server.js";

/**
 * Stub handler that mimics the shape of the real MCP handler. Keeps the test
 * focused on transport behaviour (SSE framing, auth, shutdown) rather than the
 * tool surface, which is exercised elsewhere.
 */
function stubHandler(): { handler: McpMessageHandler; cleanup: () => void } {
  const handler: McpMessageHandler = async (message) => {
    if (message.method === "initialize") {
      return {
        jsonrpc: "2.0",
        id: message.id ?? null,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "relay-test", version: "0.0.0" }
        }
      };
    }
    return {
      jsonrpc: "2.0",
      id: message.id ?? null,
      error: { code: -32601, message: `Method not found: ${message.method}` }
    };
  };
  return { handler, cleanup: () => {} };
}

/**
 * Open an SSE stream against the server and resolve to a parser that yields
 * `{event, data}` frames one at a time.
 */
async function openSse(
  url: string,
  authToken?: string
): Promise<{
  response: Response;
  readFrame: () => Promise<{ event: string; data: string } | null>;
  close: () => void;
}> {
  const headers: Record<string, string> = {};
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
  const controller = new AbortController();

  const response = await fetch(url, { headers, signal: controller.signal });
  if (!response.body) {
    return {
      response,
      readFrame: async () => null,
      close: () => controller.abort()
    };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const readFrame = async (): Promise<{ event: string; data: string } | null> => {
    while (true) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary !== -1) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const lines = raw.split("\n");
        let event = "message";
        const dataLines: string[] = [];
        for (const line of lines) {
          if (line.startsWith(":")) continue; // comment / keep-alive
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
        }
        if (dataLines.length === 0) continue;
        return { event, data: dataLines.join("\n") };
      }
      const { value, done } = await reader.read();
      if (done) return null;
      buffer += decoder.decode(value, { stream: true });
    }
  };

  return {
    response,
    readFrame,
    close: () => {
      try {
        reader.cancel().catch(() => {});
      } finally {
        controller.abort();
      }
    }
  };
}

describe("startHttpMcpServer", () => {
  let handle: Awaited<ReturnType<typeof startHttpMcpServer>> | null = null;

  beforeEach(() => {
    handle = null;
  });

  afterEach(async () => {
    if (handle) {
      await handle.stop();
      handle = null;
    }
  });

  it("serves the SSE endpoint and dispatches a JSON-RPC initialize", async () => {
    handle = await startHttpMcpServer(async () => stubHandler(), { port: 0 });

    const sse = await openSse(handle.url);
    expect(sse.response.status).toBe(200);
    expect(sse.response.headers.get("content-type")).toContain("text/event-stream");

    const endpointFrame = await sse.readFrame();
    expect(endpointFrame?.event).toBe("endpoint");
    const messagePath = endpointFrame?.data ?? "";
    expect(messagePath).toMatch(/^\/message\?sessionId=/);

    const postRes = await fetch(`http://${handle.host}:${handle.port}${messagePath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {}
      })
    });
    expect(postRes.status).toBe(202);
    // Drain the body so fetch/undici doesn't leak the socket into the next tick.
    await postRes.text();

    const messageFrame = await sse.readFrame();
    expect(messageFrame?.event).toBe("message");
    const payload = JSON.parse(messageFrame?.data ?? "{}") as JsonRpcMessage;
    expect(payload.id).toBe(1);
    expect((payload.result as { serverInfo?: { name?: string } })?.serverInfo?.name).toBe("relay-test");

    sse.close();
  });

  it("rejects /sse when the auth token is missing", async () => {
    handle = await startHttpMcpServer(async () => stubHandler(), {
      port: 0,
      authToken: "secret"
    });

    const response = await fetch(handle.url);
    expect(response.status).toBe(401);
    await response.text();
  });

  it("rejects /sse when the auth token is wrong", async () => {
    handle = await startHttpMcpServer(async () => stubHandler(), {
      port: 0,
      authToken: "secret"
    });

    const response = await fetch(handle.url, {
      headers: { Authorization: "Bearer wrong" }
    });
    expect(response.status).toBe(401);
    await response.text();
  });

  it("accepts /sse with the correct bearer token", async () => {
    handle = await startHttpMcpServer(async () => stubHandler(), {
      port: 0,
      authToken: "secret"
    });

    const sse = await openSse(handle.url, "secret");
    expect(sse.response.status).toBe(200);
    const endpointFrame = await sse.readFrame();
    expect(endpointFrame?.event).toBe("endpoint");
    sse.close();
  });

  it("stops cleanly — subsequent requests fail", async () => {
    handle = await startHttpMcpServer(async () => stubHandler(), { port: 0 });
    const url = handle.url;
    await handle.stop();
    handle = null;

    await expect(fetch(url)).rejects.toThrow();
  });
});
