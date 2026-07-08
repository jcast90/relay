import type { TokenUsage } from "../domain/agent.js";
import {
  normalizeClaudeUsage,
  processStreamLine,
  type StreamParseState,
} from "../agents/process-stream-line.js";

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
 *   2. **buffered json** (`claude … --output-format json`): a single JSON
 *      object with a top-level `usage` block.
 *
 * Returns `undefined` when neither shape yields usage (raw shell command,
 * Codex-writes-usage-to-a-file, or a truncated/garbled stream). Callers treat
 * `undefined` as "no cost signal for this run" — non-fatal, never thrown.
 */
export function extractUsageFromStdout(stdout: string): TokenUsage | undefined {
  if (!stdout) return undefined;

  // Path 1: stream-json. processStreamLine captures usage only off the
  // terminal `result` event, so partial streams simply yield null.
  const state: StreamParseState = { accumText: "", resultText: null, capturedUsage: null };
  let sawStreamLine = false;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Only stream-json lines are JSON objects; a raw command's stdout would
    // just be forwarded to the (no-op) onLine and ignored by the parser.
    sawStreamLine = true;
    processStreamLine(trimmed, state, () => {});
  }
  if (state.capturedUsage) return state.capturedUsage;

  // Path 2: buffered single-object JSON with a top-level usage block.
  if (sawStreamLine) {
    const usage = topLevelUsage(stdout);
    if (usage) return normalizeClaudeUsage(usage);
  }

  return undefined;
}

/**
 * Best-effort extraction of the model name from an agent child's buffered
 * stdout. Claude stream-json emits the model on the `system`/`init` event and
 * on each assistant message (`message.model`); the buffered `--output-format
 * json` body carries a top-level `model`. We scan line-by-line and return the
 * first string `model` we find (top-level or nested under `message`). Returns
 * `undefined` for raw commands / streams with no model — the call then bills
 * at $0 with the `[cost]` warning, never throws.
 */
export function extractModelFromStdout(stdout: string): string | undefined {
  if (!stdout) return undefined;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof obj.model === "string" && obj.model) return obj.model;
      const msg = obj.message as { model?: unknown } | undefined;
      if (msg && typeof msg.model === "string" && msg.model) return msg.model;
    } catch {
      // Non-JSON line — skip.
    }
  }
  return undefined;
}

/**
 * Parse the whole buffer as one JSON object and return its `usage` block if
 * present. Guards the parse so non-JSON stdout (the common case for a raw
 * shell command) returns undefined instead of throwing.
 */
function topLevelUsage(stdout: string): Record<string, unknown> | undefined {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const usage = parsed.usage;
    if (usage && typeof usage === "object") return usage as Record<string, unknown>;
  } catch {
    // Not a single JSON object (e.g. concatenated stream-json lines that
    // already failed path 1) — no buffered usage to extract.
  }
  return undefined;
}
