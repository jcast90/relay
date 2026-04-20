import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type {
  BlobRef,
  ChangeEvent,
  HarnessStore,
  ReadLogOptions
} from "./store.js";

/**
 * Filesystem-backed implementation of `HarnessStore`. Layout under `rootDir`:
 *
 *   ${root}/${ns}/${id}.json          docs
 *   ${root}/${ns}/${id}.jsonl         logs
 *   ${root}/${ns}/${id}.blob          blob bytes
 *   ${root}/${ns}/${id}.blob.meta.json optional sidecar metadata
 *
 * Doc and blob writes are atomic via tmp-file + rename. `mutate` serializes
 * per (ns, id) through an in-process Promise-chain mutex so concurrent
 * callers in the same process can't lose updates on a read-modify-write.
 *
 * Single-process only: cross-process coordination (flock, Postgres advisory
 * locks, etc.) is explicitly out of scope here — use `PgHarnessStore` from
 * T-402 when multiple processes need to share the same state.
 */

// Per-key mutex shared across all store instances. Keyed by "${ns}\0${id}"
// so the same key in two FileHarnessStore instances in the same process
// still serializes (they back to the same file on disk).
const keyLocks: Map<string, Promise<void>> = new Map();

// Monotonic suffix so two concurrent writers in the same process never
// collide on a tmp-file name.
let tmpCounter = 0;

export class FileHarnessStore implements HarnessStore {
  private readonly rootDir: string;

  constructor(rootDir?: string) {
    this.rootDir = rootDir ?? join(homedir(), ".relay");
  }

  async getDoc<T>(ns: string, id: string): Promise<T | null> {
    const path = this.docPath(ns, id);
    let content: string;

    try {
      content = await readFile(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw new Error(
        `Failed to read doc at ${path}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }

    try {
      return JSON.parse(content) as T;
    } catch (err) {
      // Surface corruption so callers don't silently overwrite via putDoc.
      // Mirrors the pattern `readChannelTickets` uses on the ticket board.
      throw new Error(
        `Corrupt doc at ${path}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  async putDoc<T>(ns: string, id: string, doc: T): Promise<void> {
    const path = this.docPath(ns, id);
    await this.writeJsonAtomic(path, doc);
  }

  async listDocs<T>(ns: string, prefix?: string): Promise<T[]> {
    const dir = this.nsDir(ns);
    const files = await safeReaddir(dir);
    const ids = files
      .filter((f) => f.endsWith(".json") && !f.endsWith(".blob.meta.json"))
      .map((f) => f.slice(0, -".json".length))
      .filter((stem) => !prefix || stem.startsWith(prefix))
      .sort();

    const out: T[] = [];
    for (const stem of ids) {
      const doc = await this.getDoc<T>(ns, stem);
      if (doc !== null) out.push(doc);
    }
    return out;
  }

  async deleteDoc(ns: string, id: string): Promise<void> {
    const path = this.docPath(ns, id);
    try {
      await rm(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
  }

  async appendLog(ns: string, id: string, entry: unknown): Promise<void> {
    const path = this.logPath(ns, id);
    await mkdir(this.nsDir(ns), { recursive: true });
    await appendFile(path, JSON.stringify(entry) + "\n");
  }

  async readLog<T>(
    ns: string,
    id: string,
    opts?: ReadLogOptions
  ): Promise<T[]> {
    const path = this.logPath(ns, id);
    let raw: string;

    try {
      raw = await readFile(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }

    const entries = raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as T);

    let filtered = entries;
    if (opts?.after !== undefined) {
      const cursor = opts.after;
      const idx = filtered.findIndex(
        (e) => cursorKey(e) !== undefined && cursorKey(e) === cursor
      );
      filtered = idx >= 0 ? filtered.slice(idx + 1) : filtered;
    }
    if (opts?.limit !== undefined && opts.limit < filtered.length) {
      filtered = filtered.slice(-opts.limit);
    }

    return filtered;
  }

  async putBlob(
    ns: string,
    id: string,
    bytes: Uint8Array,
    meta?: Record<string, string>
  ): Promise<BlobRef> {
    const path = this.blobPath(ns, id);
    await mkdir(this.nsDir(ns), { recursive: true });

    const tmpPath = `${path}.tmp.${process.pid}.${tmpCounter++}`;
    await writeFile(tmpPath, bytes);
    await rename(tmpPath, path);

    let contentType: string | undefined;
    if (meta && Object.keys(meta).length > 0) {
      await this.writeJsonAtomic(`${path}.meta.json`, meta);
      contentType = meta["contentType"];
    }

    return {
      ns,
      id,
      size: bytes.byteLength,
      contentType
    };
  }

  async getBlob(ref: BlobRef): Promise<Uint8Array> {
    const path = this.blobPath(ref.ns, ref.id);
    const buf = await readFile(path);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  async mutate<T>(
    ns: string,
    id: string,
    fn: (prev: T | null) => T
  ): Promise<T> {
    return withKeyLock(ns, id, async () => {
      const prev = await this.getDoc<T>(ns, id);
      const next = fn(prev);
      await this.putDoc<T>(ns, id, next);
      return next;
    });
  }

  /**
   * Poll the doc/log/blob file on disk for mtime changes and yield a
   * `ChangeEvent` each time one is observed. At-least-once delivery, may
   * coalesce across rapid writes, no cross-namespace ordering. Cleans up
   * when the iterator is returned (break out of `for await`) so callers
   * don't leak the polling interval.
   */
  async *watch(ns: string, id: string): AsyncIterable<ChangeEvent> {
    const pollIntervalMs = 250;
    const candidates = [
      this.docPath(ns, id),
      this.logPath(ns, id),
      this.blobPath(ns, id)
    ];

    let lastMtimes = await readMtimes(candidates);
    let closed = false;

    try {
      while (!closed) {
        await sleep(pollIntervalMs);
        if (closed) break;

        const next = await readMtimes(candidates);
        const event = diffMtimes(lastMtimes, next, ns, id);
        lastMtimes = next;
        if (event) yield event;
      }
    } finally {
      closed = true;
    }
  }

  private nsDir(ns: string): string {
    return join(this.rootDir, ns);
  }

  private docPath(ns: string, id: string): string {
    return join(this.nsDir(ns), `${id}.json`);
  }

  private logPath(ns: string, id: string): string {
    return join(this.nsDir(ns), `${id}.jsonl`);
  }

  private blobPath(ns: string, id: string): string {
    return join(this.nsDir(ns), `${id}.blob`);
  }

  private async writeJsonAtomic(path: string, doc: unknown): Promise<void> {
    const dir = path.slice(0, path.lastIndexOf("/"));
    await mkdir(dir, { recursive: true });

    const tmpPath = `${path}.tmp.${process.pid}.${tmpCounter++}`;
    await writeFile(tmpPath, JSON.stringify(doc, null, 2));
    await rename(tmpPath, path);
  }
}

/**
 * Serialize work keyed by (ns, id) through an in-process Promise-chain
 * mutex. Matches the shape of `withChannelLock` in `channel-store.ts`: the
 * tail promise in the map is what the next caller awaits, and the entry
 * self-cleans when no successor has queued behind it. In-process only.
 */
async function withKeyLock<T>(
  ns: string,
  id: string,
  fn: () => Promise<T>
): Promise<T> {
  const key = `${ns}\u0000${id}`;
  const prev = keyLocks.get(key) ?? Promise.resolve();
  let resolveCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    resolveCurrent = resolve;
  });
  const next = prev.then(() => current);
  keyLocks.set(key, next);

  try {
    await prev;
    return await fn();
  } finally {
    resolveCurrent();
    if (keyLocks.get(key) === next) {
      keyLocks.delete(key);
    }
  }
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

async function readMtimes(paths: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const p of paths) {
    try {
      const s = await stat(p);
      out.set(p, s.mtimeMs);
    } catch {
      // Missing file is fine; we'll detect creation on the next poll.
    }
  }
  return out;
}

function diffMtimes(
  prev: Map<string, number>,
  next: Map<string, number>,
  ns: string,
  id: string
): ChangeEvent | null {
  for (const [path, mtime] of next) {
    const before = prev.get(path);
    if (before === undefined) {
      return { ns, id, kind: path.endsWith(".jsonl") ? "append" : "put" };
    }
    if (before !== mtime) {
      return { ns, id, kind: path.endsWith(".jsonl") ? "append" : "put" };
    }
  }
  for (const path of prev.keys()) {
    if (!next.has(path)) {
      return { ns, id, kind: "delete" };
    }
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Extract a cursor key from a log entry for `ReadLogOptions.after`. We try
 * common id/timestamp field names so the primitive is useful without
 * forcing every log writer to conform to one shape; callers that need a
 * stricter contract can pass `limit` only.
 */
function cursorKey(entry: unknown): string | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const e = entry as Record<string, unknown>;
  for (const field of ["id", "entryId", "eventId", "timestamp", "createdAt"]) {
    const v = e[field];
    if (typeof v === "string") return v;
  }
  return undefined;
}
