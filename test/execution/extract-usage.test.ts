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

    // normalizeClaudeUsage folds cache into inputTokens (1000+300+50).
    expect(extractUsageFromStdout(stdout)?.usage).toEqual({
      inputTokens: 1350,
      outputTokens: 200,
      cacheReadTokens: 300,
      cacheWriteTokens: 50,
    });
  });

  it("ignores mid-stream assistant usage and reads only the terminal result event", () => {
    const stdout = [
      JSON.stringify({
        type: "assistant",
        message: { content: [], usage: { input_tokens: 999, output_tokens: 999 } },
      }),
      JSON.stringify({
        type: "result",
        result: "ok",
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    ].join("\n");
    expect(extractUsageFromStdout(stdout)?.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it("extracts usage from a buffered --output-format json body", () => {
    const stdout = JSON.stringify({ usage: { input_tokens: 42, output_tokens: 7 } });
    expect(extractUsageFromStdout(stdout)?.usage).toEqual({ inputTokens: 42, outputTokens: 7 });
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

  // ── Regressions. Each of these silently produced a wrong number before. ──

  it("captures the model, so the usage is actually priceable", () => {
    // Without a model, costUsd(undefined, usage) returns 0 and every
    // executor-path call bills $0 — the exact under-count this module exists
    // to close.
    const stdout = [
      JSON.stringify({ type: "system", subtype: "init", model: "claude-sonnet-4-5-20250929" }),
      JSON.stringify({
        type: "result",
        result: "ok",
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    ].join("\n");

    const extracted = extractUsageFromStdout(stdout);
    expect(extracted?.model).toBe("claude-sonnet-4-5-20250929");
    expect(extracted?.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it("captures usage from an ERROR result event that carries no result string", () => {
    // `error_max_turns` / `error_during_execution` omit the `result` string but
    // DO carry usage — and they are the expensive runs. Gating usage capture on
    // `typeof obj.result === "string"` meant a runaway agent that burned real
    // money recorded exactly $0.
    const stdout = JSON.stringify({
      type: "result",
      subtype: "error_max_turns",
      is_error: true,
      model: "claude-opus-4-7-20250514",
      usage: {
        input_tokens: 400_000,
        output_tokens: 90_000,
        cache_read_input_tokens: 2_000_000,
      },
    });

    const extracted = extractUsageFromStdout(stdout);
    expect(extracted, "a runaway run that burned real money must not record as zero").toBeDefined();
    expect(extracted?.usage.outputTokens).toBe(90_000);
    expect(extracted?.usage.cacheReadTokens).toBe(2_000_000);
    expect(extracted?.model).toBe("claude-opus-4-7-20250514");
  });

  it("normalizes Codex usage with the Codex field names, not Claude's", () => {
    // Codex spells its cache field `cached_input_tokens`; Claude spells it
    // `cache_read_input_tokens`. Routing everything through the Claude
    // normalizer dropped the cached tokens, so they billed as fresh input at
    // ~2.4x the true rate.
    const stdout = JSON.stringify({
      usage: { input_tokens: 100_000, output_tokens: 5_000, cached_input_tokens: 90_000 },
    });

    expect(extractUsageFromStdout(stdout)?.usage).toEqual({
      // 10k fresh + 90k cached, folded per the inputTokens-includes-cache convention.
      inputTokens: 190_000,
      outputTokens: 5_000,
      cacheReadTokens: 90_000,
    });
  });

  it("returns undefined rather than fabricating a confident zero", () => {
    // Every numeric field coerces to 0, so ANY JSON with a top-level `usage`
    // key — a config dump, an API response — used to normalize to
    // {input: 0, output: 0} and sail past the caller's `if (result.tokenUsage)`
    // guard. That turns "no cost signal" into "this run cost zero", and
    // suppresses the [cost] warning meant to make pricing gaps loud.
    expect(extractUsageFromStdout(JSON.stringify({ usage: { foo: "bar" } }))).toBeUndefined();
    expect(
      extractUsageFromStdout(JSON.stringify({ usage: { input_tokens: 0, output_tokens: 0 } }))
    ).toBeUndefined();
  });
});
