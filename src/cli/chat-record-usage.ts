import type { SessionKind } from "../domain/session-budget.js";

export interface ChatRecordUsageArgs {
  session: string;
  input: number;
  output: number;
  kind?: SessionKind;
  model?: string;
  channel?: string;
}

/**
 * Handler for the `rly chat record-usage` CLI subcommand. Mints (or
 * resumes) the session's `TokenTracker`, calls `record(input, output)`,
 * and — when `--channel` is passed — wires the threshold-feed bridge so
 * 75/90/95 crossings post to the channel feed.
 *
 * Used by the GUI's chat-event Rust loop and the TUI's chat-event Rust
 * worker (per D-04 chat-mode parity), shelled out via
 * `Command::new(cli_bin())`.
 *
 * **Phase 1 PR-1:** stub. Implementation lands in PR-4 (Task 10). The
 * signature ships in PR-1 so RED tests compile against the final shape.
 */
export async function handleChatRecordUsageCommand(_args: ChatRecordUsageArgs): Promise<void> {
  throw new Error("handleChatRecordUsageCommand: not yet implemented (Phase 1 PR-4 / Task 10)");
}
