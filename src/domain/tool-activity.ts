/**
 * Shared tool-use activity model for the CLI streaming renderer.
 *
 * The GUI (gui/src-tauri/src/lib.rs) and the TUI (tui/src/main.rs) already
 * ship an identical Rust implementation in `crates/harness-data/src/tool_activity.rs`.
 * This module is the TypeScript mirror — add new tool cases to both sides so
 * the three surfaces stay in sync (OSS-06 parity contract).
 */

/** Max entries retained in the activity stack. Matches the Rust/GUI cap. */
export const ACTIVITY_STACK_MAX = 20;

/** Default number of newest entries shown when the stack is collapsed. */
export const ACTIVITY_TOP_N = 3;

export interface ToolActivityEntry {
  /** Short human-readable description (e.g. "Reading foo.ts" or "$ pnpm test"). */
  text: string;
  /** Unix epoch milliseconds at the time the event arrived. */
  ts: number;
}

/**
 * Build a skimmable one-liner describing a Claude `tool_use` block. The
 * output format deliberately mirrors the Rust side — keep them aligned.
 */
export function describeToolUse(
  name: string,
  input: Record<string, unknown> | null | undefined
): string {
  const getStr = (key: string): string => {
    if (!input) return "";
    const v = (input as Record<string, unknown>)[key];
    return typeof v === "string" ? v : "";
  };
  const basename = (p: string): string => {
    const idx = p.lastIndexOf("/");
    return idx < 0 ? p : p.slice(idx + 1);
  };

  switch (name) {
    case "Read":
      return `Reading ${basename(getStr("file_path"))}`;
    case "Edit":
      return `Editing ${basename(getStr("file_path"))}`;
    case "Write":
      return `Writing ${basename(getStr("file_path"))}`;
    case "Bash":
      return `$ ${truncateChars(getStr("command"), 60)}`;
    case "Grep":
      return `Searching '${truncateChars(getStr("pattern"), 40)}'`;
    case "Glob":
      return `Finding ${getStr("pattern")}`;
    case "Agent": {
      const desc = getStr("description");
      return desc ? `Agent: ${desc}` : "Spawning agent";
    }
    case "WebSearch":
      return `Web search: ${truncateChars(getStr("query"), 40)}`;
    case "WebFetch":
      return `Fetching ${truncateChars(getStr("url"), 50)}`;
    case "LSP":
      return `LSP ${getStr("method")}`;
    case "Skill":
      return `/${getStr("skill")}`;
    default:
      return name;
  }
}

/**
 * Parse a single line of Claude `stream-json --verbose` stdout into an
 * activity description (or `null` if the line isn't a `tool_use` block we
 * want to visualise).
 *
 * Returns `null` for text chunks, result blocks, malformed JSON, or anything
 * else — callers should treat a null return as "skip, not an error".
 */
export function parseClaudeStreamLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!json || typeof json !== "object") return null;
  const obj = json as Record<string, unknown>;
  if (obj.type !== "assistant") return null;

  const message = obj.message;
  if (!message || typeof message !== "object") return null;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;

  // Claude can emit multiple content blocks per assistant event. We return the
  // first tool_use block; if more than one tool_use appears in the same event
  // the caller can re-scan (rare in practice).
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type !== "tool_use") continue;
    const name = typeof b.name === "string" ? b.name : "tool";
    const inputRaw = b.input;
    const input =
      inputRaw && typeof inputRaw === "object"
        ? (inputRaw as Record<string, unknown>)
        : undefined;
    return describeToolUse(name, input);
  }
  return null;
}

/**
 * Append an entry to an existing stack, capping BEFORE the push so a burst of
 * tool_use events can't momentarily exceed the cap (gap #12 lesson — don't
 * append-then-trim).
 */
export function appendActivityCapped(
  stack: ToolActivityEntry[],
  entry: ToolActivityEntry,
  cap: number = ACTIVITY_STACK_MAX
): ToolActivityEntry[] {
  const next = stack.length >= cap ? stack.slice(stack.length - cap + 1) : stack.slice();
  next.push(entry);
  return next;
}

function truncateChars(s: string, n: number): string {
  // Use Array.from so surrogate-paired emoji count as a single unit instead of
  // being split mid-codepoint.
  const chars = Array.from(s);
  if (chars.length <= n) return s;
  return `${chars.slice(0, n).join("")}…`;
}
