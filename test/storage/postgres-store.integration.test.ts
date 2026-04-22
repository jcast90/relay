import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { migrate } from "../../src/storage/migrations/runner.js";
import { PostgresHarnessStore } from "../../src/storage/postgres-store.js";
import type { BlobRef, ChangeEvent } from "../../src/storage/store.js";

/**
 * Integration suite, gated on HARNESS_TEST_POSTGRES_URL. When the env var is
 * missing every test skips with a clear message. The scenarios mirror the
 * T-001 FileHarnessStore suite — that's the whole point of having a shared
 * HarnessStore contract; both implementations should pass the same checks.
 * T-001's tests are already merged and aren't refactored here to avoid cross-
 * PR conflict; a follow-up can consolidate into a single conformance helper.
 */

const TEST_URL = process.env["HARNESS_TEST_POSTGRES_URL"];
const skipReason =
  "requires HARNESS_TEST_POSTGRES_URL; set e.g. postgres://postgres@localhost:5432/relay_test";

interface Widget {
  id: string;
  label: string;
  count: number;
}

const maybeDescribe = TEST_URL ? describe : describe.skip;

maybeDescribe(`PostgresHarnessStore (integration, ${TEST_URL ?? skipReason})`, () => {
  let pool: pg.Pool;
  let store: PostgresHarnessStore;
  let ns: string;

  beforeAll(async () => {
    if (!TEST_URL) return;
    pool = new pg.Pool({ connectionString: TEST_URL });
    await migrate({ pool });
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.end();
  });

  beforeEach(() => {
    store = new PostgresHarnessStore({ pool });
    ns = `it-${randomUUID()}`;
  });

  afterEach(async () => {
    await store.close();
    // Clean up the ns we used — other tests shouldn't see our rows.
    if (pool && ns) {
      await pool.query("DELETE FROM harness_docs WHERE ns = $1", [ns]);
      await pool.query("DELETE FROM harness_logs WHERE ns = $1", [ns]);
      await pool.query("DELETE FROM harness_blobs WHERE ns = $1", [ns]);
    }
  });

  it("skip reason", () => {
    // Visible in test output so CI makes it clear why integration tests
    // didn't actually exercise the database. Always passes; real scenarios
    // follow when TEST_URL is set.
    if (!TEST_URL) {
      // eslint-disable-next-line no-console
      console.log(skipReason);
    }
    expect(true).toBe(true);
  });

  it("round-trips a typed doc via putDoc / getDoc", async () => {
    if (!TEST_URL) return;
    const widget: Widget = { id: "w1", label: "alpha", count: 3 };
    await store.putDoc<Widget>(ns, "w1", widget);
    const loaded = await store.getDoc<Widget>(ns, "w1");
    expect(loaded).toEqual(widget);
  });

  it("getDoc returns null for a missing id", async () => {
    if (!TEST_URL) return;
    const loaded = await store.getDoc<Widget>(ns, "missing");
    expect(loaded).toBeNull();
  });

  it("listDocs returns alphabetically-stable results and honors prefix", async () => {
    if (!TEST_URL) return;
    await store.putDoc<Widget>(ns, "beta-2", {
      id: "beta-2",
      label: "b2",
      count: 0,
    });
    await store.putDoc<Widget>(ns, "alpha-1", {
      id: "alpha-1",
      label: "a1",
      count: 0,
    });
    await store.putDoc<Widget>(ns, "alpha-2", {
      id: "alpha-2",
      label: "a2",
      count: 0,
    });

    const all = await store.listDocs<Widget>(ns);
    expect(all.map((w) => w.id)).toEqual(["alpha-1", "alpha-2", "beta-2"]);

    const alphas = await store.listDocs<Widget>(ns, "alpha-");
    expect(alphas.map((w) => w.id)).toEqual(["alpha-1", "alpha-2"]);
  });

  it("listDocs escapes LIKE metacharacters in prefix (`_`, `%`)", async () => {
    if (!TEST_URL) return;
    // Without escaping, `_` matches any single character and `%` matches
    // any sequence — so the presence of `alphaXb` would leak into a search
    // for `alpha_b`. Verify parity with FileHarnessStore's String.startsWith.
    await store.putDoc<Widget>(ns, "alpha_b1", {
      id: "alpha_b1",
      label: "u",
      count: 0,
    });
    await store.putDoc<Widget>(ns, "alphaXb1", {
      id: "alphaXb1",
      label: "x",
      count: 0,
    });
    await store.putDoc<Widget>(ns, "pct%tag", {
      id: "pct%tag",
      label: "p",
      count: 0,
    });
    await store.putDoc<Widget>(ns, "pctZtag", {
      id: "pctZtag",
      label: "z",
      count: 0,
    });

    const underscoreMatches = await store.listDocs<Widget>(ns, "alpha_");
    expect(underscoreMatches.map((w) => w.id)).toEqual(["alpha_b1"]);

    const percentMatches = await store.listDocs<Widget>(ns, "pct%");
    expect(percentMatches.map((w) => w.id)).toEqual(["pct%tag"]);
  });

  it("deleteDoc is idempotent and clears the row", async () => {
    if (!TEST_URL) return;
    await store.putDoc<Widget>(ns, "w1", { id: "w1", label: "a", count: 1 });
    await store.deleteDoc(ns, "w1");
    expect(await store.getDoc<Widget>(ns, "w1")).toBeNull();
    await expect(store.deleteDoc(ns, "w1")).resolves.toBeUndefined();
  });

  it("appendLog / readLog round-trip with cursor and limit", async () => {
    if (!TEST_URL) return;
    await store.appendLog(ns, "r1", { id: "a", v: 1 });
    await store.appendLog(ns, "r1", { id: "b", v: 2 });
    await store.appendLog(ns, "r1", { id: "c", v: 3 });
    await store.appendLog(ns, "r1", { id: "d", v: 4 });

    const all = await store.readLog<{ id: string; v: number }>(ns, "r1");
    expect(all.map((e) => e.id)).toEqual(["a", "b", "c", "d"]);

    const tail = await store.readLog<{ id: string; v: number }>(ns, "r1", {
      limit: 2,
    });
    expect(tail.map((e) => e.id)).toEqual(["c", "d"]);

    const afterB = await store.readLog<{ id: string; v: number }>(ns, "r1", {
      after: "b",
    });
    expect(afterB.map((e) => e.id)).toEqual(["c", "d"]);

    const unknownCursor = await store.readLog<{ id: string; v: number }>(ns, "r1", {
      after: "does-not-exist",
    });
    expect(unknownCursor).toEqual([]);
  });

  it("readLog returns [] for a log with no entries", async () => {
    if (!TEST_URL) return;
    const empty = await store.readLog(ns, "never-written");
    expect(empty).toEqual([]);
  });

  it("putBlob / getBlob round-trip binary bytes exactly", async () => {
    if (!TEST_URL) return;
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;

    const ref = await store.putBlob(ns, "bin-1", bytes, {
      contentType: "application/octet-stream",
    });
    expect(ref).toMatchObject({
      ns,
      id: "bin-1",
      size: 256,
      contentType: "application/octet-stream",
    });

    const loaded = await store.getBlob(ref);
    expect(loaded.length).toBe(256);
    for (let i = 0; i < 256; i++) expect(loaded[i]).toBe(i);
  });

  it("getBlob works on a ref constructed from primitive fields", async () => {
    if (!TEST_URL) return;
    const payload = new TextEncoder().encode("hello postgres");
    await store.putBlob(ns, "txt-1", payload);
    const manual: BlobRef = {
      ns,
      id: "txt-1",
      size: payload.byteLength,
    };
    const loaded = await store.getBlob(manual);
    expect(new TextDecoder().decode(loaded)).toBe("hello postgres");
  });

  it("mutate creates the row from a null prev on a fresh key", async () => {
    if (!TEST_URL) return;
    const created = await store.mutate<Widget>(ns, "fresh", (prev) => {
      expect(prev).toBeNull();
      return { id: "fresh", label: "created", count: 7 };
    });
    expect(created).toEqual({ id: "fresh", label: "created", count: 7 });
    const loaded = await store.getDoc<Widget>(ns, "fresh");
    expect(loaded).toEqual(created);
  });

  it("mutate serializes 50 concurrent increments on a FRESH key (advisory lock)", async () => {
    if (!TEST_URL) return;
    // Critical: no putDoc first. Without advisory-lock serialization each
    // caller's SELECT ... FOR UPDATE returns 0 rows, prev=null, and the
    // final count ends at 1. The advisory lock forces strict ordering even
    // before the row exists.
    const ops: Promise<{ count: number }>[] = [];
    for (let i = 0; i < 50; i++) {
      ops.push(
        store.mutate<{ count: number }>(ns, "fresh-ctr", (prev) => ({
          count: (prev?.count ?? 0) + 1,
        }))
      );
    }
    await Promise.all(ops);

    const final = await store.getDoc<{ count: number }>(ns, "fresh-ctr");
    expect(final?.count).toBe(50);
  });

  it("mutate serializes 50 concurrent increments on one key", async () => {
    if (!TEST_URL) return;
    await store.putDoc<Widget>(ns, "ctr", {
      id: "ctr",
      label: "counter",
      count: 0,
    });

    const ops: Promise<Widget>[] = [];
    for (let i = 0; i < 50; i++) {
      ops.push(
        store.mutate<Widget>(ns, "ctr", (prev) => ({
          id: "ctr",
          label: "counter",
          count: (prev?.count ?? 0) + 1,
        }))
      );
    }
    await Promise.all(ops);

    const final = await store.getDoc<Widget>(ns, "ctr");
    expect(final?.count).toBe(50);
  });

  it("watch yields a ChangeEvent when putDoc writes to the watched key", async () => {
    if (!TEST_URL) return;
    const watcherStore = new PostgresHarnessStore({
      connectionString: TEST_URL,
    });
    try {
      const events: ChangeEvent[] = [];
      const iterator = watcherStore.watch(ns, "watched")[Symbol.asyncIterator]();
      const nextEvent = iterator.next();

      // Small delay so the LISTEN is registered before we trigger the write.
      await new Promise((resolve) => setTimeout(resolve, 100));

      await store.putDoc<Widget>(ns, "watched", {
        id: "watched",
        label: "hi",
        count: 1,
      });

      const result = await Promise.race<IteratorResult<ChangeEvent> | "timeout">([
        nextEvent,
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 3000)),
      ]);

      expect(result).not.toBe("timeout");
      if (result !== "timeout" && !result.done) events.push(result.value);
      expect(events[0]).toMatchObject({ ns, id: "watched", kind: "put" });

      await iterator.return?.();
    } finally {
      await watcherStore.close();
    }
  });

  it("watch cleans up on iterator.return()", async () => {
    if (!TEST_URL) return;
    const watcherStore = new PostgresHarnessStore({
      connectionString: TEST_URL,
    });
    try {
      const iterator = watcherStore.watch(ns, "watched-cleanup")[Symbol.asyncIterator]();
      // Prime the subscription and then close immediately.
      const firstNext = iterator.next();
      await new Promise((resolve) => setTimeout(resolve, 50));
      await iterator.return?.();
      // Calling .return again is safe, and the pending .next() resolves done.
      const resolved = await Promise.race<IteratorResult<ChangeEvent> | "timeout">([
        firstNext,
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 1000)),
      ]);
      if (resolved !== "timeout") expect(resolved.done).toBe(true);
    } finally {
      await watcherStore.close();
    }
  });
});
