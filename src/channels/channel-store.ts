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
import type { TrackedPrRow } from "../domain/pr-row.js";
import type { TicketLedgerEntry } from "../domain/ticket.js";
import { buildHarnessStore } from "../storage/factory.js";
import { STORE_NS } from "../storage/namespaces.js";
import type { HarnessStore } from "../storage/store.js";

// Per-channel serialization so concurrent upsertChannelTickets calls for the
// same channel don't race on read-modify-write. Keyed by channelId; the value
// is a tail promise callers queue behind. Entries self-cleanup when no one is
// queued. In-process only; cross-process coordination for multi-writer
// deployments (multiple schedulers) comes with the Postgres-backed
// HarnessStore in T-402 — the per-upsert coordination record written through
// `this.store.mutate` below is the hook that enables it.
const channelTicketLocks: Map<string, Promise<void>> = new Map();

// Monotonic suffix so two concurrent writers in the same process never
// collide on the tmp file used by writeChannelTickets.
let channelTicketsTmpCounter = 0;

// Same rationale for the channel manifest (`channels/<id>.json`): two
// concurrent `touchChannel` calls (e.g. an orchestrator transition and an
// agent dispatch both firing `postEntry` → `touchChannel` in the same tick)
// would otherwise both compute `${path}.tmp.${process.pid}`, and the second
// rename would hit ENOENT because the first rename already consumed the tmp.
// This surfaces as noisy `channel post failed` stderr even though the post
// semantically succeeded. A per-call counter eliminates the collision.
let channelManifestTmpCounter = 0;

/**
 * Ticket-board coordination record stored on the `HarnessStore` at
 * `(channel-tickets, <channelId>)`. The ticket data itself continues to live
 * in `channels/<channelId>/tickets.json` for Rust/GUI compatibility — this
 * doc only tracks the last mutation so `store.mutate` can serve as a
 * cross-process mutex when the backing store supports it (Postgres advisory
 * locks in T-402). Unused when the operation is never called, which keeps
 * pure-read callers (Rust, TUI) from ever materializing it.
 */
interface TicketLockRecord {
  updatedAt: string;
  count: number;
}

/**
 * Build the `STORE_NS.decision` doc id for a channel decision. The mirror
 * key is `<channelId>:<decisionId>` — a flat keyspace under a single
 * namespace so `listDocs(decision, <channelId>:)` can enumerate every
 * decision in a channel without listing every channel. Colon is a safe
 * segment char in `FileHarnessStore` (`assertSafeSegment` blocks only `.`,
 * `..`, `/`, `\`, null, empty) and round-trips through the Postgres text
 * column unchanged.
 */
function decisionStoreId(channelId: string, decisionId: string): string {
  return `${channelId}:${decisionId}`;
}

export class ChannelStore {
  private readonly channelsDir: string;
  private readonly store: HarnessStore;

  /**
   * @param channelsDir Directory for on-disk channel files. Defaults to
   *   `~/.relay/channels` to preserve the layout the Rust crate
   *   `harness-data` and the Tauri GUI read from directly. Overriding this
   *   is only meaningful for tests — changing the default would break the
   *   Rust/GUI reader.
   * @param store `HarnessStore` used for operations that have migrated off
   *   direct filesystem access. Defaults to `buildHarnessStore()` so callers
   *   that don't inject one pick up the process-wide singleton semantics
   *   through the factory. Tests substitute a `FakeHarnessStore` here.
   *
   * NOTE: most operations on this class still write directly to
   * `channelsDir` because the Rust/GUI reader expects the plural-`channels`
   * layout (`channels/<id>.json`, `channels/<id>/feed.jsonl`,
   * `channels/<id>/tickets.json`, `channels/<id>/decisions/*.json`,
   * `channels/<id>/runs.json`). FileHarnessStore's default namespace layout
   * is `<root>/<ns>/<id>.json` which does not match, so migrating those
   * paths would silently break the desktop app. T-101a tracks aligning the
   * Rust side; until then, only coordination primitives (mutex) migrate.
   */
  constructor(channelsDir?: string, store?: HarnessStore) {
    this.channelsDir = channelsDir ?? join(getRelayDir(), "channels");
    this.store = store ?? buildHarnessStore();
  }

  // --- Channel CRUD ---

  async createChannel(input: {
    name: string;
    description: string;
    workspaceIds?: string[];
    repoAssignments?: RepoAssignment[];
    primaryWorkspaceId?: string;
  }): Promise<Channel> {
    await mkdir(this.channelsDir, { recursive: true });

    const now = new Date().toISOString();
    // Only keep primaryWorkspaceId when it actually points at one of the
    // provided assignments. Silently drop a dangling id so callers don't
    // end up with a "primary" that resolves to nothing on the next read.
    const assignments = input.repoAssignments;
    const primaryWorkspaceId =
      input.primaryWorkspaceId &&
      assignments?.some((a) => a.workspaceId === input.primaryWorkspaceId)
        ? input.primaryWorkspaceId
        : undefined;

    const channel: Channel = {
      channelId: buildChannelId(),
      name: input.name,
      description: input.description,
      status: "active",
      workspaceIds: input.workspaceIds ?? [],
      members: [],
      pinnedRefs: [],
      repoAssignments: assignments,
      primaryWorkspaceId,
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
    patch: Partial<
      Pick<
        Channel,
        | "name"
        | "description"
        | "status"
        | "workspaceIds"
        | "repoAssignments"
        | "primaryWorkspaceId"
      >
    >
  ): Promise<Channel | null> {
    const channel = await this.getChannel(channelId);
    if (!channel) return null;

    const updated: Channel = {
      ...channel,
      ...patch,
      updatedAt: new Date().toISOString()
    };

    // Reconcile primaryWorkspaceId against the (possibly updated) repo list.
    // Rules:
    //   - If primaryWorkspaceId points at a workspace still present in
    //     repoAssignments, keep it.
    //   - If the caller explicitly set primaryWorkspaceId to undefined in
    //     the patch (i.e. the key is present but the value is undefined),
    //     respect that as "clear primary".
    //   - Otherwise, if the current primary no longer matches any
    //     assignment (e.g. because it was removed from the repos list),
    //     fall back to the first remaining assignment, or clear the field
    //     when no assignments remain.
    const primaryExplicitlyCleared =
      Object.prototype.hasOwnProperty.call(patch, "primaryWorkspaceId") &&
      patch.primaryWorkspaceId === undefined;
    const assignments = updated.repoAssignments ?? [];
    const currentPrimary = updated.primaryWorkspaceId;
    const primaryStillValid =
      !!currentPrimary &&
      assignments.some((a) => a.workspaceId === currentPrimary);

    if (primaryExplicitlyCleared) {
      updated.primaryWorkspaceId = undefined;
    } else if (!primaryStillValid) {
      updated.primaryWorkspaceId = assignments[0]?.workspaceId;
    }

    await this.writeChannel(updated);
    return updated;
  }

  /**
   * Return the `RepoAssignment` that should be treated as the channel's
   * primary repo. Resolution order:
   *   1. `channel.primaryWorkspaceId` matches an entry in `repoAssignments`.
   *   2. Fall back to `repoAssignments[0]` (first registered repo).
   *   3. `null` when the channel has no repo assignments at all.
   *
   * Back-compat: a `primaryWorkspaceId` that doesn't match any assignment
   * is ignored in favor of the first-repo fallback, so a stale id from an
   * older channel file never strands the channel.
   */
  getPrimaryAssignment(channel: Channel): RepoAssignment | null {
    const assignments = channel.repoAssignments ?? [];
    if (assignments.length === 0) {
      return null;
    }

    if (channel.primaryWorkspaceId) {
      const match = assignments.find(
        (a) => a.workspaceId === channel.primaryWorkspaceId
      );
      if (match) return match;
    }

    return assignments[0] ?? null;
  }

  async archiveChannel(channelId: string): Promise<Channel | null> {
    return this.updateChannel(channelId, { status: "archived" });
  }

  /**
   * Bump a channel's `updatedAt` without patching any user-visible field.
   * Called from activity writes (postEntry, recordDecision) so the sidebar
   * can sort channels by most-recent activity. Silently no-ops if the
   * channel is missing so activity on orphan feeds doesn't throw.
   */
  private async touchChannel(channelId: string): Promise<void> {
    const channel = await this.getChannel(channelId);
    if (!channel) return;
    channel.updatedAt = new Date().toISOString();
    await this.writeChannel(channel);
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

    // Bump channel-level activity so sorts by updatedAt reflect feed writes.
    await this.touchChannel(channelId);

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

  // --- Tracked PRs (PR watcher mirror, channel-scoped) ---
  //
  // `PrPoller` holds tracked rows in-memory only. We mirror a snapshot to
  // `channels/<channelId>/tracked-prs.json` (atomic tmp-rename) so the TUI
  // and GUI can render the same `rly pr-status` columns without reaching
  // into the live watcher. Writers are the CLI (pr-watcher-factory sink);
  // readers are the Rust crate (`load_tracked_prs`) and the `pr-status`
  // command when no active watcher is present.

  async readTrackedPrs(channelId: string): Promise<TrackedPrRow[]> {
    const path = join(this.channelsDir, channelId, "tracked-prs.json");
    try {
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw) as { rows?: TrackedPrRow[] };
      return Array.isArray(parsed?.rows) ? parsed.rows : [];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      // Any other failure surfaces so a corrupt file isn't silently
      // overwritten by the next snapshot.
      throw new Error(
        `Failed to read tracked-prs at ${path}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  async writeTrackedPrs(
    channelId: string,
    rows: TrackedPrRow[]
  ): Promise<void> {
    const channelDir = join(this.channelsDir, channelId);
    await mkdir(channelDir, { recursive: true });
    const path = join(channelDir, "tracked-prs.json");
    const tmpPath = `${path}.tmp.${process.pid}.${channelTicketsTmpCounter++}`;
    await writeFile(
      tmpPath,
      JSON.stringify(
        { updatedAt: new Date().toISOString(), rows },
        null,
        2
      )
    );
    await rename(tmpPath, path);
  }

  // --- Ticket board (channel-scoped, unified across chat + orchestrator) ---

  /**
   * Read the unified ticket board for a channel. Returns `[]` only when the
   * file legitimately does not exist yet (ENOENT). Any other error — parse
   * failure, permission denied, malformed JSON — is rethrown so callers
   * don't silently overwrite real data via `upsertChannelTickets`.
   */
  async readChannelTickets(channelId: string): Promise<TicketLedgerEntry[]> {
    const path = join(this.channelsDir, channelId, "tickets.json");
    let content: string;

    try {
      content = await readFile(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw new Error(
        `Failed to read channel ticket board at ${path}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }

    try {
      const raw = JSON.parse(content) as { tickets?: TicketLedgerEntry[] };
      const tickets = raw?.tickets;
      if (tickets !== undefined && !Array.isArray(tickets)) {
        throw new Error(`tickets field is not an array`);
      }
      return tickets ?? [];
    } catch (err) {
      throw new Error(
        `Corrupt channel ticket board at ${path}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  /**
   * Replace the full ticket list on the channel board. Write is atomic via
   * tmp-file + rename, so readers never observe a partial file even on
   * crash. Callers that only want to add/update a subset should use
   * `upsertChannelTickets` — this method is primarily for seeders and
   * full-board rewrites.
   */
  async writeChannelTickets(
    channelId: string,
    tickets: TicketLedgerEntry[]
  ): Promise<void> {
    const channelDir = join(this.channelsDir, channelId);
    await mkdir(channelDir, { recursive: true });

    const path = join(channelDir, "tickets.json");
    // Include a monotonic suffix alongside the PID so two concurrent writes
    // in the same process don't collide on the tmp file.
    const tmpPath = `${path}.tmp.${process.pid}.${channelTicketsTmpCounter++}`;

    await writeFile(
      tmpPath,
      JSON.stringify(
        {
          updatedAt: new Date().toISOString(),
          tickets
        },
        null,
        2
      )
    );
    await rename(tmpPath, path);
  }

  /**
   * Merge `incoming` into the existing channel board by `ticketId`. Entries
   * already present are replaced wholesale by the incoming version (so the
   * caller owns the full shape, not just a patch). New ticketIds are
   * appended in the order they appear in `incoming`. Existing entries
   * absent from `incoming` are preserved unchanged.
   *
   * Concurrent calls for the same channel are serialized through an
   * in-memory per-channel mutex so a read-modify-write cycle cannot lose
   * updates when multiple schedulers (or a scheduler + chat session) write
   * at once. The mutex is in-process only.
   *
   * After each successful merge, a small coordination record is written to
   * the injected `HarnessStore` at `(channel-tickets, <channelId>)`. When
   * the backing store is Postgres (T-402) this record lives under a
   * cross-process advisory-lock-capable key, so multi-process schedulers
   * can layer `store.mutate` on top for cross-process coordination without
   * the ChannelStore itself owning that logic. FileHarnessStore's version
   * is a plain JSON file at `<root>/channel-tickets/<id>.json` — harmless
   * to the Rust/GUI reader (which only traverses `channels/`), and it
   * doubles as an audit trail of upsert activity.
   *
   * Why not use `store.mutate` as the mutex directly? Its callback is
   * synchronous (`(prev) => T`) so awaiting the `channels/<id>/tickets.json`
   * read-modify-write inside it isn't possible without changing the
   * HarnessStore contract — out of scope for T-101.
   */
  async upsertChannelTickets(
    channelId: string,
    incoming: TicketLedgerEntry[]
  ): Promise<TicketLedgerEntry[]> {
    const merged = await this.withChannelLock(channelId, async () => {
      const existing = await this.readChannelTickets(channelId);
      const byId = new Map(existing.map((t) => [t.ticketId, t]));

      for (const entry of incoming) {
        byId.set(entry.ticketId, entry);
      }

      const out: TicketLedgerEntry[] = [];
      const seen = new Set<string>();

      for (const entry of existing) {
        const current = byId.get(entry.ticketId);
        if (current) {
          out.push(current);
          seen.add(entry.ticketId);
        }
      }

      for (const entry of incoming) {
        if (!seen.has(entry.ticketId)) {
          out.push(entry);
          seen.add(entry.ticketId);
        }
      }

      await this.writeChannelTickets(channelId, out);
      return out;
    });

    // Persist the coordination record through the HarnessStore. Uses
    // `mutate` to keep semantics consistent across backends: on Postgres
    // this executes under `pg_advisory_xact_lock`, on FileHarnessStore it
    // serializes through the in-process key-lock. Purely advisory —
    // nothing reads this record today; T-402 consumers layer on top.
    await this.store.mutate<TicketLockRecord>(
      STORE_NS.channelTickets,
      channelId,
      () => ({
        updatedAt: new Date().toISOString(),
        count: merged.length
      })
    );

    return merged;
  }

  private async withChannelLock<T>(
    channelId: string,
    fn: () => Promise<T>
  ): Promise<T> {
    const prev = channelTicketLocks.get(channelId) ?? Promise.resolve();
    let resolveCurrent!: () => void;
    const current = new Promise<void>((resolve) => {
      resolveCurrent = resolve;
    });
    const next = prev.then(() => current);
    channelTicketLocks.set(channelId, next);

    try {
      await prev;
      return await fn();
    } finally {
      resolveCurrent();
      // If nobody queued behind us, clean up so the map doesn't grow unbounded.
      if (channelTicketLocks.get(channelId) === next) {
        channelTicketLocks.delete(channelId);
      }
    }
  }

  // --- Decisions ---

  /**
   * Persist a decision and post the accompanying channel-feed entry. Decisions
   * continue to live on disk at `channels/<channelId>/decisions/<id>.json`
   * because the Rust reader (`load_channel_decisions` in
   * `crates/harness-data/src/lib.rs`) scans that directory directly. After the
   * disk write succeeds, a mirror is published through the injected
   * `HarnessStore` at `(decision, <channelId>:<decisionId>)` so future
   * coordination consumers (Postgres `LISTEN/NOTIFY` watchers for cross-agent
   * decision announcements, T-402) can observe new decisions without tailing
   * the filesystem. Follows the same primary-disk-then-mirror pattern T-101
   * uses for `upsertChannelTickets`.
   */
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

    const path = join(decisionsDir, `${decision.decisionId}.json`);
    const tmpPath = `${path}.tmp.${process.pid}`;
    await writeFile(tmpPath, JSON.stringify(decision, null, 2));
    await rename(tmpPath, path);

    // Mirror through HarnessStore *after* the Rust-visible disk write has
    // committed. If the mirror throws, swallow: the source of truth is on
    // disk, and a future caller's `recordDecision` will pick up where we
    // left off (mirror is purely additive; no historical replay needed).
    try {
      await this.store.putDoc(
        STORE_NS.decision,
        decisionStoreId(channelId, decision.decisionId),
        decision
      );
    } catch (err) {
      // Intentional: never let a coordination-mirror failure surface as a
      // decision-recording failure. The decision is durably persisted via
      // the atomic rename above; consumers reading through Rust / GUI see
      // it immediately. Warn so the divergence between the on-disk decision
      // and the (now-stale) HarnessStore mirror is visible in logs.
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[channel-store] decision coordination mirror failed ` +
          `channelId=${channelId} decisionId=${decision.decisionId}: ${msg}`
      );
    }

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
    const tmpPath = `${path}.tmp.${process.pid}.${channelManifestTmpCounter++}`;
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
