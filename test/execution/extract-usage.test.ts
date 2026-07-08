import { describe, expect, it } from "vitest";

import { extractUsageFromStdout } from "../../src/execution/extract-usage.js";

describe("extractUsageFromStdout", () => {
  it("extracts usage from a Claude stream-json result event", () => {
    const stdout = [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }),
      JSON.stringify({
        type: "result",
        result: "done",
        usage: {
          input_tokens: 1000,
          output_tokens: 200,
          cache_read_input_tokens: 300,
          cache_creation_input_tokens: 50,
        },
      }),
    ].join("\n");

    const usage = extractUsageFromStdout(stdout);
    // normalizeClaudeUsage folds cache into inputTokens (1000+300+50).
    expect(usage).toEqual({
      inputTokens: 1350,
      outputTokens: 200,
      cacheReadTokens: 300,
      cacheWriteTokens: 50,
    });
  });

  it("ignores mid-stream assistant usage and reads only the terminal result event", () => {
    const stdout = [
      JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 999999 } } }),
      JSON.stringify({
        type: "result",
        result: "ok",
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    ].join("\n");

    expect(extractUsageFromStdout(stdout)).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it("extracts usage from a buffered --output-format json body", () => {
    const stdout = JSON.stringify({
      result: "done",
      usage: { input_tokens: 42, output_tokens: 7 },
    });
    expect(extractUsageFromStdout(stdout)).toEqual({ inputTokens: 42, outputTokens: 7 });
  });

  it("returns undefined for raw non-JSON command output", () => {
    expect(extractUsageFromStdout("hello world\nsecond line\n")).toBeUndefined();
  });

  it("returns undefined for empty stdout", () => {
    expect(extractUsageFromStdout("")).toBeUndefined();
  });

  it("returns undefined when a JSON object carries no usage block", () => {
    expect(extractUsageFromStdout(JSON.stringify({ result: "no usage here" }))).toBeUndefined();
  });
});
