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
}

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
 * Process one stream-json line from a Claude invocation. Mutates `state` in
 * place — `accumText` accumulates assistant-message text blocks, `resultText`
 * is set on the final `result` event, and `capturedUsage` is set when the
 * `result` event carries a top-level `usage` block. Mid-stream
 * `assistant.message.usage` is intentionally ignored — only the final
 * `result` event is authoritative (pitfall #2 from research).
 *
 * `onLine` receives every raw line so callers can render tool-use activity
 * live. Lines that fail to parse as JSON, or don't match a recognized event
 * type, are forwarded to `onLine` and otherwise ignored.
 */
export function processStreamLine(
  line: string,
  state: StreamParseState,
  onLine: (line: string) => void
): void {
  if (!line) return;
  onLine(line);
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== "object") return;
  const obj = parsed as Record<string, unknown>;
  if (obj.type === "assistant") {
    const msg = obj.message as { content?: unknown } | undefined;
    const blocks = Array.isArray(msg?.content) ? msg?.content : null;
    if (!blocks) return;
    for (const block of blocks) {
      if (block && typeof block === "object") {
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string") {
          state.accumText += b.text;
        }
      }
    }
  } else if (obj.type === "result" && typeof obj.result === "string") {
    state.resultText = obj.result;
    if (obj.usage && typeof obj.usage === "object") {
      state.capturedUsage = normalizeClaudeUsage(obj.usage as Record<string, unknown>);
    }
  }
}
