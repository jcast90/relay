import { describe, expect, it } from "vitest";

import { processStreamLine, type StreamParseState } from "../../src/agents/process-stream-line.js";

describe("processStreamLine — Claude streaming usage capture", () => {
  function freshState(): StreamParseState {
    return {
      accumText: "",
      resultText: null,
      capturedUsage: null,
      capturedModel: null,
      reportedCostUsd: null,
    };
  }

  it("captures `usage` from the `result` event with cache tokens summed into inputTokens", () => {
    const state = freshState();
    const line = JSON.stringify({
      type: "result",
      result: "ok",
      usage: {
        input_tokens: 1500,
        output_tokens: 250,
        cache_read_input_tokens: 3000,
      },
    });
    processStreamLine(line, state, () => {});
    expect(state.capturedUsage).toBeDefined();
    expect(state.capturedUsage?.inputTokens).toBe(1500 + 3000);
    expect(state.capturedUsage?.outputTokens).toBe(250);
    expect(state.capturedUsage?.cacheReadTokens).toBe(3000);
  });

  it("ignores mid-stream `assistant` events that carry usage (only `result` is authoritative)", () => {
    const state = freshState();
    const assistantLine = JSON.stringify({
      type: "assistant",
      message: { usage: { input_tokens: 999, output_tokens: 999 } },
    });
    processStreamLine(assistantLine, state, () => {});
    expect(state.capturedUsage).toBeNull();
  });

  it("captures `usage` even when cache_creation_input_tokens is present (sums into inputTokens)", () => {
    const state = freshState();
    const line = JSON.stringify({
      type: "result",
      result: "ok",
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 200,
      },
    });
    processStreamLine(line, state, () => {});
    expect(state.capturedUsage?.inputTokens).toBe(100 + 200);
    expect(state.capturedUsage?.cacheWriteTokens).toBe(200);
  });

  it("keeps the latest valid reported total cost without summing cumulative result events", () => {
    const state = freshState();

    processStreamLine(
      JSON.stringify({
        type: "result",
        total_cost_usd: 0.12,
        usage: { input_tokens: 10, output_tokens: 2 },
      }),
      state,
      () => {}
    );
    processStreamLine(
      JSON.stringify({
        type: "result",
        total_cost_usd: 0.2,
        usage: { input_tokens: 20, output_tokens: 4 },
      }),
      state,
      () => {}
    );

    expect(state.reportedCostUsd).toBe(0.2);
  });

  it("bounds retained assistant text when the caller configures a limit", () => {
    const state = { ...freshState(), maxAccumTextChars: 8 };

    processStreamLine(
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "0123456789" }] },
      }),
      state,
      () => {}
    );

    expect(state.accumText).toBe("23456789");
    expect(state.lastAssistantTextHash).toBeDefined();
  });

  it("retains a terminal result that is only a substring of earlier assistant text", () => {
    const state = { ...freshState(), maxAccumTextChars: 64 };

    processStreamLine(
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "Work already done earlier." }] },
      }),
      state,
      () => {}
    );
    const result = processStreamLine(
      JSON.stringify({ type: "result", result: "done" }),
      state,
      () => {}
    );

    expect(result).toEqual({ kind: "structured", assistantText: "done" });
  });

  it("does not repeat a terminal result that exactly matches the last assistant text", () => {
    const state = { ...freshState(), maxAccumTextChars: 8 };
    const text = "0123456789";

    processStreamLine(
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text }] },
      }),
      state,
      () => {}
    );
    const result = processStreamLine(
      JSON.stringify({ type: "result", result: text }),
      state,
      () => {}
    );

    expect(result).toEqual({ kind: "structured" });
  });

  it("bounds retained terminal result text when the caller configures a limit", () => {
    const state = { ...freshState(), maxAccumTextChars: 8 };

    const result = processStreamLine(
      JSON.stringify({ type: "result", result: "0123456789" }),
      state,
      () => {}
    );

    expect(state.resultText).toBe("23456789");
    expect(result).toEqual({ kind: "structured", assistantText: "0123456789" });
  });

  it("ignores unsafe token sums and provider totals", () => {
    const state = freshState();

    processStreamLine(JSON.stringify({ type: "result", total_cost_usd: 0.2 }), state, () => {});
    processStreamLine(
      JSON.stringify({
        type: "result",
        total_cost_usd: 1e308,
        usage: {
          input_tokens: Number.MAX_SAFE_INTEGER,
          cache_read_input_tokens: Number.MAX_SAFE_INTEGER,
          output_tokens: 0,
        },
      }),
      state,
      () => {}
    );

    expect(state.reportedCostUsd).toBe(0.2);
    expect(state.capturedUsage).toBeNull();
  });
});
