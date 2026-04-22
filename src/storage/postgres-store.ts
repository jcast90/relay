import pg from "pg";

import { assertSafeSegment } from "./file-store.js";
import type { BlobRef, ChangeEvent, HarnessStore, ReadLogOptions } from "./store.js";

/**
 * Postgres channel names truncate at 63 bytes. The prefix `harness_change_`
 * is 15 characters, leaving 48 for the `ns`. Callers that violate this would
 * silently LISTEN on one identifier and NOTIFY from a different (truncated)
 * identifier — events would never land. The trigger in `001_init.sql` emits
 * the untruncated string; both sides of the contract rely on this cap.
 */
const MAX_WATCH_NS_LENGTH = 48;

/**
 * Postgres-backed `HarnessStore`. Same contract as `FileHarnessStore`, with
 * durability and cross-process coordination earned via the database:
 *
 *   - docs:  `harness_docs` (JSONB, keyed on `(ns, id)`)
 *   - logs:  `harness_logs` (BIGSERIAL `seq` per row, ordered reads)
 *   - blobs: `harness_blobs` (BYTEA + optional meta JSON)
 *   - mutate: `SELECT ... FOR UPDATE` inside a transaction — cross-process
 *     safe without an in-memory mutex
 *   - watch:  `LISTEN harness_change_<ns>` with notify fired from triggers
 *     so direct SQL writes still surface to watchers
 *
 * The caller usually owns the `pg.Pool` so lifecycle and tuning sit at the
 * app boundary, but a connection string is accepted for scripts.
 */

export interface PostgresHarnessStoreOptions {
  pool?: pg.Pool;
  connectionString?: string;
}

interface WatchSubscription {
  ns: string;
  expectedId: string;
  queue: ChangeEvent[];
  resolveWaiter: ((event: ChangeEvent | null) => void) | null;
  rejectWaiter: ((err: unknown) => void) | null;
  closed: boolean;
  error: unknown;
}

export class PostgresHarnessStore implements HarnessStore {
  private readonly pool: pg.Pool;
  private readonly ownsPool: boolean;
  private readonly connectionString: string | undefined;

  // One dedicated LISTEN client per namespace, shared across all watchers on
  // that ns. Refcounted so the connection returns to the pool once the last
  // watcher exits.
  private readonly listenClients: Map<
    string,
    { client: pg.Client; refCount: number; subscribers: Set<WatchSubscription> }
  > = new Map();

  constructor(opts: PostgresHarnessStoreOptions) {
    if (opts.pool) {
      this.pool = opts.pool;
      this.ownsPool = false;
      this.connectionString = opts.connectionString;
    } else if (opts.connectionString) {
      this.pool = new pg.Pool({ connectionString: opts.connectionString });
      this.ownsPool = true;
      this.connectionString = opts.connectionString;
    } else {
      throw new Error("PostgresHarnessStore requires `pool` or `connectionString`");
    }
  }

  /**
   * Release resources this store owns. Safe to call multiple times. Only
   * ends the pool if the store created it; a caller-supplied pool is left
   * untouched so other consumers aren't kicked off mid-flight.
   */
  async close(): Promise<void> {
    for (const [, entry] of this.listenClients) {
      for (const sub of entry.subscribers) {
        sub.closed = true;
        sub.resolveWaiter?.(null);
      }
      await entry.client.end().catch((err) => {
        console.warn(
          `[postgres-store] LISTEN client.end() failed during close(): ${err instanceof Error ? err.message : String(err)}`
        );
      });
    }
    this.listenClients.clear();
    if (this.ownsPool) {
      await this.pool.end().catch((err) => {
        console.warn(
          `[postgres-store] pool.end() failed during close(): ${err instanceof Error ? err.message : String(err)}`
        );
      });
    }
  }

  async getDoc<T>(ns: string, id: string): Promise<T | null> {
    assertSafeSegment(ns, "ns");
    assertSafeSegment(id, "id");
    const result = await this.pool.query<{ doc: T }>(
      "SELECT doc FROM harness_docs WHERE ns = $1 AND id = $2",
      [ns, id]
    );
    if (result.rowCount === 0) return null;
    return result.rows[0]?.doc ?? null;
  }

  async putDoc<T>(ns: string, id: string, doc: T): Promise<void> {
    assertSafeSegment(ns, "ns");
    assertSafeSegment(id, "id");
    await this.pool.query(
      `INSERT INTO harness_docs (ns, id, doc, updated_at)
       VALUES ($1, $2, $3::jsonb, NOW())
       ON CONFLICT (ns, id)
       DO UPDATE SET doc = EXCLUDED.doc, updated_at = NOW()`,
      [ns, id, JSON.stringify(doc)]
    );
  }

  async listDocs<T>(ns: string, prefix?: string): Promise<T[]> {
    assertSafeSegment(ns, "ns");
    // Escape LIKE metacharacters so a prefix containing `_` or `%` matches
    // literally, mirroring FileHarnessStore.listDocs which uses
    // `String.startsWith`. Without this, a prefix of `a_b` would match
    // `axb`, `aab`, etc., diverging from the contract.
    const escapedPrefix = prefix !== undefined ? prefix.replace(/[\\%_]/g, "\\$&") : null;
    const result = await this.pool.query<{ doc: T }>(
      `SELECT doc FROM harness_docs
       WHERE ns = $1
         AND ($2::text IS NULL OR id LIKE $2 || '%' ESCAPE '\\')
       ORDER BY id`,
      [ns, escapedPrefix]
    );
    return result.rows.map((r) => r.doc);
  }

  async deleteDoc(ns: string, id: string): Promise<void> {
    assertSafeSegment(ns, "ns");
    assertSafeSegment(id, "id");
    await this.pool.query("DELETE FROM harness_docs WHERE ns = $1 AND id = $2", [ns, id]);
  }

  async appendLog(ns: string, id: string, entry: unknown): Promise<void> {
    assertSafeSegment(ns, "ns");
    assertSafeSegment(id, "id");
    await this.pool.query("INSERT INTO harness_logs (ns, id, entry) VALUES ($1, $2, $3::jsonb)", [
      ns,
      id,
      JSON.stringify(entry),
    ]);
  }

  async readLog<T>(ns: string, id: string, opts?: ReadLogOptions): Promise<T[]> {
    assertSafeSegment(ns, "ns");
    assertSafeSegment(id, "id");

    // Resolve `after` (an entry-level cursor from ReadLogOptions) to a `seq`.
    // If the cursor doesn't match any entry, mirror FileHarnessStore and
    // return []. Returning the full log would cause duplicate delivery on
    // resume — the contract is documented on ReadLogOptions.after.
    let afterSeq: number | null = null;
    if (opts?.after !== undefined) {
      const cursor = opts.after;
      const match = await this.pool.query<{ seq: string }>(
        `SELECT seq FROM harness_logs
         WHERE ns = $1 AND id = $2
           AND (
             entry->>'id' = $3
             OR entry->>'entryId' = $3
             OR entry->>'eventId' = $3
             OR entry->>'timestamp' = $3
             OR entry->>'createdAt' = $3
           )
         ORDER BY seq
         LIMIT 1`,
        [ns, id, cursor]
      );
      if (match.rowCount === 0) return [];
      afterSeq = Number(match.rows[0]?.seq ?? 0);
    }

    const rows = await this.pool.query<{ entry: T; seq: string }>(
      `SELECT entry, seq FROM harness_logs
       WHERE ns = $1 AND id = $2
         AND ($3::bigint IS NULL OR seq > $3)
       ORDER BY seq`,
      [ns, id, afterSeq]
    );

    let entries = rows.rows.map((r) => r.entry);
    if (opts?.limit !== undefined && opts.limit < entries.length) {
      entries = entries.slice(-opts.limit);
    }
    return entries;
  }

  async putBlob(
    ns: string,
    id: string,
    bytes: Uint8Array,
    meta?: Record<string, string>
  ): Promise<BlobRef> {
    assertSafeSegment(ns, "ns");
    assertSafeSegment(id, "id");
    const contentType = meta?.["contentType"];
    const metaJson = meta ? JSON.stringify(meta) : "{}";
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    await this.pool.query(
      `INSERT INTO harness_blobs (ns, id, bytes, meta, size, content_type, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, NOW())
       ON CONFLICT (ns, id)
       DO UPDATE SET
         bytes = EXCLUDED.bytes,
         meta = EXCLUDED.meta,
         size = EXCLUDED.size,
         content_type = EXCLUDED.content_type,
         updated_at = NOW()`,
      [ns, id, buf, metaJson, bytes.byteLength, contentType ?? null]
    );

    const hasMeta = meta !== undefined && Object.keys(meta).length > 0;
    return {
      ns,
      id,
      size: bytes.byteLength,
      contentType: hasMeta ? contentType : undefined,
    };
  }

  async getBlob(ref: BlobRef): Promise<Uint8Array> {
    assertSafeSegment(ref.ns, "ns");
    assertSafeSegment(ref.id, "id");
    const result = await this.pool.query<{ bytes: Buffer }>(
      "SELECT bytes FROM harness_blobs WHERE ns = $1 AND id = $2",
      [ref.ns, ref.id]
    );
    if (result.rowCount === 0) {
      const err: NodeJS.ErrnoException = new Error(`Blob not found: ${ref.ns}/${ref.id}`);
      err.code = "ENOENT";
      throw err;
    }
    const buf = result.rows[0]!.bytes;
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  /**
   * Atomic read-modify-write keyed on `(ns, id)`. Cross-process serialization
   * is enforced by a transaction-scoped Postgres advisory lock derived from
   * `hashtextextended(ns || '\0' || id, 0)`. Two callers racing on a fresh
   * key therefore queue on the same advisory slot and see consistent `prev`
   * values — `SELECT ... FOR UPDATE` alone is insufficient because it
   * returns zero rows for a non-existent key, so both callers would see
   * `prev=null` and both would compute `next` from stale state.
   *
   * The transaction also holds a row-level `FOR UPDATE` lock once the row
   * exists. `fn` runs inside the transaction; if it throws the transaction
   * is rolled back and no row is modified. `fn` itself should be pure and
   * fast — the row lock is held for its entire runtime.
   */
  async mutate<T>(ns: string, id: string, fn: (prev: T | null) => T): Promise<T> {
    assertSafeSegment(ns, "ns");
    assertSafeSegment(id, "id");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Advisory lock serializes concurrent mutate() callers on the same
      // (ns, id), including when the row does not yet exist. The lock key
      // is derived server-side from the composite identifier so all
      // processes hash to the same slot. `/` is a safe separator because
      // `assertSafeSegment` already bans it from both `ns` and `id`, so no
      // two distinct pairs can collide in the concatenated form. A null
      // byte (`E'\0'`) is rejected by Postgres's UTF8 input at parse time
      // so we deliberately avoid it even though it would be a more obvious
      // delimiter.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1 || '/' || $2, 0))", [
        ns,
        id,
      ]);
      const existing = await client.query<{ doc: T }>(
        "SELECT doc FROM harness_docs WHERE ns = $1 AND id = $2 FOR UPDATE",
        [ns, id]
      );
      const prev: T | null =
        existing.rowCount && existing.rowCount > 0 ? existing.rows[0]!.doc : null;
      const next = fn(prev);
      await client.query(
        `INSERT INTO harness_docs (ns, id, doc, updated_at)
         VALUES ($1, $2, $3::jsonb, NOW())
         ON CONFLICT (ns, id)
         DO UPDATE SET doc = EXCLUDED.doc, updated_at = NOW()`,
        [ns, id, JSON.stringify(next)]
      );
      await client.query("COMMIT");
      return next;
    } catch (err) {
      await client.query("ROLLBACK").catch((rollbackErr) => {
        console.warn(
          `[postgres-store] ROLLBACK failed in mutate(${ns}/${id}): ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`
        );
      });
      throw err;
    } finally {
      client.release();
    }
  }

  watch(ns: string, id: string): AsyncIterable<ChangeEvent> {
    assertSafeSegment(ns, "ns");
    assertSafeSegment(id, "id");
    if (ns.length > MAX_WATCH_NS_LENGTH) {
      // Postgres identifiers truncate at 63 bytes. `harness_change_` is 15
      // chars, leaving 48 for the ns. Reject early rather than silently
      // LISTEN on the truncated channel (and miss events).
      throw new Error(
        `watch(): ns exceeds ${MAX_WATCH_NS_LENGTH} chars (would truncate Postgres LISTEN channel): ${ns}`
      );
    }

    // Manual AsyncIterator so `return()` can wake a pending waiter and run
    // cleanup synchronously. An async generator would deadlock — the pending
    // Promise we await on for the next event has no external resolver, so
    // `iterator.return()` would hang forever.
    const store = this;
    const subPromise = this.subscribe(ns, id);

    const iterator: AsyncIterator<ChangeEvent> = {
      async next(): Promise<IteratorResult<ChangeEvent>> {
        const sub = await subPromise;
        if (sub.error) {
          const err = sub.error;
          sub.error = null;
          throw err;
        }
        if (sub.closed) return { value: undefined, done: true };
        const queued = sub.queue.shift();
        if (queued) return { value: queued, done: false };
        const event = await new Promise<ChangeEvent | null>((resolve, reject) => {
          sub.resolveWaiter = resolve;
          sub.rejectWaiter = reject;
        });
        if (event === null) return { value: undefined, done: true };
        return { value: event, done: false };
      },
      async return(): Promise<IteratorResult<ChangeEvent>> {
        const sub = await subPromise;
        await store.unsubscribe(ns, sub);
        return { value: undefined, done: true };
      },
      async throw(err: unknown): Promise<IteratorResult<ChangeEvent>> {
        const sub = await subPromise;
        await store.unsubscribe(ns, sub);
        throw err;
      },
    };

    return {
      [Symbol.asyncIterator]: () => iterator,
    };
  }

  private async subscribe(ns: string, id: string): Promise<WatchSubscription> {
    const sub: WatchSubscription = {
      ns,
      expectedId: id,
      queue: [],
      resolveWaiter: null,
      rejectWaiter: null,
      closed: false,
      error: null,
    };

    let entry = this.listenClients.get(ns);
    if (!entry) {
      const client = new pg.Client({
        connectionString: this.connectionStringForClient(),
      });
      // A Pool client can't hold a long-lived LISTEN because the pool will
      // rotate it back into the free list. Dedicated Client instead.
      await client.connect();
      await client.query(`LISTEN ${quoteChannel(ns)}`);
      entry = { client, refCount: 0, subscribers: new Set() };
      this.listenClients.set(ns, entry);

      client.on("notification", (msg) => {
        if (!msg.payload) return;
        const channel = msg.channel;
        let parsed: { id?: string; kind?: string };
        try {
          parsed = JSON.parse(msg.payload) as { id?: string; kind?: string };
        } catch (err) {
          console.warn(
            `[postgres-store] malformed watch payload on channel ${channel}: ${err instanceof Error ? err.message : String(err)}`
          );
          return;
        }
        const kind = parsed.kind;
        if (kind !== "put" && kind !== "delete" && kind !== "append") return;
        const event: ChangeEvent = { ns, id: parsed.id ?? "", kind };
        const target = this.listenClients.get(ns);
        if (!target) return;
        for (const s of target.subscribers) {
          // A subscriber may have been unsubscribed between NOTIFY arrival
          // and the handler running; skip closed subs so we never push into
          // a queue nobody will read.
          if (s.closed) continue;
          // Filter at the subscriber so one LISTEN connection can fan out to
          // many watchers on the same ns keyed by different ids.
          if (event.id !== s.expectedId) continue;
          if (s.resolveWaiter) {
            const r = s.resolveWaiter;
            s.resolveWaiter = null;
            s.rejectWaiter = null;
            r(event);
          } else {
            s.queue.push(event);
          }
        }
      });

      client.on("error", (err) => {
        const target = this.listenClients.get(ns);
        if (!target) return;
        for (const s of target.subscribers) {
          s.error = err;
          s.closed = true;
          if (s.rejectWaiter) {
            const reject = s.rejectWaiter;
            s.rejectWaiter = null;
            s.resolveWaiter = null;
            reject(err);
          } else if (s.resolveWaiter) {
            const r = s.resolveWaiter;
            s.resolveWaiter = null;
            r(null);
          }
        }
      });
    }

    entry.subscribers.add(sub);
    entry.refCount++;
    return sub;
  }

  private async unsubscribe(ns: string, sub: WatchSubscription): Promise<void> {
    sub.closed = true;
    // Wake any pending waiter so the generator's finally can run; otherwise
    // iterator.return() awaits a promise that will never resolve.
    if (sub.resolveWaiter) {
      const r = sub.resolveWaiter;
      sub.resolveWaiter = null;
      sub.rejectWaiter = null;
      r(null);
    }
    const entry = this.listenClients.get(ns);
    if (!entry) return;
    entry.subscribers.delete(sub);
    entry.refCount--;
    if (entry.refCount <= 0) {
      this.listenClients.delete(ns);
      await entry.client.query(`UNLISTEN ${quoteChannel(ns)}`).catch((err) => {
        console.warn(
          `[postgres-store] UNLISTEN failed for ns ${ns}: ${err instanceof Error ? err.message : String(err)}`
        );
      });
      await entry.client.end().catch((err) => {
        console.warn(
          `[postgres-store] LISTEN client.end() failed during unsubscribe(${ns}): ${err instanceof Error ? err.message : String(err)}`
        );
      });
    }
  }

  private connectionStringForClient(): string | undefined {
    // When the caller passed a bare pool we don't have a connectionString;
    // pg.Client's ctor falls through to PG* env vars, which is what an
    // unconfigured pg.Pool would do anyway.
    return this.connectionString;
  }
}

/**
 * Build a safely-quoted `LISTEN`/`UNLISTEN`/`NOTIFY` channel identifier for a
 * ns. `assertSafeSegment` already rules out path-breaking characters, so the
 * sanitize-then-quote below is defense-in-depth — it keeps the identifier
 * lossless round-tripped against pg's parser and doubles any embedded quotes
 * per the SQL spec. Must match the string that the trigger emits to
 * `pg_notify`: `harness_change_<ns>`.
 */
function quoteChannel(ns: string): string {
  const channel = `harness_change_${ns}`;
  return `"${channel.replace(/"/g, '""')}"`;
}
