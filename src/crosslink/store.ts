import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { getRelayDir } from "../cli/paths.js";
import { buildHarnessStore } from "../storage/factory.js";
import { STORE_NS } from "../storage/namespaces.js";
import type { HarnessStore } from "../storage/store.js";
import {
  buildCrosslinkId,
  CrosslinkSessionSchema,
  CrosslinkMessageSchema,
  type CrosslinkSession,
  type CrosslinkMessage,
  type MessageStatus,
  type MessageType,
} from "./types.js";

const STALE_HEARTBEAT_MS = 120_000;
const MESSAGE_EXPIRY_MS = 3_600_000;

/**
 * Separator between `<toSessionId>` and `<messageId>` for mailbox doc ids.
 * Double-underscore is safe under `assertSafeSegment` (no `/`, `\`, `.`,
 * `..`, null, empty) and sessionIds/messageIds never contain it on their
 * own, so we can recover the pair by splitting on the first occurrence.
 * Chosen over `:` because some filesystems (Windows) reject colons in
 * filenames even though `FileHarnessStore` doesn't run there today — this
 * leaves the layout portable if that changes.
 */
const MAILBOX_ID_SEPARATOR = "__";

function mailboxId(toSessionId: string, messageId: string): string {
  return `${toSessionId}${MAILBOX_ID_SEPARATOR}${messageId}`;
}

function mailboxPrefix(toSessionId: string): string {
  return `${toSessionId}${MAILBOX_ID_SEPARATOR}`;
}

function isMailboxFor(docId: string, toSessionId: string): boolean {
  return docId.startsWith(mailboxPrefix(toSessionId));
}

/**
 * Paths we've already warned about in this process. T-104 moved crosslink
 * state from `<relayDir>/crosslink/{sessions,mailboxes}/` to the flat
 * HarnessStore namespaces (`crosslink-session/`, `crosslink-mailbox/`).
 * Deployments upgrading past that change keep the legacy directories on
 * disk as orphans; surface one warn per CrosslinkStore-root pair so the
 * operator knows pending messages in the old tree will never reach agents.
 * Exposed via `__resetLegacyLayoutWarnings` for tests.
 */
const warnedLegacyRoots = new Set<string>();

export function __resetLegacyLayoutWarnings(): void {
  warnedLegacyRoots.clear();
}

function hasNonEmptyDir(path: string): boolean {
  try {
    const st = statSync(path);
    if (!st.isDirectory()) return false;
    return readdirSync(path).length > 0;
  } catch {
    return false;
  }
}

function warnIfLegacyLayoutPresent(baseDir: string): void {
  const legacyRoot = join(baseDir, "crosslink");
  if (warnedLegacyRoots.has(legacyRoot)) return;

  const legacySessionsDir = join(legacyRoot, "sessions");
  const legacyMailboxesDir = join(legacyRoot, "mailboxes");

  if (hasNonEmptyDir(legacySessionsDir) || hasNonEmptyDir(legacyMailboxesDir)) {
    warnedLegacyRoots.add(legacyRoot);
    console.warn(
      `[crosslink] legacy layout detected at ${legacyRoot}. ` +
        `T-104 moved crosslink state to HarnessStore namespaces. ` +
        `Existing sessions and pending messages will not be migrated ` +
        `automatically — they become orphans. See PR #33 for context.`
    );
  }
}

export class CrosslinkStore {
  /**
   * Retained for back-compat with external code that reads the legacy
   * `crosslink/` directory layout (e.g. the generated crosslink hook node
   * script baked by `generateHookScripts` into the user's home). Not used
   * by this class anymore — all reads and writes go through `HarnessStore`.
   *
   * Points at `<store-root>/crosslink` when a HarnessStore is injected with
   * a known rootDir, else falls back to `<relayDir>/crosslink`. The hook
   * script no longer depends on this path at runtime; the shim is kept so
   * integration callers that still read `store.rootDir` compile.
   */
  readonly rootDir: string;
  private readonly store: HarnessStore;

  /**
   * @param rootDir Legacy-compat hint only — preserved so pre-T-104 callers
   *   that pass an explicit dir (primarily tests) continue to compile. The
   *   backing store is the authoritative source of truth.
   * @param store `HarnessStore` for the new namespaced layout. Defaults to
   *   the process-wide instance via `buildHarnessStore()`. Tests inject a
   *   fresh `FileHarnessStore(tmpDir)` or a fake.
   *
   * When tests pass a `rootDir` but no `store`, we build a dedicated
   * FileHarnessStore rooted at `rootDir`'s parent so the new ns-layout
   * doesn't collide with the user's real store — this keeps the existing
   * `new CrosslinkStore(tmpDir)` test ergonomics working.
   */
  constructor(rootDir?: string, store?: HarnessStore) {
    this.rootDir = rootDir ?? join(getRelayDir(), "crosslink");
    if (store) {
      this.store = store;
    } else if (rootDir) {
      // Test path: rootDir passed without a store. Build one scoped to that
      // directory so a test's crosslink state stays isolated from ~/.relay.
      // `FileHarnessStore` uses `<root>/<ns>/<id>.json` which, with ns
      // `crosslink-session`/`crosslink-mailbox`, keeps fixtures hermetic.
      this.store = buildHarnessStore({ fileRoot: rootDir });
    } else {
      this.store = buildHarnessStore();
    }

    // One-shot check: the pre-T-104 layout was
    // `<relayDir>/crosslink/{sessions,mailboxes}/*.json`. If that tree is
    // still present, surface a warn so operators know the orphaned data
    // won't be migrated automatically. Runs once per distinct legacy root
    // per process (see `warnedLegacyRoots`). `rootDir` in the test path
    // already points at a HarnessStore root, not a relay root, so callers
    // driving tests against isolated scratch dirs won't emit the warn
    // unless they explicitly seed the legacy tree.
    const legacyCheckBase = rootDir ?? getRelayDir();
    warnIfLegacyLayoutPresent(legacyCheckBase);
  }

  // --- Session lifecycle ---

  async registerSession(
    session: Omit<CrosslinkSession, "sessionId" | "registeredAt" | "lastHeartbeat">
  ): Promise<CrosslinkSession> {
    const now = new Date().toISOString();
    const full: CrosslinkSession = {
      ...session,
      sessionId: buildCrosslinkId("session"),
      registeredAt: now,
      lastHeartbeat: now,
    };

    await this.store.putDoc(STORE_NS.crosslinkSession, full.sessionId, full);
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
      lastHeartbeat: new Date().toISOString(),
    };

    await this.store.putDoc(STORE_NS.crosslinkSession, sessionId, updated);
    return updated;
  }

  async updateHeartbeat(sessionId: string): Promise<void> {
    const session = await this.readSession(sessionId);

    if (!session) {
      return;
    }

    session.lastHeartbeat = new Date().toISOString();

    await this.store.putDoc(STORE_NS.crosslinkSession, sessionId, session);
  }

  async deregisterSession(sessionId: string): Promise<void> {
    await this.store.deleteDoc(STORE_NS.crosslinkSession, sessionId);

    // Drop this session's mailbox wholesale. Orphan replies addressed back to
    // a now-deregistered session would otherwise pile up forever.
    const mailboxDocs = await this.store.listDocs<unknown>(
      STORE_NS.crosslinkMailbox,
      mailboxPrefix(sessionId)
    );
    for (const doc of mailboxDocs) {
      const message = safeParseMessage(doc);
      if (!message) continue;
      await this.store.deleteDoc(
        STORE_NS.crosslinkMailbox,
        mailboxId(message.toSessionId, message.messageId)
      );
    }
  }

  async discoverSessions(): Promise<CrosslinkSession[]> {
    const raw = await this.store.listDocs<unknown>(STORE_NS.crosslinkSession);
    const sessions: CrosslinkSession[] = [];

    for (const doc of raw) {
      const session = safeParseSession(doc);

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
      repliedAt: null,
    };

    await this.store.putDoc(
      STORE_NS.crosslinkMailbox,
      mailboxId(input.toSessionId, message.messageId),
      message
    );

    return message;
  }

  async pollMessages(sessionId: string): Promise<CrosslinkMessage[]> {
    const docs = await this.store.listDocs<unknown>(
      STORE_NS.crosslinkMailbox,
      mailboxPrefix(sessionId)
    );
    const messages: CrosslinkMessage[] = [];

    for (const doc of docs) {
      const message = safeParseMessage(doc);

      if (!message || message.status !== "pending") {
        continue;
      }
      // `listDocs` doesn't filter by `toSessionId`, only by id prefix. The
      // separator guarantees the split is safe, but defense-in-depth keeps
      // cross-mailbox bleed impossible if a future sessionId ever contains
      // the separator.
      if (message.toSessionId !== sessionId) {
        continue;
      }

      message.status = "delivered";
      message.deliveredAt = new Date().toISOString();

      await this.store.putDoc(
        STORE_NS.crosslinkMailbox,
        mailboxId(sessionId, message.messageId),
        message
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
    const id = mailboxId(sessionId, messageId);
    const doc = await this.store.getDoc<unknown>(STORE_NS.crosslinkMailbox, id);
    const message = doc ? safeParseMessage(doc) : null;

    if (!message) {
      return;
    }

    message.status = status;

    if (status === "replied") {
      message.repliedAt = new Date().toISOString();
    }

    await this.store.putDoc(STORE_NS.crosslinkMailbox, id, message);
  }

  /**
   * Enumerate every pending inbound message addressed to `sessionId`,
   * without marking them as delivered. Used by `crosslink_reply` to find
   * the original message that a reply is targeting.
   */
  async listPendingMessages(sessionId: string): Promise<CrosslinkMessage[]> {
    const docs = await this.store.listDocs<unknown>(
      STORE_NS.crosslinkMailbox,
      mailboxPrefix(sessionId)
    );
    const out: CrosslinkMessage[] = [];
    for (const doc of docs) {
      const message = safeParseMessage(doc);
      if (!message) continue;
      if (message.toSessionId !== sessionId) continue;
      out.push(message);
    }
    return out;
  }

  async cleanExpiredMessages(): Promise<number> {
    const docs = await this.store.listDocs<unknown>(STORE_NS.crosslinkMailbox);
    let cleaned = 0;

    for (const doc of docs) {
      const message = safeParseMessage(doc);

      if (!message) {
        continue;
      }

      const age = Date.now() - new Date(message.createdAt).getTime();

      if (message.status === "pending" && age > MESSAGE_EXPIRY_MS) {
        message.status = "expired";
        await this.store.putDoc(
          STORE_NS.crosslinkMailbox,
          mailboxId(message.toSessionId, message.messageId),
          message
        );
        cleaned += 1;
      }
    }

    return cleaned;
  }

  // --- Internal helpers ---

  private async readSession(sessionId: string): Promise<CrosslinkSession | null> {
    const doc = await this.store.getDoc<unknown>(STORE_NS.crosslinkSession, sessionId);
    return doc ? safeParseSession(doc) : null;
  }
}

function safeParseSession(raw: unknown): CrosslinkSession | null {
  try {
    return CrosslinkSessionSchema.parse(raw);
  } catch {
    return null;
  }
}

function safeParseMessage(raw: unknown): CrosslinkMessage | null {
  try {
    return CrosslinkMessageSchema.parse(raw);
  } catch {
    return null;
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

// Re-exported so callers (hook generator, tools) share the same id scheme.
export { mailboxId, mailboxPrefix, isMailboxFor, MAILBOX_ID_SEPARATOR };
