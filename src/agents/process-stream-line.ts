import type { TokenUsage } from "../domain/agent.js";

/**
 * Mutable state passed between successive `processStreamLine` calls during
 * a Claude streaming invocation. Lives in `src/agents/` as a dedicated
 * module so the adapter (`cli-agents.ts`) can `import { processStreamLine
 * } from "./process-stream-line.js"` without growing the monolithic
 * adapter file.
 */
export interface StreamParseState {
  accumText: string;
  resultText: string | null;
  capturedUsage: TokenUsage | null;
  /**
   * The model the CLI reports it actually ran, as a dated ID
   * (`claude-sonnet-4-5-20250929`). Usage without a model is unpriceable —
   * `costUsd(undefined, usage)` returns 0 — so capturing tokens and dropping
   * the model bills every call at $0. Read off the `system` init event, with
   * `assistant` / `result` events as fallbacks.
   */
  capturedModel: string | null;
  reportedCostUsd: number | null;
}

export type ProcessedStreamLine =
  | { kind: "diagnostic"; text: string }
  | { kind: "structured"; assistantText?: string };

/**
 * Coerce an unknown value to a non-negative integer. Non-finite / non-numeric
 * inputs collapse to 0 — the adapter never throws on a malformed `usage` block
 * because missing usage is non-fatal for callers (Task 3 contract).
 */
function num(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return Math.trunc(value);
}

/**
 * Normalize Claude's per-call `usage` payload into Relay's provider-agnostic
 * {@link TokenUsage}. Cache-read and cache-creation tokens are summed into
 * `inputTokens` (research Q3 — cache occupies the context window so it
 * counts against the bar) and surfaced separately for forensics. Treats the
 * payload as opaque key/value soup — every numeric field defaults to 0 if
 * missing or malformed.
 */
export function normalizeClaudeUsage(usage: Record<string, unknown>): TokenUsage {
  const input = num(usage.input_tokens);
  const cacheRead = num(usage.cache_read_input_tokens);
  const cacheWrite = num(usage.cache_creation_input_tokens);
  const result: TokenUsage = {
    inputTokens: input + cacheRead + cacheWrite,
    outputTokens: num(usage.output_tokens),
  };
  if (cacheRead > 0) result.cacheReadTokens = cacheRead;
  if (cacheWrite > 0) result.cacheWriteTokens = cacheWrite;
  return result;
}

/**
 * Normalize Codex's `response.json` `usage` block (Branch A from the A1
 * spike). Mirrors {@link normalizeClaudeUsage} but for the OpenAI/Codex field
 * names — `cached_input_tokens` is the cache-hit accounting field. Cached
 * tokens still occupy the context window, so they sum into `inputTokens` (same
 * convention as the Claude path).
 *
 * Lives here beside {@link normalizeClaudeUsage}, rather than private to the
 * adapter, because the executor path has to choose between the two by
 * inspecting the payload — it genuinely doesn't know which CLI it spawned.
 */
export function normalizeCodexUsage(usage: Record<string, unknown>): TokenUsage {
  const input = num(usage.input_tokens);
  const cached = num(usage.cached_input_tokens);
  const result: TokenUsage = {
    inputTokens: input + cached,
    outputTokens: num(usage.output_tokens),
  };
  if (cached > 0) result.cacheReadTokens = cached;
  return result;
}

/**
 * Process one stream-json line from a Claude invocation. Mutates `state` in
 * place — `accumText` accumulates assistant-message text blocks, `resultText`
 * is set on the final `result` event, `capturedUsage` is set when the `result`
 * event carries a top-level `usage` block, and `capturedModel` records the
 * model the CLI resolved. Mid-stream `assistant.message.usage` is intentionally
 * ignored — only the final `result` event is authoritative (pitfall #2 from
 * research).
 *
 * `onLine` receives every raw line so callers can render tool-use activity
 * live. Lines that fail to parse as JSON, or don't match a recognized event
 * type, are forwarded to `onLine` and otherwise ignored.
 */
export function processStreamLine(
  line: string,
  state: StreamParseState,
  onLine: (line: string) => void
): ProcessedStreamLine {
  if (!line) return { kind: "diagnostic", text: line };
  onLine(line);
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { kind: "diagnostic", text: line };
  }
  if (!parsed || typeof parsed !== "object") return { kind: "structured" };
  const obj = parsed as Record<string, unknown>;
  if (obj.type === "system") {
    // The init event names the model the CLI resolved — the first and most
    // reliable place it appears. The arms below are fallbacks.
    if (typeof obj.model === "string") state.capturedModel ??= obj.model;
  } else if (obj.type === "assistant") {
    const msg = obj.message as { content?: unknown; model?: unknown } | undefined;
    if (typeof msg?.model === "string") state.capturedModel ??= msg.model;
    const blocks = Array.isArray(msg?.content) ? msg?.content : null;
    if (!blocks) return { kind: "structured" };
    let assistantText = "";
    for (const block of blocks) {
      if (block && typeof block === "object") {
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string") {
          state.accumText += b.text;
          assistantText += b.text;
        }
      }
    }
    return assistantText ? { kind: "structured", assistantText } : { kind: "structured" };
  } else if (obj.type === "result") {
    // Deliberately NOT gated on `typeof obj.result === "string"`. Claude's
    // error subtypes (`error_max_turns`, `error_during_execution`) omit the
    // `result` string but DO carry `usage` — and those are the expensive runs.
    // Gating usage capture on the text meant a runaway agent that burned $12
    // recorded exactly $0.
    if (typeof obj.result === "string") state.resultText = obj.result;
    if (typeof obj.model === "string") state.capturedModel ??= obj.model;
    if (
      typeof obj.total_cost_usd === "number" &&
      Number.isFinite(obj.total_cost_usd) &&
      obj.total_cost_usd >= 0
    ) {
      state.reportedCostUsd = obj.total_cost_usd;
    }
    if (obj.usage && typeof obj.usage === "object") {
      const usage = normalizeClaudeUsage(obj.usage as Record<string, unknown>);
      if (usage.inputTokens > 0 || usage.outputTokens > 0) {
        state.capturedUsage = usage;
      }
    }
    if (typeof obj.result === "string" && !state.accumText.includes(obj.result)) {
      return { kind: "structured", assistantText: obj.result };
    }
  }
  return { kind: "structured" };
}
