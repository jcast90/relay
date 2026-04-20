import { mkdir, readFile, writeFile, readdir, unlink, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import { getRelayDir } from "../cli/paths.js";
import {
  buildCrosslinkId,
  CrosslinkSessionSchema,
  CrosslinkMessageSchema,
  type CrosslinkSession,
  type CrosslinkMessage,
  type MessageStatus,
  type MessageType
} from "./types.js";

const STALE_HEARTBEAT_MS = 120_000;
const MESSAGE_EXPIRY_MS = 3_600_000;

export class CrosslinkStore {
  readonly rootDir: string;
  private readonly sessionsDir: string;
  private readonly mailboxesDir: string;

  constructor(rootDir?: string) {
    this.rootDir = rootDir ?? join(getRelayDir(), "crosslink");
    this.sessionsDir = join(this.rootDir, "sessions");
    this.mailboxesDir = join(this.rootDir, "mailboxes");
  }

  // --- Session lifecycle ---

  async registerSession(
    session: Omit<CrosslinkSession, "sessionId" | "registeredAt" | "lastHeartbeat">
  ): Promise<CrosslinkSession> {
    await mkdir(this.sessionsDir, { recursive: true });

    const now = new Date().toISOString();
    const full: CrosslinkSession = {
      ...session,
      sessionId: buildCrosslinkId("session"),
      registeredAt: now,
      lastHeartbeat: now
    };

    await this.atomicWrite(
      join(this.sessionsDir, `${full.sessionId}.json`),
      JSON.stringify(full, null, 2)
    );

    await mkdir(join(this.mailboxesDir, full.sessionId), { recursive: true });

    return full;
  }

  async updateSession(
    sessionId: string,
    patch: Partial<Pick<CrosslinkSession, "description" | "capabilities" | "status">>
  ): Promise<CrosslinkSession | null> {
    const session = await this.readSession(sessionId);

    if (!session) {
      return null;
    }

    const updated: CrosslinkSession = {
      ...session,
      ...patch,
      lastHeartbeat: new Date().toISOString()
    };

    await this.atomicWrite(
      join(this.sessionsDir, `${sessionId}.json`),
      JSON.stringify(updated, null, 2)
    );

    return updated;
  }

  async updateHeartbeat(sessionId: string): Promise<void> {
    const session = await this.readSession(sessionId);

    if (!session) {
      return;
    }

    session.lastHeartbeat = new Date().toISOString();

    await this.atomicWrite(
      join(this.sessionsDir, `${sessionId}.json`),
      JSON.stringify(session, null, 2)
    );
  }

  async deregisterSession(sessionId: string): Promise<void> {
    try {
      await unlink(join(this.sessionsDir, `${sessionId}.json`));
    } catch {
      // Already removed
    }

    try {
      await rm(join(this.mailboxesDir, sessionId), { recursive: true, force: true });
    } catch {
      // Already removed
    }
  }

  async discoverSessions(): Promise<CrosslinkSession[]> {
    const files = await this.safeReaddir(this.sessionsDir);
    const sessions: CrosslinkSession[] = [];

    for (const file of files) {
      if (!file.endsWith(".json")) {
        continue;
      }

      const session = await this.readSessionFile(join(this.sessionsDir, file));

      if (!session) {
        continue;
      }

      const alive = isProcessAlive(session.pid);
      const heartbeatAge = Date.now() - new Date(session.lastHeartbeat).getTime();
      const stale = !alive && heartbeatAge > STALE_HEARTBEAT_MS;

      if (stale) {
        await this.deregisterSession(session.sessionId);
        continue;
      }

      sessions.push(session);
    }

    return sessions;
  }

  // --- Mailbox operations ---

  async sendMessage(input: {
    fromSessionId: string;
    toSessionId: string;
    content: string;
    type: MessageType;
    inReplyTo?: string;
  }): Promise<CrosslinkMessage> {
    const mailboxDir = join(this.mailboxesDir, input.toSessionId);
    await mkdir(mailboxDir, { recursive: true });

    const now = new Date().toISOString();
    const message: CrosslinkMessage = {
      messageId: buildCrosslinkId("msg"),
      fromSessionId: input.fromSessionId,
      toSessionId: input.toSessionId,
      type: input.type,
      content: input.content,
      inReplyTo: input.inReplyTo ?? null,
      status: "pending",
      createdAt: now,
      deliveredAt: null,
      repliedAt: null
    };

    await this.atomicWrite(
      join(mailboxDir, `${message.messageId}.json`),
      JSON.stringify(message, null, 2)
    );

    return message;
  }

  async pollMessages(sessionId: string): Promise<CrosslinkMessage[]> {
    const mailboxDir = join(this.mailboxesDir, sessionId);
    const files = await this.safeReaddir(mailboxDir);
    const messages: CrosslinkMessage[] = [];

    for (const file of files) {
      if (!file.endsWith(".json")) {
        continue;
      }

      const message = await this.readMessageFile(join(mailboxDir, file));

      if (!message || message.status !== "pending") {
        continue;
      }

      message.status = "delivered";
      message.deliveredAt = new Date().toISOString();

      await this.atomicWrite(
        join(mailboxDir, file),
        JSON.stringify(message, null, 2)
      );

      messages.push(message);
    }

    return messages;
  }

  async updateMessageStatus(
    sessionId: string,
    messageId: string,
    status: MessageStatus
  ): Promise<void> {
    const filePath = join(this.mailboxesDir, sessionId, `${messageId}.json`);
    const message = await this.readMessageFile(filePath);

    if (!message) {
      return;
    }

    message.status = status;

    if (status === "replied") {
      message.repliedAt = new Date().toISOString();
    }

    await this.atomicWrite(filePath, JSON.stringify(message, null, 2));
  }

  async cleanExpiredMessages(): Promise<number> {
    const sessionDirs = await this.safeReaddir(this.mailboxesDir);
    let cleaned = 0;

    for (const dir of sessionDirs) {
      const mailboxDir = join(this.mailboxesDir, dir);
      const files = await this.safeReaddir(mailboxDir);

      for (const file of files) {
        if (!file.endsWith(".json")) {
          continue;
        }

        const message = await this.readMessageFile(join(mailboxDir, file));

        if (!message) {
          continue;
        }

        const age = Date.now() - new Date(message.createdAt).getTime();

        if (message.status === "pending" && age > MESSAGE_EXPIRY_MS) {
          message.status = "expired";
          await this.atomicWrite(
            join(mailboxDir, file),
            JSON.stringify(message, null, 2)
          );
          cleaned += 1;
        }
      }
    }

    return cleaned;
  }

  // --- Internal helpers ---

  private async readSession(sessionId: string): Promise<CrosslinkSession | null> {
    return this.readSessionFile(join(this.sessionsDir, `${sessionId}.json`));
  }

  private async readSessionFile(path: string): Promise<CrosslinkSession | null> {
    try {
      const raw = JSON.parse(await readFile(path, "utf8"));
      return CrosslinkSessionSchema.parse(raw);
    } catch {
      return null;
    }
  }

  private async readMessageFile(path: string): Promise<CrosslinkMessage | null> {
    try {
      const raw = JSON.parse(await readFile(path, "utf8"));
      return CrosslinkMessageSchema.parse(raw);
    } catch {
      return null;
    }
  }

  private async safeReaddir(dir: string): Promise<string[]> {
    try {
      return await readdir(dir);
    } catch {
      return [];
    }
  }

  private async atomicWrite(path: string, data: string): Promise<void> {
    const tmpPath = `${path}.tmp.${process.pid}`;
    await writeFile(tmpPath, data);
    await rename(tmpPath, path);
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
