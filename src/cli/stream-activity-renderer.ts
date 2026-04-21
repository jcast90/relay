import {
  ACTIVITY_STACK_MAX,
  appendActivityCapped,
  parseClaudeStreamLine,
  type ToolActivityEntry,
} from "../domain/tool-activity.js";

/**
 * Inline CLI renderer for streaming tool-use events. Keeps parity with the
 * GUI's activity stack and the TUI's activity pane — tool name + one-line
 * argument preview, rendered as the stream arrives so operators running
 * `rly run` can see what their agents are doing live.
 *
 * Output format (on stderr so it doesn't pollute stdout pipelines):
 *
 *   ⚙ [12:34:56] [@alias] Reading foo.ts
 *   ⚙ [12:34:57] [@alias] $ pnpm test
 *
 * Respects quiet mode (either `RELAY_QUIET=1` or `--quiet` in CLI args).
 * When quiet, the renderer silently drops activity but still parses the
 * stream so callers can still collect the final result.
 */

export interface StreamActivityRendererOptions {
  /** Prefix (rendered inside brackets) so multi-agent runs stay identifiable. */
  label?: string;
  /** Override for test assertions / piping into non-TTY sinks. */
  write?: (line: string) => void;
  /** When false, the renderer is a no-op. Default: enabled. */
  enabled?: boolean;
  /** Debounce in ms. Consecutive activities arriving within this window are
   *  coalesced so a burst of 30 tool_use events doesn't spam the terminal. */
  debounceMs?: number;
}

export interface StreamActivityRenderer {
  /** Feed one stream-json line (trimmed or raw). Safe to call with any string. */
  onLine(line: string): void;
  /** Force-flush any debounced pending render. Call before exit. */
  flush(): void;
  /** Most-recent entries, newest last. Mostly for tests. */
  snapshot(): ToolActivityEntry[];
}

/**
 * Decide whether the renderer should actually print. Quiet mode wins when
 * either RELAY_QUIET / HARNESS_QUIET env is set OR the caller passed --quiet
 * / --silent / -q on the CLI. The TTY check is intentional: when stderr is a
 * pipe (e.g. `rly run ... 2>log`), we still stream so the log is useful.
 */
export function isQuietMode(argv: string[] = []): boolean {
  if (argv.includes("--quiet") || argv.includes("--silent")) {
    return true;
  }
  const env = process.env.RELAY_QUIET ?? process.env.HARNESS_QUIET;
  return env === "1" || env === "true" || env === "yes";
}

export function createStreamActivityRenderer(
  options: StreamActivityRendererOptions = {}
): StreamActivityRenderer {
  const enabled = options.enabled !== false;
  const write = options.write ?? ((line: string) => process.stderr.write(`${line}\n`));
  const label = options.label ? ` [${options.label}]` : "";
  const debounceMs = options.debounceMs ?? 40;

  let stack: ToolActivityEntry[] = [];
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingIdx = 0; // index into stack of the oldest unrendered entry

  const emit = () => {
    if (!enabled) {
      pendingIdx = stack.length;
      return;
    }
    for (; pendingIdx < stack.length; pendingIdx++) {
      const entry = stack[pendingIdx];
      const ts = formatTime(entry.ts);
      write(`${dim("⚙")} ${dim(`[${ts}]`)}${dim(label)} ${entry.text}`);
    }
    pendingTimer = null;
  };

  const scheduleEmit = () => {
    if (pendingTimer) return;
    pendingTimer = setTimeout(emit, debounceMs);
  };

  return {
    onLine(line: string): void {
      const text = parseClaudeStreamLine(line);
      if (!text) return;
      // Cap BEFORE appending so a spike of events can't ever overshoot the
      // retained stack size. Matches the GUI and TUI's append policy.
      const entry: ToolActivityEntry = { text, ts: Date.now() };
      const before = stack.length;
      stack = appendActivityCapped(stack, entry, ACTIVITY_STACK_MAX);
      if (stack.length < before + 1) {
        // We dropped an older entry to make room. Keep pendingIdx pointing at
        // the newest unrendered entry so we don't re-render already-flushed
        // lines after a cap-trim.
        pendingIdx = Math.max(0, pendingIdx - (before + 1 - stack.length));
      }
      scheduleEmit();
    },
    flush(): void {
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
      emit();
    },
    snapshot(): ToolActivityEntry[] {
      return stack.slice();
    },
  };
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function dim(s: string): string {
  // ANSI dim. If NO_COLOR is set or the sink isn't a TTY we leave the string
  // unwrapped so log captures stay clean.
  if (process.env.NO_COLOR) return s;
  if (!process.stderr.isTTY) return s;
  return `\x1b[2m${s}\x1b[0m`;
}
