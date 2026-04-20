/**
 * Pluggable storage surface for the harness. All persistent state the
 * orchestrator, chat channels, crosslink, and run history write today flows
 * through one of these four primitives:
 *
 *   - docs: namespaced JSON documents with full-overwrite semantics
 *   - logs: append-only event streams (events.jsonl, feed.jsonl, mailboxes)
 *   - blobs: opaque bytes (command stdout/stderr, design docs, uploads)
 *   - mutate: atomic read-modify-write for counters and indexes
 *
 * Callers use `watch` to observe downstream changes; the file impl polls,
 * the Postgres impl (T-402) will use `LISTEN/NOTIFY`. Semantics are
 * deliberately weak — at-least-once delivery, may coalesce, no ordering
 * guarantees across namespaces — so implementations can diverge on strategy
 * without breaking callers.
 */

export interface BlobRef {
  ns: string;
  id: string;
  size: number;
  contentType?: string;
}

export interface ChangeEvent {
  ns: string;
  id: string;
  kind: "put" | "delete" | "append";
}

export interface ReadLogOptions {
  /**
   * Exclusive cursor. The implementation extracts a string key from each
   * entry (tries `id`, `entryId`, `eventId`, `timestamp`, `createdAt` in
   * that order) and returns entries strictly after the one whose key
   * matches `after`. If no entry matches the cursor, `readLog` returns
   * `[]` — never the full log — to avoid duplicate delivery on resume.
   */
  after?: string;
  /**
   * Tail limit. When set, the last N entries (after `after` filtering)
   * are returned.
   */
  limit?: number;
}

export interface HarnessStore {
  /**
   * Read a namespaced JSON document. Returns `null` when the file does
   * not exist (`ENOENT`). Throws on parse errors with a `Corrupt doc`
   * prefix so callers can't silently overwrite bad data via a follow-up
   * `putDoc`. Throws on permission or other I/O errors with the original
   * cause wrapped. Throws `Unsafe path segment` if `ns` or `id` contains
   * traversal (`..`, `.`), separators (`/`, `\`), or a null byte.
   */
  getDoc<T>(ns: string, id: string): Promise<T | null>;
  /**
   * Write a JSON document with full-overwrite semantics. Atomic via
   * tmp-file + rename: observers of the final path see the old bytes or
   * the new bytes, never a torn write. Creates the namespace directory
   * if missing. Throws `Unsafe path segment` for unsafe `ns` or `id`.
   */
  putDoc<T>(ns: string, id: string, doc: T): Promise<void>;
  /**
   * Enumerate documents in a namespace. Results are stably ordered by
   * id (alphabetical). When `prefix` is provided, only ids whose stem
   * (filename without `.json`) starts with `prefix` are returned.
   * Returns `[]` when the namespace directory does not exist.
   */
  listDocs<T>(ns: string, prefix?: string): Promise<T[]>;
  /**
   * Remove a document. No-op (resolves quietly) when the document is
   * missing, so callers can `deleteDoc` idempotently without pre-checking.
   * Throws `Unsafe path segment` for unsafe `ns` or `id`.
   */
  deleteDoc(ns: string, id: string): Promise<void>;

  /**
   * Append one JSON-serialized entry to an append-only log. Append-only
   * by contract, but single-writer-per-(ns, id) is NOT enforced — if
   * two callers append concurrently, entries may interleave. Readers
   * may see a torn last line after a process crash mid-write; `readLog`
   * will throw `Corrupt log` in that case. Throws `Unsafe path segment`
   * for unsafe `ns` or `id`.
   */
  appendLog(ns: string, id: string, entry: unknown): Promise<void>;
  /**
   * Read log entries. `limit` returns the tail (last N). `after` is an
   * exclusive cursor — returns entries after the match, or `[]` if the
   * cursor doesn't appear in the log (deliberate, to avoid duplicate
   * delivery). Throws `Corrupt log at <path> line <n>` on a per-line
   * parse failure so operators can repair. Throws `Unsafe path segment`
   * for unsafe `ns` or `id`.
   */
  readLog<T>(ns: string, id: string, opts?: ReadLogOptions): Promise<T[]>;

  /**
   * Store opaque bytes. Bytes round-trip exactly through `getBlob`. When
   * `meta` is provided, it's persisted in a sidecar (`${id}.blob.meta.json`)
   * and `BlobRef.contentType` is populated from `meta.contentType`. Blob
   * and sidecar are committed atomically — on sidecar write failure the
   * blob is rolled back so callers don't end up with bytes missing their
   * declared `contentType`. Throws `Unsafe path segment` for unsafe
   * `ns` or `id`.
   */
  putBlob(
    ns: string,
    id: string,
    bytes: Uint8Array,
    meta?: Record<string, string>
  ): Promise<BlobRef>;
  /**
   * Fetch bytes by ref. Bytes are returned exactly as written by
   * `putBlob`. Throws `ENOENT` if the blob was deleted or never written.
   * Throws `Unsafe path segment` if `ref.ns` or `ref.id` is unsafe.
   */
  getBlob(ref: BlobRef): Promise<Uint8Array>;

  /**
   * Atomic read-modify-write on a doc. Calls `fn(prev)` with the current
   * value (or `null` when missing) and persists the return value via
   * `putDoc`. Serialized per (ns, id) within a single process — concurrent
   * `mutate` calls against the same key queue on a shared Promise-chain
   * mutex, so no caller's update is lost. `fn` may throw; the lock is
   * released and the error propagates to the caller. Single-process only:
   * cross-process coordination is out of scope (use `PgHarnessStore`
   * when it lands in T-402). Throws `Unsafe path segment` for unsafe
   * `ns` or `id`.
   */
  mutate<T>(ns: string, id: string, fn: (prev: T | null) => T): Promise<T>;

  /**
   * Observe changes to a (ns, id) as an async iterable of `ChangeEvent`.
   * At-least-once delivery — consumers may see duplicate events for the
   * same underlying change, and rapid bursts of writes may coalesce into
   * a single yield. No ordering guarantees across namespaces. Close by
   * calling `iterator.return()` (or `break` out of `for await`) — this
   * cleans up the polling loop. Throws `Unsafe path segment` for unsafe
   * `ns` or `id`. See the impl-level doc on error propagation (file impl
   * surfaces `stat` errors by throwing from the next iteration).
   */
  watch(ns: string, id: string): AsyncIterable<ChangeEvent>;
}

// TODO(T-402): second impl backed by Postgres (`PgHarnessStore`) for the
// cloud/pod deployment path. Same interface, different durability + fanout.
