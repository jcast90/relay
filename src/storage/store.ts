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
  after?: string;
  limit?: number;
}

export interface HarnessStore {
  getDoc<T>(ns: string, id: string): Promise<T | null>;
  putDoc<T>(ns: string, id: string, doc: T): Promise<void>;
  listDocs<T>(ns: string, prefix?: string): Promise<T[]>;
  deleteDoc(ns: string, id: string): Promise<void>;

  appendLog(ns: string, id: string, entry: unknown): Promise<void>;
  readLog<T>(ns: string, id: string, opts?: ReadLogOptions): Promise<T[]>;

  putBlob(
    ns: string,
    id: string,
    bytes: Uint8Array,
    meta?: Record<string, string>
  ): Promise<BlobRef>;
  getBlob(ref: BlobRef): Promise<Uint8Array>;

  mutate<T>(ns: string, id: string, fn: (prev: T | null) => T): Promise<T>;

  watch(ns: string, id: string): AsyncIterable<ChangeEvent>;
}

// TODO(T-402): second impl backed by Postgres (`PgHarnessStore`) for the
// cloud/pod deployment path. Same interface, different durability + fanout.
