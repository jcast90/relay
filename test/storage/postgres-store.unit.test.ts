import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { PostgresHarnessStore } from "../../src/storage/postgres-store.js";

/**
 * Unit tests drive a mock pg.Pool / pg.Client. They assert the shape of the
 * SQL issued — parameter order, ON CONFLICT clauses, SELECT ... FOR UPDATE
 * inside a transaction, LISTEN channel naming. They don't exercise the
 * database; the integration test file does that.
 */

interface QueryCall {
  text: string;
  values?: unknown[];
}

function makePoolMock(
  responses: (
    text: string,
    values: unknown[] | undefined
  ) => { rows: unknown[]; rowCount?: number } = () => ({
    rows: [],
    rowCount: 0
  })
) {
  const calls: QueryCall[] = [];
  const clientCalls: QueryCall[] = [];
  const released: boolean[] = [];

  const client = {
    query: vi.fn((text: string, values?: unknown[]) => {
      clientCalls.push({ text, values });
      return Promise.resolve(responses(text, values));
    }),
    release: vi.fn(() => {
      released.push(true);
    })
  };

  const pool = {
    query: vi.fn((text: string, values?: unknown[]) => {
      calls.push({ text, values });
      return Promise.resolve(responses(text, values));
    }),
    connect: vi.fn(() => Promise.resolve(client)),
    end: vi.fn(() => Promise.resolve())
  };

  return { pool, client, calls, clientCalls, released };
}

describe("PostgresHarnessStore (unit, mocked pg)", () => {
  describe("getDoc", () => {
    it("issues parameterized SELECT and returns null when no row", async () => {
      const { pool, calls } = makePoolMock();
      const store = new PostgresHarnessStore({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        pool: pool as any
      });

      const result = await store.getDoc("widgets", "w1");

      expect(result).toBeNull();
      expect(calls).toHaveLength(1);
      expect(calls[0]?.text).toMatch(
        /SELECT doc FROM harness_docs WHERE ns = \$1 AND id = \$2/
      );
      expect(calls[0]?.values).toEqual(["widgets", "w1"]);
    });

    it("returns the row's doc when present", async () => {
      const { pool } = makePoolMock(() => ({
        rows: [{ doc: { id: "w1", hello: "world" } }],
        rowCount: 1
      }));
      const store = new PostgresHarnessStore({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        pool: pool as any
      });

      const result = await store.getDoc<{ id: string; hello: string }>(
        "widgets",
        "w1"
      );
      expect(result).toEqual({ id: "w1", hello: "world" });
    });
  });

  describe("putDoc", () => {
    it("uses INSERT ... ON CONFLICT DO UPDATE", async () => {
      const { pool, calls } = makePoolMock();
      const store = new PostgresHarnessStore({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        pool: pool as any
      });

      await store.putDoc("widgets", "w1", { v: 1 });

      expect(calls).toHaveLength(1);
      expect(calls[0]?.text).toMatch(/INSERT INTO harness_docs/);
      expect(calls[0]?.text).toMatch(
        /ON CONFLICT \(ns, id\)\s+DO UPDATE SET doc = EXCLUDED\.doc/
      );
      // doc is serialized to a JSONB string literal — third param.
      expect(calls[0]?.values?.[0]).toBe("widgets");
      expect(calls[0]?.values?.[1]).toBe("w1");
      expect(JSON.parse(String(calls[0]?.values?.[2]))).toEqual({ v: 1 });
    });
  });

  describe("listDocs", () => {
    it("builds a prefix-LIKE query and passes null when no prefix", async () => {
      const { pool, calls } = makePoolMock();
      const store = new PostgresHarnessStore({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        pool: pool as any
      });

      await store.listDocs("widgets");
      expect(calls[0]?.values).toEqual(["widgets", null]);
      expect(calls[0]?.text).toMatch(/ORDER BY id/);

      await store.listDocs("widgets", "alpha-");
      expect(calls[1]?.values).toEqual(["widgets", "alpha-"]);
    });

    it("escapes LIKE metacharacters and uses an explicit ESCAPE clause", async () => {
      const { pool, calls } = makePoolMock();
      const store = new PostgresHarnessStore({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        pool: pool as any
      });

      await store.listDocs("widgets", "alpha_b%c\\d");

      expect(calls[0]?.text).toContain("id LIKE $2 || '%' ESCAPE '\\'");
      // `_`, `%`, and `\` in the caller's prefix should all be backslash-
      // escaped so Postgres treats them as literal characters.
      expect(calls[0]?.values).toEqual(["widgets", "alpha\\_b\\%c\\\\d"]);
    });
  });

  describe("mutate", () => {
    it("opens a transaction with SELECT ... FOR UPDATE", async () => {
      const { pool, clientCalls } = makePoolMock((text) => {
        if (/SELECT doc FROM harness_docs/.test(text)) {
          return { rows: [{ doc: { count: 1 } }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      });
      const store = new PostgresHarnessStore({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        pool: pool as any
      });

      const next = await store.mutate<{ count: number }>(
        "widgets",
        "ctr",
        (prev) => ({ count: (prev?.count ?? 0) + 1 })
      );

      expect(next).toEqual({ count: 2 });
      const texts = clientCalls.map((c) => c.text);
      expect(texts[0]).toBe("BEGIN");
      // Advisory lock fires before the row SELECT so concurrent callers
      // serialize on the same (ns, id) slot even when the row doesn't yet
      // exist (SELECT ... FOR UPDATE alone returns 0 rows in that case).
      expect(texts[1]).toMatch(/pg_advisory_xact_lock/);
      expect(texts[2]).toMatch(/SELECT doc.*FOR UPDATE/);
      expect(texts.some((t) => /INSERT INTO harness_docs/.test(t))).toBe(true);
      expect(texts[texts.length - 1]).toBe("COMMIT");
    });

    it("rolls back the transaction when fn throws", async () => {
      const { pool, clientCalls } = makePoolMock();
      const store = new PostgresHarnessStore({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        pool: pool as any
      });

      await expect(
        store.mutate("widgets", "ctr", () => {
          throw new Error("boom");
        })
      ).rejects.toThrow("boom");

      const texts = clientCalls.map((c) => c.text);
      expect(texts).toContain("BEGIN");
      expect(texts).toContain("ROLLBACK");
      expect(texts).not.toContain("COMMIT");
    });
  });

  describe("watch", () => {
    it("issues LISTEN on a per-namespace channel", async () => {
      // pg.Client is constructed inside subscribe(). Patch the imported
      // default's Client ctor so we observe the LISTEN call without a real
      // connection. Restored after the test to avoid leaking state.
      const pg = (await import("pg")).default;
      const originalClient = pg.Client;
      const fakeClient = Object.assign(new EventEmitter(), {
        connect: vi.fn((..._args: unknown[]) => Promise.resolve()),
        query: vi.fn((..._args: unknown[]) =>
          Promise.resolve({ rows: [], rowCount: 0 })
        ),
        end: vi.fn((..._args: unknown[]) => Promise.resolve())
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (pg as any).Client = vi.fn(() => fakeClient);

      try {
        const { pool } = makePoolMock();
        const store = new PostgresHarnessStore({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          pool: pool as any,
          connectionString: "postgres://x"
        });

        const iterator = store.watch("my-ns", "id1")[Symbol.asyncIterator]();
        // Drive the generator past subscribe() so the LISTEN query lands on
        // our fake client. The iterator blocks once subscribed (no events),
        // so race it against a close() to free the test.
        const firstNext = iterator.next();
        await new Promise((resolve) => setTimeout(resolve, 50));

        const listenCalls = fakeClient.query.mock.calls.filter((c) =>
          String(c[0]).startsWith("LISTEN")
        );
        expect(listenCalls.length).toBe(1);
        const listenSql = String(listenCalls[0]?.[0] ?? "");
        expect(listenSql).toBe('LISTEN "harness_change_my-ns"');

        await iterator.return?.();
        await firstNext.catch(() => {});
      } finally {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (pg as any).Client = originalClient;
      }
    });
  });

  describe("path segment validation", () => {
    const unsafe = ["..", ".", "a/b", "a\\b", "a\0b", ""];

    it("rejects unsafe ns across every primitive", async () => {
      const { pool } = makePoolMock();
      const store = new PostgresHarnessStore({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        pool: pool as any
      });

      for (const bad of unsafe) {
        await expect(store.getDoc(bad, "ok")).rejects.toThrow(
          /Unsafe path segment/
        );
        await expect(store.putDoc(bad, "ok", {})).rejects.toThrow(
          /Unsafe path segment/
        );
        await expect(store.deleteDoc(bad, "ok")).rejects.toThrow(
          /Unsafe path segment/
        );
        await expect(store.appendLog(bad, "ok", {})).rejects.toThrow(
          /Unsafe path segment/
        );
        await expect(
          store.putBlob(bad, "ok", new Uint8Array([1]))
        ).rejects.toThrow(/Unsafe path segment/);
      }
    });

    it("rejects unsafe id for getDoc/putDoc/deleteDoc/appendLog/putBlob", async () => {
      const { pool } = makePoolMock();
      const store = new PostgresHarnessStore({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        pool: pool as any
      });

      for (const bad of unsafe) {
        await expect(store.getDoc("ok", bad)).rejects.toThrow(
          /Unsafe path segment/
        );
        await expect(store.putDoc("ok", bad, {})).rejects.toThrow(
          /Unsafe path segment/
        );
        await expect(store.deleteDoc("ok", bad)).rejects.toThrow(
          /Unsafe path segment/
        );
        await expect(store.appendLog("ok", bad, {})).rejects.toThrow(
          /Unsafe path segment/
        );
        await expect(
          store.putBlob("ok", bad, new Uint8Array([1]))
        ).rejects.toThrow(/Unsafe path segment/);
      }
    });
  });

  describe("construction", () => {
    it("requires pool or connectionString", () => {
      expect(() => new PostgresHarnessStore({})).toThrow(
        /requires `pool` or `connectionString`/
      );
    });
  });

  describe("watch ns length guard", () => {
    it("rejects ns longer than 48 chars so LISTEN channel doesn't truncate", () => {
      const { pool } = makePoolMock();
      const store = new PostgresHarnessStore({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        pool: pool as any,
        connectionString: "postgres://x"
      });
      const tooLong = "x".repeat(49);
      // Postgres truncates identifiers at 63 bytes. `harness_change_`
      // (15 chars) + 48-char ns = exactly 63 — anything longer loses
      // bytes off the tail so LISTEN and NOTIFY would disagree.
      expect(() => store.watch(tooLong, "id1")).toThrow(
        /ns exceeds 48 chars/
      );
    });
  });
});
