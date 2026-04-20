import type {
  Notifier,
  NotifyAction,
  NotifyContext,
  OrchestratorEvent
} from "@aoagents/ao-core";

import type { ChannelStore } from "./channel-store.js";

/**
 * Adapts the harness channel system to AO's `Notifier` interface so the
 * harness can be used as a drop-in notifier in any AO deployment.
 *
 * Events become channel feed entries (posted via `ChannelStore.postEntry`)
 * with the event type, session id, and a human-readable message.
 */
export class HarnessChannelNotifier implements Notifier {
  readonly name = "harness-channel";

  private readonly channelStore: ChannelStore;
  private readonly defaultChannelId: string;

  constructor(options: { channelStore: ChannelStore; defaultChannelId: string }) {
    this.channelStore = options.channelStore;
    this.defaultChannelId = options.defaultChannelId;
  }

  /** Push a notification to the default channel as an `event` entry. */
  async notify(event: OrchestratorEvent): Promise<void> {
    await this.channelStore.post(this.defaultChannelId, this.formatEventMessage(event), {
      type: "event",
      fromDisplayName: "orchestrator",
      metadata: this.buildEventMetadata(event)
    });
  }

  /** Push a notification with actionable links appended to the body. */
  async notifyWithActions(
    event: OrchestratorEvent,
    actions: NotifyAction[]
  ): Promise<void> {
    const base = this.formatEventMessage(event);
    const actionLines = actions
      .map((a) => {
        const target = a.url ?? a.callbackEndpoint ?? "";
        return target ? `- ${a.label}: ${target}` : `- ${a.label}`;
      })
      .join("\n");

    const content = actionLines ? `${base}\n\nActions:\n${actionLines}` : base;

    await this.channelStore.post(this.defaultChannelId, content, {
      type: "event",
      fromDisplayName: "orchestrator",
      metadata: this.buildEventMetadata(event)
    });
  }

  /**
   * Direct channel post. Uses `context.channel` if provided, otherwise
   * falls back to the configured default channel. Returns the entry id
   * (AO's Notifier contract expects a string|null identifier).
   */
  async post(message: string, context?: NotifyContext): Promise<string | null> {
    const channelId = context?.channel ?? this.defaultChannelId;

    const metadata: Record<string, unknown> = {};
    if (context?.sessionId) metadata.sessionId = context.sessionId;
    if (context?.projectId) metadata.projectId = context.projectId;
    if (context?.prUrl) metadata.prUrl = context.prUrl;

    return this.channelStore.post(channelId, message, {
      type: "message",
      fromDisplayName: "orchestrator",
      metadata
    });
  }

  private formatEventMessage(event: OrchestratorEvent): string {
    const prefix = `[${event.type}] session=${event.sessionId}`;
    return event.message ? `${prefix} — ${event.message}` : prefix;
  }

  private buildEventMetadata(event: OrchestratorEvent): Record<string, unknown> {
    return {
      eventId: event.id,
      eventType: event.type,
      priority: event.priority,
      sessionId: event.sessionId,
      projectId: event.projectId,
      timestamp: event.timestamp.toISOString(),
      // Preserve the event payload — the channel store will JSON-serialize
      // this so downstream readers keep seeing string-valued metadata.
      data: event.data
    };
  }
}
