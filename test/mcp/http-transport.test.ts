import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  BodyTooLargeError,
  compareTokens,
  startHttpMcpServer
} from "../../src/mcp/http-transport.js";
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

  it("returns 400 with error_detail when the POST body is not valid JSON", async () => {
    handle = await startHttpMcpServer(async () => stubHandler(), { port: 0 });

    const sse = await openSse(handle.url);
    const endpointFrame = await sse.readFrame();
    const messagePath = endpointFrame?.data ?? "";

    const postRes = await fetch(`http://${handle.host}:${handle.port}${messagePath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not valid json,"
    });
    expect(postRes.status).toBe(400);
    const body = (await postRes.json()) as { error?: string; error_detail?: string };
    expect(body.error).toBe("invalid_json");
    // The parser-emitted detail must be surfaced, not just a generic tag.
    expect(typeof body.error_detail).toBe("string");
    expect((body.error_detail ?? "").length).toBeGreaterThan(0);

    sse.close();
  });

  it("returns 413 (not 500) when the POST body exceeds the 1 MB cap", async () => {
    handle = await startHttpMcpServer(async () => stubHandler(), { port: 0 });

    const sse = await openSse(handle.url);
    const endpointFrame = await sse.readFrame();
    const messagePath = endpointFrame?.data ?? "";

    // 1.1 MB payload — safely above the 1 MB cap.
    const oversized = "x".repeat(1_100_000);
    const postRes = await fetch(`http://${handle.host}:${handle.port}${messagePath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "foo", params: { blob: oversized } })
    });
    expect(postRes.status).toBe(413);
    const body = (await postRes.json()) as { error?: string; error_detail?: string };
    expect(body.error).toBe("payload_too_large");
    expect(body.error_detail).toMatch(/byte limit/);

    sse.close();
  });

  it("drains in-flight handlers on stop() so responses are not silently dropped", async () => {
    // Handler blocks until we tell it to resolve; gives us a controllable
    // "in-flight" window to exercise the drain path.
    let release!: () => void;
    const handlerCall = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handler: McpMessageHandler = async (message) => {
      await handlerCall;
      return {
        jsonrpc: "2.0",
        id: message.id ?? null,
        result: { ok: true }
      };
    };

    const unhandled: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onRejection);

    try {
      handle = await startHttpMcpServer(
        async () => ({ handler, cleanup: () => {} }),
        { port: 0 }
      );

      const sse = await openSse(handle.url);
      const endpointFrame = await sse.readFrame();
      const messagePath = endpointFrame?.data ?? "";

      const postRes = await fetch(`http://${handle.host}:${handle.port}${messagePath}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 42, method: "slow", params: {} })
      });
      expect(postRes.status).toBe(202);
      await postRes.text();

      // Kick off stop() but release the handler mid-flight. stop() must wait
      // for the in-flight handler promise before the server closes.
      const stopPromise = handle.stop();
      // Give stop() a moment to start draining before we release the handler.
      await new Promise((resolve) => setTimeout(resolve, 25));
      release();
      await stopPromise;
      handle = null;

      // Give the event loop a tick to surface any rejection.
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).toEqual([]);

      sse.close();
    } finally {
      process.removeListener("unhandledRejection", onRejection);
    }
  });

  it("exports BodyTooLargeError with byteCount and limit for callers that need to disambiguate", () => {
    const err = new BodyTooLargeError(1_500_000, 1_000_000);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("BodyTooLargeError");
    expect(err.byteCount).toBe(1_500_000);
    expect(err.limit).toBe(1_000_000);
  });
});

describe("compareTokens", () => {
  it("returns true for byte-identical tokens", () => {
    expect(compareTokens("s3cret-token", "s3cret-token")).toBe(true);
  });

  it("returns false for tokens that differ in a single byte", () => {
    expect(compareTokens("s3cret-tokeN", "s3cret-token")).toBe(false);
  });

  it("returns false for tokens of different length without throwing", () => {
    // Guard against timingSafeEqual's different-length throw: the helper
    // short-circuits on length mismatch and returns false cleanly.
    expect(compareTokens("short", "much-longer-token")).toBe(false);
    expect(compareTokens("much-longer-token", "short")).toBe(false);
  });

  it("returns false when either side is empty", () => {
    expect(compareTokens("", "s3cret")).toBe(false);
    expect(compareTokens("s3cret", "")).toBe(false);
  });

  it("treats two empty strings as equal", () => {
    // `authorizeRequest` never calls compareTokens with an unset expected
    // token (the caller short-circuits on `!expected` first), so this case
    // is purely for the helper's own correctness.
    expect(compareTokens("", "")).toBe(true);
  });

  it("handles multibyte UTF-8 content correctly", () => {
    // Tokens could contain non-ASCII if a user decides to be creative; the
    // helper compares bytes, not code points, so the UTF-8 encoded length
    // is what matters for the mismatch short-circuit.
    const a = "tökén-\u{1F510}";
    const b = "tökén-\u{1F510}";
    expect(compareTokens(a, b)).toBe(true);
    expect(compareTokens(a, a + "x")).toBe(false);
  });
});
