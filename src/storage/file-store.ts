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
import { dirname, join } from "node:path";

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
 * locks, etc.) is explicitly out of scope here — use `PostgresHarnessStore`
 * when multiple processes need to share the same state.
 */

// Per-key mutex shared across all store instances. Keyed by "${ns}\0${id}"
// so the same key in two FileHarnessStore instances in the same process
// still serializes (they back to the same file on disk).
const keyLocks: Map<string, Promise<void>> = new Map();

// Monotonic suffix so two concurrent writers in the same process never
// collide on a tmp-file name.
let tmpCounter = 0;

/**
 * Reject path segments that could escape `rootDir` via traversal (`..`),
 * collapse to the parent (`.`), pierce a directory boundary (`/`, `\`), or
 * trip the kernel's null-byte guard. Called on every path-segment input at
 * the entry of every public method that path-joins caller-controlled data —
 * a malicious caller controlling the segment would otherwise be able to
 * read/write arbitrary files under the process's uid.
 *
 * `kind` is only used in the error message; callers pass whatever label
 * identifies the segment in their API (`"ns"`, `"id"`, `"channelId"`, …).
 */
export function assertSafeSegment(segment: string, kind: string): void {
  if (
    segment === "" ||
    segment === "." ||
    segment === ".." ||
    segment.includes("/") ||
    segment.includes("\\") ||
    segment.includes("\0")
  ) {
    throw new Error(`Unsafe path segment in ${kind}: ${segment}`);
  }
}

export class FileHarnessStore implements HarnessStore {
  private readonly rootDir: string;

  constructor(rootDir?: string) {
    this.rootDir = rootDir ?? join(homedir(), ".relay");
  }

  async getDoc<T>(ns: string, id: string): Promise<T | null> {
    assertSafeSegment(ns, "ns");
    assertSafeSegment(id, "id");
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
      // Callers rely on corrupt→throw to avoid overwriting real data via a
      // subsequent putDoc.
      throw new Error(
        `Corrupt doc at ${path}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  async putDoc<T>(ns: string, id: string, doc: T): Promise<void> {
    assertSafeSegment(ns, "ns");
    assertSafeSegment(id, "id");
    const path = this.docPath(ns, id);
    await this.writeJsonAtomic(path, doc);
  }

  async listDocs<T>(ns: string, prefix?: string): Promise<T[]> {
    assertSafeSegment(ns, "ns");
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
    assertSafeSegment(ns, "ns");
    assertSafeSegment(id, "id");
    const path = this.docPath(ns, id);
    try {
      await rm(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
  }

  async appendLog(ns: string, id: string, entry: unknown): Promise<void> {
    assertSafeSegment(ns, "ns");
    assertSafeSegment(id, "id");
    const path = this.logPath(ns, id);
    await mkdir(this.nsDir(ns), { recursive: true });
    await appendFile(path, JSON.stringify(entry) + "\n");
  }

  async readLog<T>(
    ns: string,
    id: string,
    opts?: ReadLogOptions
  ): Promise<T[]> {
    assertSafeSegment(ns, "ns");
    assertSafeSegment(id, "id");
    const path = this.logPath(ns, id);
    let raw: string;

    try {
      raw = await readFile(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }

    const lines = raw.split("\n").filter(Boolean);
    const entries: T[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      try {
        entries.push(JSON.parse(line) as T);
      } catch (err) {
        // Match `getDoc`'s corruption posture: surface with file + line so
        // operators can repair instead of silently dropping the bad record.
        throw new Error(
          `Corrupt log at ${path} line ${i}: ${
            err instanceof Error ? err.message : String(err)
          }`,
          { cause: err }
        );
      }
    }

    let filtered = entries;
    if (opts?.after !== undefined) {
      const cursor = opts.after;
      const idx = filtered.findIndex(
        (e) => cursorKey(e) !== undefined && cursorKey(e) === cursor
      );
      // Cursor not found → return []. Returning the full log would cause
      // duplicate delivery on resume; the contract is documented on
      // `ReadLogOptions.after`.
      filtered = idx >= 0 ? filtered.slice(idx + 1) : [];
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
    assertSafeSegment(ns, "ns");
    assertSafeSegment(id, "id");
    const path = this.blobPath(ns, id);
    const metaPath = `${path}.meta.json`;
    await mkdir(this.nsDir(ns), { recursive: true });

    const hasMeta = meta !== undefined && Object.keys(meta).length > 0;
    const blobTmp = `${path}.tmp.${process.pid}.${tmpCounter++}`;
    const metaTmp = hasMeta
      ? `${metaPath}.tmp.${process.pid}.${tmpCounter++}`
      : null;

    // Stage both tmp files BEFORE either rename so we never end up with a
    // durable blob that's missing its sidecar metadata.
    await writeFile(blobTmp, bytes);
    if (metaTmp !== null && meta !== undefined) {
      await writeFile(metaTmp, JSON.stringify(meta, null, 2));
    }

    try {
      await rename(blobTmp, path);
    } catch (err) {
      await rm(blobTmp, { force: true }).catch(() => {});
      if (metaTmp !== null) {
        await rm(metaTmp, { force: true }).catch(() => {});
      }
      throw err;
    }

    if (metaTmp !== null) {
      try {
        await rename(metaTmp, metaPath);
      } catch (err) {
        // Blob is already durable; roll it back so the caller isn't left
        // holding a blob without its declared contentType.
        await rm(path, { force: true }).catch(() => {});
        await rm(metaTmp, { force: true }).catch(() => {});
        throw new Error(
          `Failed to commit blob meta sidecar at ${metaPath}: ${
            err instanceof Error ? err.message : String(err)
          }`,
          { cause: err }
        );
      }
    }

    return {
      ns,
      id,
      size: bytes.byteLength,
      contentType: hasMeta ? meta?.["contentType"] : undefined
    };
  }

  async getBlob(ref: BlobRef): Promise<Uint8Array> {
    assertSafeSegment(ref.ns, "ns");
    assertSafeSegment(ref.id, "id");
    const path = this.blobPath(ref.ns, ref.id);
    const buf = await readFile(path);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  async mutate<T>(
    ns: string,
    id: string,
    fn: (prev: T | null) => T
  ): Promise<T> {
    assertSafeSegment(ns, "ns");
    assertSafeSegment(id, "id");
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
   *
   * Poll interval is 250ms — balances promptness vs CPU and matches the
   * at-least-once coalescing contract consumers already need to tolerate
   * for the Postgres `LISTEN/NOTIFY` implementation. `fs.watch` was
   * rejected due to platform-specific quirks (macOS coalescing, Linux
   * non-recursive behavior on subdir creation).
   *
   * Error semantics: if `stat` on a tracked path fails with anything other
   * than `ENOENT` (e.g. `EACCES` after a `chmod`), the iterator throws
   * from its next iteration and terminates. A silent watch that stops
   * emitting was considered worse than a loud failure — callers can
   * observe the throw and decide whether to retry.
   */
  async *watch(ns: string, id: string): AsyncIterable<ChangeEvent> {
    assertSafeSegment(ns, "ns");
    assertSafeSegment(id, "id");
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
    const dir = dirname(path);
    await mkdir(dir, { recursive: true });

    const tmpPath = `${path}.tmp.${process.pid}.${tmpCounter++}`;
    await writeFile(tmpPath, JSON.stringify(doc, null, 2));
    try {
      await rename(tmpPath, path);
    } catch (err) {
      // Legitimately best-effort — we're already in an error path and the
      // caller needs to see the original rename failure, not a cleanup one.
      await rm(tmpPath, { force: true }).catch(() => {});
      throw err;
    }
  }
}

/**
 * Serialize work keyed by (ns, id) through an in-process Promise-chain
 * mutex. Chain of tail promises per key; each caller awaits the previous
 * tail and installs its own. Self-cleans when no successor is queued.
 * In-process only.
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
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

async function readMtimes(paths: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const p of paths) {
    try {
      const s = await stat(p);
      out.set(p, s.mtimeMs);
    } catch (err) {
      // Missing file is fine — we'll detect creation on the next poll.
      // Any other error (permissions, I/O) is surfaced so the watch
      // iterator throws instead of going silent.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
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
