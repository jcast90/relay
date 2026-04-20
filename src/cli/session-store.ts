import { appendFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  buildSessionId,
  type ChatSession,
  type PersistedChatMessage
} from "../domain/session.js";
import { getRelayDir } from "./paths.js";

export class SessionStore {
  private readonly channelsDir: string;

  constructor(channelsDir?: string) {
    this.channelsDir = channelsDir ?? join(getRelayDir(), "channels");
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
}
