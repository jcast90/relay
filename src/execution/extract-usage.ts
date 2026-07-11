import type { TokenUsage } from "../domain/agent.js";
import {
  normalizeClaudeUsage,
  normalizeCodexUsage,
  processStreamLine,
  type StreamParseState,
} from "../agents/process-stream-line.js";

/**
 * What a child process's stdout told us about what it cost.
 *
 * `model` rides along with `usage` because usage alone is unpriceable:
 * {@link costUsd} needs a model to look up a rate, and `costUsd(undefined, …)`
 * returns 0. Capturing tokens and dropping the model bills every call at $0 —
 * the exact under-count this module exists to close.
 */
export interface ExtractedUsage {
  usage: TokenUsage;
  /** Dated model ID as the CLI reported it, e.g. `claude-sonnet-4-5-20250929`. */
  model?: string;
}

/**
 * Best-effort token-usage extraction from an agent child process's buffered
 * stdout. Lives here (not in the executor) so it can be unit-tested against
 * captured fixtures without spawning a process.
 *
 * The {@link LocalChildProcessExecutor} is agent-agnostic — it buffers raw
 * stdout and doesn't know whether it spawned `claude`, `codex`, or a bare
 * shell command. So we probe two shapes, both reusing the same normalizers
 * the dispatch-path adapter (`cli-agents.ts`) uses, and return the first hit:
 *
 *   1. **stream-json** (`claude … --output-format stream-json`): feed each
 *      line through {@link processStreamLine}; the authoritative usage rides
 *      the terminal `result` event (mid-stream `assistant.message.usage` is
 *      intentionally ignored — same pitfall #2 the adapter guards).
 *   2. **buffered json** (`claude … --output-format json`, or Codex's
 *      `response.json` shape): a single JSON object with a top-level `usage`.
 *
 * Returns `undefined` when neither shape yields usage (raw shell command,
 * Codex-writes-usage-to-a-file, or a truncated/garbled stream). Callers treat
 * `undefined` as "no cost signal for this run" — non-fatal, never thrown.
 */
export function extractUsageFromStdout(stdout: string): ExtractedUsage | undefined {
  if (!stdout) return undefined;

  // Path 1: stream-json. processStreamLine captures usage only off the
  // terminal `result` event, so partial streams simply yield null.
  const state: StreamParseState = {
    accumText: "",
    resultText: null,
    capturedUsage: null,
    capturedModel: null,
  };
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    processStreamLine(trimmed, state, () => {});
  }
  if (state.capturedUsage) {
    return build(state.capturedUsage, state.capturedModel ?? undefined);
  }

  // Path 2: buffered single-object JSON with a top-level usage block.
  const parsed = parseTopLevel(stdout);
  if (!parsed) return undefined;
  const usage = parsed.usage;
  if (!usage || typeof usage !== "object") return undefined;

  const block = usage as Record<string, unknown>;
  // Claude spells its cache field `cache_read_input_tokens`; Codex/OpenAI
  // spells it `cached_input_tokens`. Routing everything through the Claude
  // normalizer silently dropped Codex's cached tokens, so they billed as fresh
  // input at ~2.4x the true rate. Pick the normalizer from the shape we see.
  const normalized = isCodexUsage(block) ? normalizeCodexUsage(block) : normalizeClaudeUsage(block);
  const model = typeof parsed.model === "string" ? parsed.model : undefined;
  return build(normalized, model);
}

/**
 * Codex/OpenAI usage carries `cached_input_tokens`; Claude carries
 * `cache_read_input_tokens` / `cache_creation_input_tokens`. Key off the
 * distinctive field rather than guessing from which agent was spawned — the
 * executor genuinely doesn't know.
 */
function isCodexUsage(usage: Record<string, unknown>): boolean {
  return "cached_input_tokens" in usage;
}

/**
 * Drop an all-zero reading rather than reporting it.
 *
 * `num()` in the normalizers coerces every non-numeric field to 0, so ANY JSON
 * object with a top-level `usage` key — a config dump, an API response, tool
 * metadata — normalizes to `{inputTokens: 0, outputTokens: 0}` and sails past
 * the caller's `if (result.tokenUsage)` guard. That converts an honest "no cost
 * signal" into a confident "this run cost zero", and it suppresses the `[cost]`
 * warning that is supposed to make pricing gaps loud. A real agent call never
 * has zero input AND zero output.
 */
function build(usage: TokenUsage, model?: string): ExtractedUsage | undefined {
  if (usage.inputTokens === 0 && usage.outputTokens === 0) return undefined;
  return model ? { usage, model } : { usage };
}

/**
 * Parse the whole buffer as one JSON object. Guards the parse so non-JSON
 * stdout (the common case for a raw shell command) returns undefined instead
 * of throwing.
 */
function parseTopLevel(stdout: string): Record<string, unknown> | undefined {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
  } catch {
    // Not a single JSON object (e.g. concatenated stream-json lines that
    // already failed path 1) — no buffered usage to extract.
  }
  return undefined;
}
