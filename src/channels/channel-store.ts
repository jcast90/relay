import { appendFile, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { getRelayDir } from "../cli/paths.js";
import { getAgentName } from "../domain/agent-names.js";
import {
  buildChannelId,
  buildEntryId,
  type Channel,
  type ChannelEntry,
  type ChannelEntryType,
  type ChannelMember,
  type ChannelRef,
  type ChannelRunLink,
  type ChannelStatus,
  type RepoAssignment
} from "../domain/channel.js";
import { buildDecisionId, type Decision } from "../domain/decision.js";

export class ChannelStore {
  private readonly channelsDir: string;

  constructor(channelsDir?: string) {
    this.channelsDir = channelsDir ?? join(getRelayDir(), "channels");
  }

  // --- Channel CRUD ---

  async createChannel(input: {
    name: string;
    description: string;
    workspaceIds?: string[];
    repoAssignments?: RepoAssignment[];
  }): Promise<Channel> {
    await mkdir(this.channelsDir, { recursive: true });

    const now = new Date().toISOString();
    const channel: Channel = {
      channelId: buildChannelId(),
      name: input.name,
      description: input.description,
      status: "active",
      workspaceIds: input.workspaceIds ?? [],
      members: [],
      pinnedRefs: [],
      repoAssignments: input.repoAssignments,
      createdAt: now,
      updatedAt: now
    };

    await this.writeChannel(channel);
    await mkdir(join(this.channelsDir, channel.channelId), { recursive: true });

    return channel;
  }

  async getChannel(channelId: string): Promise<Channel | null> {
    try {
      const raw = await readFile(
        join(this.channelsDir, `${channelId}.json`),
        "utf8"
      );
      return JSON.parse(raw) as Channel;
    } catch {
      return null;
    }
  }

  async listChannels(status?: ChannelStatus): Promise<Channel[]> {
    const files = await this.safeReaddir(this.channelsDir);
    const channels: Channel[] = [];

    for (const file of files) {
      if (!file.endsWith(".json")) continue;

      try {
        const raw = JSON.parse(
          await readFile(join(this.channelsDir, file), "utf8")
        ) as Channel;

        if (!status || raw.status === status) {
          channels.push(raw);
        }
      } catch {
        // skip malformed
      }
    }

    return channels.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  }

  async updateChannel(
    channelId: string,
    patch: Partial<Pick<Channel, "name" | "description" | "status" | "workspaceIds" | "repoAssignments">>
  ): Promise<Channel | null> {
    const channel = await this.getChannel(channelId);
    if (!channel) return null;

    const updated: Channel = {
      ...channel,
      ...patch,
      updatedAt: new Date().toISOString()
    };

    await this.writeChannel(updated);
    return updated;
  }

  async archiveChannel(channelId: string): Promise<Channel | null> {
    return this.updateChannel(channelId, { status: "archived" });
  }

  // --- Members ---

  async joinChannel(channelId: string, member: Omit<ChannelMember, "joinedAt" | "status">): Promise<Channel | null> {
    const channel = await this.getChannel(channelId);
    if (!channel) return null;

    const existing = channel.members.findIndex((m) => m.agentId === member.agentId);
    const now = new Date().toISOString();

    const fullMember: ChannelMember = {
      ...member,
      joinedAt: now,
      status: "active"
    };

    if (existing >= 0) {
      channel.members[existing] = fullMember;
    } else {
      channel.members.push(fullMember);
    }

    channel.updatedAt = now;
    await this.writeChannel(channel);

    await this.postEntry(channelId, {
      type: "agent_joined",
      fromAgentId: member.agentId,
      fromDisplayName: member.displayName,
      content: `${member.displayName} joined the channel.`,
      metadata: { role: member.role, provider: member.provider }
    });

    return channel;
  }

  async leaveChannel(channelId: string, agentId: string): Promise<Channel | null> {
    const channel = await this.getChannel(channelId);
    if (!channel) return null;

    const member = channel.members.find((m) => m.agentId === agentId);
    if (!member) return channel;

    member.status = "offline";
    channel.updatedAt = new Date().toISOString();
    await this.writeChannel(channel);

    await this.postEntry(channelId, {
      type: "agent_left",
      fromAgentId: agentId,
      fromDisplayName: member.displayName,
      content: `${member.displayName} left the channel.`,
      metadata: {}
    });

    return channel;
  }

  // --- Feed ---

  async postEntry(
    channelId: string,
    input: {
      type: ChannelEntryType;
      fromAgentId: string | null;
      fromDisplayName: string | null;
      content: string;
      metadata: Record<string, unknown>;
    }
  ): Promise<ChannelEntry> {
    const feedDir = join(this.channelsDir, channelId);
    await mkdir(feedDir, { recursive: true });

    const entry: ChannelEntry = {
      entryId: buildEntryId(),
      channelId,
      type: input.type,
      fromAgentId: input.fromAgentId,
      fromDisplayName: input.fromDisplayName,
      content: input.content,
      metadata: normalizeMetadata(input.metadata),
      createdAt: new Date().toISOString()
    };

    await appendFile(
      join(feedDir, "feed.jsonl"),
      JSON.stringify(entry) + "\n"
    );

    return entry;
  }

  /**
   * Thin wrapper over `postEntry` with ergonomic defaults for the common
   * "drop a message into a channel" case. Returns the created entry id.
   *
   * Defaults: `type: "message"`, `fromAgentId: null`,
   * `fromDisplayName: "system"`, empty metadata.
   */
  async post(
    channelId: string,
    content: string,
    options?: {
      type?: ChannelEntryType;
      fromAgentId?: string | null;
      fromDisplayName?: string;
      metadata?: Record<string, unknown>;
    }
  ): Promise<string> {
    const entry = await this.postEntry(channelId, {
      type: options?.type ?? "message",
      fromAgentId: options?.fromAgentId ?? null,
      fromDisplayName: options?.fromDisplayName ?? "system",
      content,
      metadata: options?.metadata ?? {}
    });
    return entry.entryId;
  }

  async readFeed(channelId: string, limit?: number): Promise<ChannelEntry[]> {
    const path = join(this.channelsDir, channelId, "feed.jsonl");

    try {
      const raw = await readFile(path, "utf8");
      const entries = raw
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const entry = JSON.parse(line) as ChannelEntry;
          entry.metadata = denormalizeMetadata(
            entry.metadata as Record<string, string>
          );
          return entry;
        });

      if (limit) {
        return entries.slice(-limit);
      }

      return entries;
    } catch {
      return [];
    }
  }

  // --- References ---

  async addRef(channelId: string, ref: Omit<ChannelRef, "addedAt">): Promise<Channel | null> {
    const channel = await this.getChannel(channelId);
    if (!channel) return null;

    const now = new Date().toISOString();
    channel.pinnedRefs.push({ ...ref, addedAt: now });
    channel.updatedAt = now;
    await this.writeChannel(channel);

    await this.postEntry(channelId, {
      type: "ref_added",
      fromAgentId: null,
      fromDisplayName: null,
      content: `Reference added: ${ref.label} (${ref.type}: ${ref.targetId})`,
      metadata: { refType: ref.type, targetId: ref.targetId }
    });

    return channel;
  }

  async removeRef(channelId: string, targetId: string): Promise<Channel | null> {
    const channel = await this.getChannel(channelId);
    if (!channel) return null;

    channel.pinnedRefs = channel.pinnedRefs.filter((r) => r.targetId !== targetId);
    channel.updatedAt = new Date().toISOString();
    await this.writeChannel(channel);

    return channel;
  }

  // --- Run linking ---

  async linkRun(channelId: string, runId: string, workspaceId: string): Promise<void> {
    const runsDir = join(this.channelsDir, channelId);
    await mkdir(runsDir, { recursive: true });

    const runsPath = join(runsDir, "runs.json");
    const existing = await this.readRunLinks(channelId);

    if (existing.some((r) => r.runId === runId)) return;

    existing.push({ runId, workspaceId, linkedAt: new Date().toISOString() });
    await writeFile(runsPath, JSON.stringify(existing, null, 2));

    await this.postEntry(channelId, {
      type: "run_started",
      fromAgentId: null,
      fromDisplayName: null,
      content: `Run ${runId} linked to channel.`,
      metadata: { runId, workspaceId }
    });
  }

  async readRunLinks(channelId: string): Promise<ChannelRunLink[]> {
    try {
      const raw = await readFile(
        join(this.channelsDir, channelId, "runs.json"),
        "utf8"
      );
      return JSON.parse(raw) as ChannelRunLink[];
    } catch {
      return [];
    }
  }

  // --- Decisions ---

  async recordDecision(
    channelId: string,
    input: Omit<Decision, "decisionId" | "channelId" | "createdAt">
  ): Promise<Decision> {
    const decisionsDir = join(this.channelsDir, channelId, "decisions");
    await mkdir(decisionsDir, { recursive: true });

    const decision: Decision = {
      decisionId: buildDecisionId(),
      channelId,
      ...input,
      createdAt: new Date().toISOString()
    };

    await writeFile(
      join(decisionsDir, `${decision.decisionId}.json`),
      JSON.stringify(decision, null, 2)
    );

    await this.postEntry(channelId, {
      type: "decision",
      fromAgentId: input.decidedBy,
      fromDisplayName: input.decidedByName,
      content: `Decision: ${input.title} — ${input.description}`,
      metadata: {
        decisionId: decision.decisionId,
        ...(input.runId ? { runId: input.runId } : {}),
        ...(input.ticketId ? { ticketId: input.ticketId } : {})
      }
    });

    return decision;
  }

  async getDecision(channelId: string, decisionId: string): Promise<Decision | null> {
    try {
      const raw = await readFile(
        join(this.channelsDir, channelId, "decisions", `${decisionId}.json`),
        "utf8"
      );
      return JSON.parse(raw) as Decision;
    } catch {
      return null;
    }
  }

  async listDecisions(channelId: string): Promise<Decision[]> {
    const decisionsDir = join(this.channelsDir, channelId, "decisions");
    const files = await this.safeReaddir(decisionsDir);
    const decisions: Decision[] = [];

    for (const file of files) {
      if (!file.endsWith(".json")) continue;

      try {
        const raw = JSON.parse(
          await readFile(join(decisionsDir, file), "utf8")
        ) as Decision;
        decisions.push(raw);
      } catch {
        // skip
      }
    }

    return decisions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  // --- Internal ---

  private async writeChannel(channel: Channel): Promise<void> {
    await mkdir(this.channelsDir, { recursive: true });
    const path = join(this.channelsDir, `${channel.channelId}.json`);
    const tmpPath = `${path}.tmp.${process.pid}`;
    await writeFile(tmpPath, JSON.stringify(channel, null, 2));
    await rename(tmpPath, path);
  }

  private async safeReaddir(dir: string): Promise<string[]> {
    try {
      return await readdir(dir);
    } catch {
      return [];
    }
  }
}

/**
 * Prefix used to tag metadata values that were JSON-serialized on write so
 * `denormalizeMetadata` can losslessly restore them on read. Chosen to be
 * distinctive and effectively never collide with real string payloads; if a
 * caller genuinely needs to store a string that happens to start with this
 * prefix, pass it through `JSON.stringify` before calling `post` (it will
 * round-trip as a string once parsed back).
 */
const JSON_TAG = "__ah_meta_json::";

/**
 * Serialize non-string metadata values to JSON strings so existing readers
 * (Rust `crates/harness-data` and `gui/src/types.ts`, which both type
 * metadata as `Record<string, string>`) continue to deserialize the feed
 * without changes. Non-string values are prefixed with `JSON_TAG` so
 * `denormalizeMetadata` can restore the original type on read.
 * `null` and `undefined` are dropped. Plain strings pass through verbatim;
 * as a collision-safety measure, a string that happens to start with
 * `JSON_TAG` is also JSON-tagged on write so `denormalizeMetadata` restores
 * the exact original string instead of treating it as a serialized payload.
 */
function normalizeMetadata(
  metadata: Record<string, unknown>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string") {
      // Normal case: strings pass through verbatim. The rare string that
      // coincidentally starts with the tag must be tagged too, otherwise
      // the reader would mis-parse it.
      out[key] = value.startsWith(JSON_TAG)
        ? JSON_TAG + JSON.stringify(value)
        : value;
    } else {
      out[key] = JSON_TAG + JSON.stringify(value);
    }
  }
  return out;
}

/**
 * Inverse of `normalizeMetadata`. Values that begin with `JSON_TAG` are
 * stripped and JSON-parsed back to their original type; all other values
 * pass through as strings. Safe to call on entries written before the tag
 * was introduced (those are pure strings and pass through unchanged).
 */
function denormalizeMetadata(
  metadata: Record<string, string> | undefined
): Record<string, unknown> {
  if (!metadata) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === "string" && value.startsWith(JSON_TAG)) {
      try {
        out[key] = JSON.parse(value.slice(JSON_TAG.length));
      } catch {
        // Malformed payload — surface the raw string rather than throw.
        out[key] = value;
      }
    } else {
      out[key] = value;
    }
  }
  return out;
}
