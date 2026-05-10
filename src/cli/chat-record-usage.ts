import { ChannelStore } from "../channels/channel-store.js";
import { TokenTracker } from "../budget/token-tracker.js";
import { attachThresholdFeed } from "../budget/threshold-feed-bridge.js";
import { resolveContextWindow } from "../domain/model-context-windows.js";
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
 * Handler for the `rly chat record-usage` CLI subcommand. Mints a fresh
 * `TokenTracker` for the given session (replay picks up any prior cumulative
 * total from `~/.relay/sessions/<id>/budget.jsonl`), calls
 * `record(input, output)`, and — when `--channel` is passed — wires the
 * threshold-feed bridge so 75/90/95 crossings post to the channel feed.
 *
 * D-04 (chat-mode parity): used by both the GUI's chat-event Rust loop
 * (`gui/src-tauri/src/lib.rs`) and the TUI's chat-event Rust worker
 * (`tui/src/main.rs`), each of which shells out to `rly chat record-usage`
 * once per Claude turn after `child.wait()` resolves. This keeps the
 * persistence shape identical to the orchestrator's (modulo the `kind`
 * discriminator) so a single reader (TS `loadActiveSessions` and Rust
 * `harness_data::load_session_budget`) handles every dispatch path.
 */
export async function handleChatRecordUsageCommand(args: ChatRecordUsageArgs): Promise<void> {
  if (!args.session) {
    throw new Error("handleChatRecordUsageCommand: session is required");
  }

  const ceiling = resolveContextWindow(args.model);
  const tracker = new TokenTracker(args.session, ceiling, { kind: args.kind ?? "chat" });

  let unsubscribe: (() => void) | null = null;
  if (args.channel) {
    const channelStore = new ChannelStore();
    unsubscribe = attachThresholdFeed(tracker, args.channel, channelStore, {
      modelName: args.model,
    });
  }

  try {
    tracker.record(args.input, args.output);
    await tracker.flush();
  } finally {
    unsubscribe?.();
    await tracker.close();
  }
}
