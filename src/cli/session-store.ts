import { appendFile, mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  buildSessionId,
  type ChatSession,
  type PersistedChatMessage
} from "../domain/session.js";
import { buildHarnessStore } from "../storage/factory.js";
import { STORE_NS } from "../storage/namespaces.js";
import type { HarnessStore } from "../storage/store.js";
import { getRelayDir } from "./paths.js";

/**
 * Coordination record stored on the `HarnessStore` at
 * `(session, <channelId>:<sessionId>)`. The session doc itself continues to
 * live at `<channelsDir>/<channelId>/sessions.json` (index) and
 * `<channelsDir>/<channelId>/sessions/<sessionId>.jsonl` (chat transcript)
 * for Rust/GUI compat — see `crates/harness-data/src/lib.rs::sessions_dir`,
 * `sessions_index_path`, and `session_chat_path`. This doc is an audit /
 * coordination record so `store.mutate` can serve as a cross-process mutex
 * on the Postgres-backed store (T-402) without this class owning that
 * logic.
 */
interface SessionLockRecord {
  updatedAt: string;
  messageCount: number;
}

// Monotonic suffix so concurrent writers in the same process don't collide
// on the tmp file used by `writeSessions`. Mirrors the `tmpCounter` in
// `storage/file-store.ts`'s `writeJsonAtomic`.
let sessionsTmpCounter = 0;

function lockRecordId(channelId: string, sessionId: string): string {
  // HarnessStore ids can't contain `/` or `\` (path traversal guard in
  // `assertSafeSegment`), so use `:` as the separator between channel and
  // session. The id stays human-readable and round-trips via simple split.
  return `${channelId}:${sessionId}`;
}

export class SessionStore {
  private readonly channelsDir: string;
  private readonly store: HarnessStore;

  /**
   * @param channelsDir Directory for on-disk channel / session files.
   *   Defaults to `<relayDir>/channels` so the layout matches what the Rust
   *   crate `harness-data` reads. Overriding this is only meaningful for
   *   tests — changing the default would break the Rust/GUI reader.
   * @param store `HarnessStore` used for the `(session, …)` coordination
   *   record written on every session mutation. Defaults to
   *   `buildHarnessStore()` so callers that don't inject one pick up the
   *   process-wide singleton semantics through the factory. Tests
   *   substitute a `FakeHarnessStore` here.
   *
   * NOTE: session reads/writes still go straight to the filesystem because
   * the Rust/GUI reader expects the path layout documented on
   * `SessionLockRecord`. Only coordination primitives migrate.
   */
  constructor(channelsDir?: string, store?: HarnessStore) {
    this.channelsDir = channelsDir ?? join(getRelayDir(), "channels");
    this.store = store ?? buildHarnessStore();
  }

  private sessionsDir(channelId: string): string {
    return join(this.channelsDir, channelId, "sessions");
  }

  private sessionsIndexPath(channelId: string): string {
    return join(this.channelsDir, channelId, "sessions.json");
  }

  private sessionChatPath(channelId: string, sessionId: string): string {
    return join(this.sessionsDir(channelId), `${sessionId}.jsonl`);
  }

  async createSession(channelId: string, title: string): Promise<ChatSession> {
    const now = new Date().toISOString();
    const session: ChatSession = {
      sessionId: buildSessionId(),
      title,
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      claudeSessionIds: {}
    };

    await mkdir(this.sessionsDir(channelId), { recursive: true });

    const sessions = await this.listSessions(channelId);
    sessions.push(session);
    await this.writeSessions(channelId, sessions);

    // Initial coordination record so watchers can pick the session up
    // before any message lands.
    await this.touchLockRecord(channelId, session.sessionId, 0);

    return session;
  }

  async listSessions(channelId: string): Promise<ChatSession[]> {
    const path = this.sessionsIndexPath(channelId);
    let raw: string;

    try {
      raw = await readFile(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      // EACCES / EIO / anything else: surface with path + cause so the
      // caller doesn't silently overwrite a real sessions index.
      throw new Error(
        `Failed to read sessions index at ${path}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        { cause: err }
      );
    }

    try {
      const sessions = JSON.parse(raw) as ChatSession[];
      sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return sessions;
    } catch (err) {
      throw new Error(
        `Corrupt sessions index at ${path}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        { cause: err }
      );
    }
  }

  async getSession(channelId: string, sessionId: string): Promise<ChatSession | null> {
    const sessions = await this.listSessions(channelId);
    return sessions.find((s) => s.sessionId === sessionId) ?? null;
  }

  async updateSession(channelId: string, session: ChatSession): Promise<void> {
    const sessions = await this.listSessions(channelId);
    const idx = sessions.findIndex((s) => s.sessionId === session.sessionId);

    if (idx >= 0) {
      sessions[idx] = session;
    }

    await this.writeSessions(channelId, sessions);
    await this.touchLockRecord(
      channelId,
      session.sessionId,
      session.messageCount
    );
  }

  async updateClaudeSessionId(
    channelId: string,
    sessionId: string,
    alias: string,
    claudeSessionId: string
  ): Promise<ChatSession | null> {
    const session = await this.getSession(channelId, sessionId);

    if (!session) {
      return null;
    }

    session.claudeSessionIds[alias] = claudeSessionId;
    session.updatedAt = new Date().toISOString();
    await this.updateSession(channelId, session);

    return session;
  }

  async deleteSession(channelId: string, sessionId: string): Promise<void> {
    const sessions = await this.listSessions(channelId);
    const filtered = sessions.filter((s) => s.sessionId !== sessionId);
    await this.writeSessions(channelId, filtered);

    // Remove the chat file. ENOENT is fine (nothing was written yet);
    // anything else — EACCES, EBUSY, EIO — is a real problem the caller
    // needs to see, not something to swallow silently.
    const chatPath = this.sessionChatPath(channelId, sessionId);
    try {
      await unlink(chatPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(
          `[session-store] failed to unlink chat file at ${chatPath}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        throw err;
      }
    }

    // Drop the coordination record so watchers see the session go away.
    // Tolerated to miss (no-op on ENOENT inside the store). Advisory —
    // swallow + warn so a coordination-store hiccup doesn't look like a
    // failed session deletion to the caller.
    try {
      await this.store.deleteDoc(
        STORE_NS.session,
        lockRecordId(channelId, sessionId)
      );
    } catch (err) {
      console.warn(
        `[session-store] coordination-record delete failed (channelId=${channelId}, sessionId=${sessionId}): ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  async appendMessage(
    channelId: string,
    sessionId: string,
    msg: PersistedChatMessage
  ): Promise<void> {
    await mkdir(this.sessionsDir(channelId), { recursive: true });
    const path = this.sessionChatPath(channelId, sessionId);
    const line = JSON.stringify(msg) + "\n";
    await appendFile(path, line, "utf8");

    // Update message count + timestamp
    const session = await this.getSession(channelId, sessionId);

    if (session) {
      session.messageCount += 1;
      session.updatedAt = new Date().toISOString();
      await this.updateSession(channelId, session);
    }
  }

  async updateLastMessage(
    channelId: string,
    sessionId: string,
    msg: PersistedChatMessage
  ): Promise<void> {
    const path = this.sessionChatPath(channelId, sessionId);

    let content: string;
    try {
      content = await readFile(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // No chat yet — fall through to append, same as the initial write.
        await this.appendMessage(channelId, sessionId, msg);
        return;
      }
      // EACCES / EIO / anything else is a real I/O problem; silently falling
      // through to `appendMessage` would duplicate the last message on the
      // on-disk transcript. Surface the error instead.
      throw new Error(
        `Failed to read chat transcript at ${path}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        { cause: err }
      );
    }

    const lines = content.trimEnd().split("\n");

    if (lines.length > 0) {
      lines[lines.length - 1] = JSON.stringify(msg);
    }

    await writeFile(path, lines.join("\n") + "\n", "utf8");
  }

  /**
   * Drop messages whose timestamp is >= `timestamp`. Rewrites the JSONL file
   * atomically (temp-file + rename) and updates `messageCount` on the index.
   * Returns the number of messages removed.
   *
   * Used by the rewind flow to roll the chat log back to a checkpoint. Treats
   * `timestamp` as a string comparison against the stored ISO8601 — safe
   * because ISO strings sort lexicographically in chronological order.
   */
  async truncateBeforeTimestamp(
    channelId: string,
    sessionId: string,
    timestamp: string
  ): Promise<number> {
    const path = this.sessionChatPath(channelId, sessionId);
    let content: string;
    try {
      content = await readFile(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return 0;
      }
      throw err;
    }
    const lines = content.trimEnd().split("\n").filter((l) => l.length > 0);
    const kept: string[] = [];
    let removed = 0;
    for (const line of lines) {
      try {
        const msg = JSON.parse(line) as PersistedChatMessage;
        if (msg.timestamp >= timestamp) {
          removed += 1;
          continue;
        }
        kept.push(line);
      } catch {
        // Preserve unparseable lines — don't silently lose data.
        kept.push(line);
      }
    }
    const next = kept.length > 0 ? kept.join("\n") + "\n" : "";
    const tmpPath = `${path}.tmp.${process.pid}.${sessionsTmpCounter++}`;
    await writeFile(tmpPath, next, "utf8");
    try {
      await rename(tmpPath, path);
    } catch (err) {
      await rm(tmpPath, { force: true }).catch(() => {});
      throw err;
    }

    const session = await this.getSession(channelId, sessionId);
    if (session) {
      session.messageCount = kept.length;
      session.updatedAt = new Date().toISOString();
      await this.updateSession(channelId, session);
    }
    return removed;
  }

  /**
   * Clear all Claude CLI session ids for a session. Used by rewind so that
   * the next message after a rollback starts a fresh Claude conversation
   * (Claude can't itself be rewound server-side).
   */
  async clearClaudeSessionIds(
    channelId: string,
    sessionId: string
  ): Promise<ChatSession | null> {
    const session = await this.getSession(channelId, sessionId);
    if (!session) return null;
    session.claudeSessionIds = {};
    session.updatedAt = new Date().toISOString();
    await this.updateSession(channelId, session);
    return session;
  }

  async loadMessages(
    channelId: string,
    sessionId: string,
    limit: number = 500
  ): Promise<PersistedChatMessage[]> {
    const path = this.sessionChatPath(channelId, sessionId);

    try {
      const content = await readFile(path, "utf8");
      const lines = content.trimEnd().split("\n").filter((l) => l.length > 0);
      const messages: PersistedChatMessage[] = [];

      // Note on line numbering: `slice(-limit)` means the loop index is the
      // offset within the tail window, not the true line number in the file.
      // We compute the real 1-based line number for the warning so operators
      // can jump directly to the corrupt entry without guesswork.
      const startLineNumber = lines.length - Math.min(limit, lines.length) + 1;
      const tail = lines.slice(-limit);
      for (let i = 0; i < tail.length; i += 1) {
        const line = tail[i];
        try {
          messages.push(JSON.parse(line) as PersistedChatMessage);
        } catch (err) {
          // Surface corruption instead of silently dropping — caller needs
          // to be able to see data loss / manual-edit damage.
          console.warn(
            `[session-store] skipping malformed JSONL line at ${path}:${
              startLineNumber + i
            }: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }

      return messages;
    } catch {
      return [];
    }
  }

  private async writeSessions(channelId: string, sessions: ChatSession[]): Promise<void> {
    const path = this.sessionsIndexPath(channelId);
    const dir = join(this.channelsDir, channelId);
    await mkdir(dir, { recursive: true });
    // Include pid + counter so concurrent writers in the same process don't
    // clobber each other's tmp file — matches `writeJsonAtomic` in file-store.
    const tmpPath = `${path}.tmp.${process.pid}.${sessionsTmpCounter++}`;
    await writeFile(tmpPath, JSON.stringify(sessions, null, 2), "utf8");
    try {
      await rename(tmpPath, path);
    } catch (err) {
      // Clean up the orphaned tmp on failure so the channel dir doesn't
      // accumulate dead files. Best-effort — caller needs the original
      // rename error, not a cleanup one.
      await rm(tmpPath, { force: true }).catch(() => {});
      throw new Error(
        `Failed to commit sessions index at ${path}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        { cause: err }
      );
    }
  }

  /**
   * Bump the `(session, <channelId>:<sessionId>)` coordination record
   * through the injected `HarnessStore`. Uses `mutate` to keep semantics
   * consistent across backends: on Postgres (T-402) this runs under
   * `pg_advisory_xact_lock`, on FileHarnessStore it serializes through
   * the in-process key-lock. Purely advisory — nothing reads this record
   * today, T-402 consumers layer on top.
   */
  private async touchLockRecord(
    channelId: string,
    sessionId: string,
    messageCount: number
  ): Promise<void> {
    // The on-disk session doc has already been written by the caller; this
    // coordination record is advisory (nothing reads it today, T-402
    // consumers layer on top). Swallow + warn rather than propagate so a
    // coordination-store hiccup doesn't look like a failed session write to
    // the caller. Mirrors the T-101 policy for channel-ticket coordination
    // records.
    try {
      await this.store.mutate<SessionLockRecord>(
        STORE_NS.session,
        lockRecordId(channelId, sessionId),
        () => ({
          updatedAt: new Date().toISOString(),
          messageCount
        })
      );
    } catch (err) {
      console.warn(
        `[session-store] coordination-record mutate failed (channelId=${channelId}, sessionId=${sessionId}, messageCount=${messageCount}): ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }
}
