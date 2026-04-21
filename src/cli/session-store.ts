import { appendFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
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
    try {
      const raw = await readFile(this.sessionsIndexPath(channelId), "utf8");
      const sessions = JSON.parse(raw) as ChatSession[];
      sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return sessions;
    } catch {
      return [];
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

    // Remove the chat file
    try {
      await unlink(this.sessionChatPath(channelId, sessionId));
    } catch {
      // File may not exist
    }

    // Drop the coordination record so watchers see the session go away.
    // Tolerated to miss (no-op on ENOENT inside the store).
    await this.store.deleteDoc(
      STORE_NS.session,
      lockRecordId(channelId, sessionId)
    );
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

    try {
      const content = await readFile(path, "utf8");
      const lines = content.trimEnd().split("\n");

      if (lines.length > 0) {
        lines[lines.length - 1] = JSON.stringify(msg);
      }

      await writeFile(path, lines.join("\n") + "\n", "utf8");
    } catch {
      // File doesn't exist — just append
      await this.appendMessage(channelId, sessionId, msg);
    }
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

      for (const line of lines.slice(-limit)) {
        try {
          messages.push(JSON.parse(line) as PersistedChatMessage);
        } catch {
          // Skip malformed lines
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
    const tmpPath = `${path}.tmp`;
    await writeFile(tmpPath, JSON.stringify(sessions, null, 2), "utf8");
    await rename(tmpPath, path);
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
    await this.store.mutate<SessionLockRecord>(
      STORE_NS.session,
      lockRecordId(channelId, sessionId),
      () => ({
        updatedAt: new Date().toISOString(),
        messageCount
      })
    );
  }
}
