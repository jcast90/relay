/**
 * AL-16 cross-process IPC bridge.
 *
 * Problem shape: the Coordinator lives in the parent Node process, but
 * each repo-admin's MCP server runs in a child process spawned by the
 * Claude CLI. In-process code wires a Coordinator reference into the MCP
 * server directly; child-process MCP servers never see it.
 *
 * Solution: file-based message queue per alias under
 * `~/.relay/sessions/<sessionId>/coordination/`:
 *
 *   - `outbox-<alias>.jsonl`: the CHILD's `coordination_send` appends when
 *     the in-process Coordinator is unavailable. The PARENT tails these.
 *   - `inbox-<alias>.jsonl`: the PARENT appends after a successful
 *     `coordinator.send`. The CHILD's `coordination_receive` tool reads
 *     from this, tracking a cursor in `inbox-cursor-<alias>.json` so
 *     prior messages don't get redelivered.
 *
 * Polling model: the parent bridge scans each registered alias's outbox
 * file on an interval (`~250ms` default), parses any new lines, and
 * routes them via the real Coordinator. Append-only JSONL + a byte-
 * offset cursor (not file-size-based so a torn trailing line is OK)
 * means the parent never re-routes what it has already seen.
 */

import { EventEmitter } from "node:events";
import { mkdir, stat, readFile, appendFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { Coordinator } from "./coordinator.js";
import { parseCoordinationMessage, type CoordinationMessage } from "./messages.js";
import { getOutboxPath, getInboxPath, getCoordinationDir } from "./ipc-paths.js";

/** Default poll cadence for tailing outbox files. */
export const DEFAULT_POLL_INTERVAL_MS = 250;

/**
 * Wire-format record appended to an outbox / inbox JSONL line. Both ends
 * of the bridge produce the same shape so `parseIpcRecord` can be reused
 * for parent-side outbox reads and child-side inbox reads.
 */
export interface IpcRecord {
  id: string;
  from: string;
  to: string;
  payload: Record<string, unknown>;
  writtenAt: string;
}

export interface IpcBridgeOptions {
  sessionId: string;
  coordinator: Coordinator;
  rootDir?: string;
  /** Poll interval in ms. Defaults to {@link DEFAULT_POLL_INTERVAL_MS}. */
  pollIntervalMs?: number;
  /** Injected clock for deterministic tests. Defaults to `Date.now`. */
  clock?: () => number;
  /**
   * Injected error sink. Bridge I/O errors land here instead of throwing
   * so the driver doesn't crash mid-poll. Defaults to `console.warn`.
   */
  onError?: (message: string, error: unknown) => void;
}

export type IpcBridgeEvent =
  | { kind: "routed"; alias: string; record: IpcRecord }
  | { kind: "parse-failure"; alias: string; raw: string; detail: string }
  | { kind: "route-failure"; alias: string; record: IpcRecord; detail: string };

interface OutboxState {
  alias: string;
  path: string;
  /** Byte offset we've already routed past. */
  cursor: number;
}

/**
 * Parent-side tail + route loop. Hand it a {@link Coordinator} and a set
 * of aliases to watch; it polls each alias's outbox file and routes new
 * messages through the live bus. Also writes the receiver's inbox file
 * on success so the target child can pick the message up on its next
 * `coordination_receive` call.
 */
export class IpcBridge extends EventEmitter {
  private readonly sessionId: string;
  private readonly coordinator: Coordinator;
  private readonly rootDir: string | undefined;
  private readonly pollIntervalMs: number;
  private readonly clock: () => number;
  private readonly onError: (message: string, error: unknown) => void;

  private readonly outboxes = new Map<string, OutboxState>();
  private poller: NodeJS.Timeout | null = null;
  private stopped = false;
  private polling = false;

  constructor(opts: IpcBridgeOptions) {
    super();
    this.sessionId = opts.sessionId;
    this.coordinator = opts.coordinator;
    this.rootDir = opts.rootDir;
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.clock = opts.clock ?? (() => Date.now());
    this.onError =
      opts.onError ??
      ((message, error) => {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(`[ipc-bridge] ${message}: ${detail}`);
      });
  }

  /**
   * Add an alias to the watch set. Idempotent. Calling `registerAlias`
   * multiple times for the same alias doesn't reset the cursor — the
   * bridge remembers what it has already routed.
   */
  registerAlias(alias: string): void {
    if (this.outboxes.has(alias)) return;
    this.outboxes.set(alias, {
      alias,
      path: getOutboxPath(this.sessionId, alias, this.rootDir),
      cursor: 0,
    });
  }

  /** Start the poll loop. Idempotent. */
  async start(): Promise<void> {
    if (this.stopped) return;
    if (this.poller) return;
    await mkdir(getCoordinationDir(this.sessionId, this.rootDir), { recursive: true });
    // Seed each outbox cursor to the end-of-file so pre-existing messages
    // from a prior session don't get re-routed. The child's side is also
    // append-only; a fresh run starts from "no new messages".
    for (const state of this.outboxes.values()) {
      state.cursor = await fileSize(state.path);
    }
    this.poller = setInterval(() => void this.drainOnce(), this.pollIntervalMs);
    // Don't hold the event loop open if this is the only handle.
    (this.poller as unknown as { unref?: () => void }).unref?.();
  }

  /**
   * Graceful shutdown. Clears the timer, awaits any in-flight poll, and
   * marks the bridge as stopped so calls to `start()` after this are no-ops.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.poller) {
      clearInterval(this.poller);
      this.poller = null;
    }
    // Settle the in-flight drain if one is running.
    while (this.polling) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  /**
   * One drain pass — exported for tests so they can advance the bridge
   * without waiting on the real setInterval cadence.
   */
  async drainOnce(): Promise<void> {
    if (this.stopped || this.polling) return;
    this.polling = true;
    try {
      for (const state of this.outboxes.values()) {
        await this.drainOutbox(state);
      }
    } finally {
      this.polling = false;
    }
  }

  private async drainOutbox(state: OutboxState): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(state.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      this.onError(`read outbox ${state.alias}`, err);
      return;
    }
    if (raw.length <= state.cursor) return;

    const chunk = raw.slice(state.cursor);
    const lines = chunk.split("\n");
    // A trailing partial line (crash mid-write) is skipped until the next
    // drain, when either the writer completes it or the reader sees EOF.
    const complete = raw.endsWith("\n") ? lines.filter((l) => l.length > 0) : lines.slice(0, -1);
    // Advance cursor past the last fully-parsed line. If the final line
    // is partial, leave the cursor on its starting byte so we retry next
    // tick once the writer flushes its newline.
    let consumed = 0;
    for (let i = 0; i < lines.length; i += 1) {
      const isLast = i === lines.length - 1;
      if (isLast && !raw.endsWith("\n")) break;
      consumed += lines[i].length + 1; // +1 for '\n'
    }
    state.cursor += consumed;

    for (const line of complete) {
      const record = parseIpcRecord(line);
      if (!record) {
        this.emit("ipc-event", {
          kind: "parse-failure",
          alias: state.alias,
          raw: line,
          detail: "malformed JSON or missing required fields",
        } satisfies IpcBridgeEvent);
        continue;
      }
      await this.routeRecord(record, state.alias);
    }
  }

  private async routeRecord(record: IpcRecord, outboxAlias: string): Promise<void> {
    // `from` SHOULD match the outbox alias (the child writing to its own
    // outbox). If it doesn't, the coordinator's own spoof guard catches
    // it — we still attempt the send so the rejection is logged.
    const result = await this.coordinator.send(record.from, record.to, record.payload);
    if (!result.ok) {
      this.emit("ipc-event", {
        kind: "route-failure",
        alias: outboxAlias,
        record,
        detail: result.reason,
      } satisfies IpcBridgeEvent);
      return;
    }
    // Mirror the message into the target's inbox so their next
    // `coordination_receive` sees it. The coordinator already delivered
    // in-process (for any in-process subscriber) but the target child
    // process only sees the file.
    try {
      const inboxPath = getInboxPath(this.sessionId, record.to, this.rootDir);
      await mkdir(dirname(inboxPath), { recursive: true });
      await appendFile(inboxPath, JSON.stringify(record) + "\n");
    } catch (err) {
      this.onError(`write inbox ${record.to}`, err);
    }
    this.emit("ipc-event", {
      kind: "routed",
      alias: outboxAlias,
      record,
    } satisfies IpcBridgeEvent);
  }
}

async function fileSize(path: string): Promise<number> {
  try {
    const s = await stat(path);
    return s.size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
}

/**
 * Shared wire-format parser. Exported so the child's `coordination_receive`
 * can decode inbox lines with the exact same schema the bridge emits.
 */
export function parseIpcRecord(line: string): IpcRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const rec = parsed as Record<string, unknown>;
  const { id, from, to, payload, writtenAt } = rec;
  if (typeof id !== "string" || !id) return null;
  if (typeof from !== "string" || !from) return null;
  if (typeof to !== "string" || !to) return null;
  if (!payload || typeof payload !== "object") return null;
  if (typeof writtenAt !== "string" || !writtenAt) return null;
  // We don't zod-check the payload here — the parent's coordinator.send
  // does that authoritatively. A malformed payload results in a
  // route-failure event on the bridge, not a silent drop.
  return { id, from, to, payload: payload as Record<string, unknown>, writtenAt };
}

/**
 * Helper used by the child MCP process's fallback path when the in-
 * process Coordinator is unavailable. Appends to the outbox JSONL.
 * Atomic up to POSIX `PIPE_BUF` for a single-process appender; the
 * parent's reader tolerates torn trailing lines (see {@link IpcBridge.drainOutbox}).
 */
export async function writeOutboxRecord(
  sessionId: string,
  alias: string,
  record: IpcRecord,
  rootDir?: string
): Promise<void> {
  const path = getOutboxPath(sessionId, alias, rootDir);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(record) + "\n");
}

/** Persisted cursor for child-side inbox reads. */
export interface InboxCursor {
  /** Byte offset in the inbox file the child has already consumed. */
  offset: number;
}

/** Read the inbox cursor (defaulting to offset 0 when absent). */
export async function readInboxCursor(
  sessionId: string,
  alias: string,
  rootDir?: string
): Promise<InboxCursor> {
  const { getInboxCursorPath } = await import("./ipc-paths.js");
  const path = getInboxCursorPath(sessionId, alias, rootDir);
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as InboxCursor;
    if (typeof parsed?.offset === "number") return parsed;
  } catch {
    // fall through — cursor doesn't exist or is corrupted; start fresh.
  }
  return { offset: 0 };
}

/** Write the inbox cursor atomically (tmp + rename). */
export async function writeInboxCursor(
  sessionId: string,
  alias: string,
  cursor: InboxCursor,
  rootDir?: string
): Promise<void> {
  const { getInboxCursorPath } = await import("./ipc-paths.js");
  const path = getInboxCursorPath(sessionId, alias, rootDir);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(cursor));
  const { rename } = await import("node:fs/promises");
  await rename(tmp, path);
}

/**
 * Type guard so downstream consumers can narrow `unknown` coordinator
 * payloads before handing them to `parseCoordinationMessage`. Kept here
 * rather than on `parseCoordinationMessage` itself to avoid circular
 * import pressure on the schemas module.
 */
export function isCoordinationPayload(value: unknown): value is CoordinationMessage {
  return parseCoordinationMessage(value).ok;
}
