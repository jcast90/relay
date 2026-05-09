import { describe, expect, it } from "vitest";

import { processStreamLine, type StreamParseState } from "../../src/agents/process-stream-line.js";

/**
 * RED tests for the Claude streaming-usage extraction. PR-1 ships the
 * stub-throwing `processStreamLine`; PR-2 (Task 3) lifts the existing
 * closure body in `cli-agents.ts::invokeStreaming` into this function
 * and adds the `obj.usage` capture on the `result` arm.
 */
describe("processStreamLine — Claude streaming usage capture", () => {
  function freshState(): StreamParseState {
    return { accumText: "", resultText: null, capturedUsage: null };
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
});
