import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FileHarnessStore } from "../../src/storage/file-store.js";
import type { BlobRef, ChangeEvent } from "../../src/storage/store.js";

interface Widget {
  id: string;
  label: string;
  count: number;
}

describe("FileHarnessStore", () => {
  let root: string;
  let store: FileHarnessStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "relay-file-store-"));
    store = new FileHarnessStore(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe("docs", () => {
    it("round-trips a typed doc via putDoc / getDoc", async () => {
      const widget: Widget = { id: "w1", label: "alpha", count: 3 };
      await store.putDoc<Widget>("widgets", "w1", widget);

      const loaded = await store.getDoc<Widget>("widgets", "w1");
      expect(loaded).toEqual(widget);
    });

    it("returns null for a missing id", async () => {
      const loaded = await store.getDoc<Widget>("widgets", "does-not-exist");
      expect(loaded).toBeNull();
    });

    it("throws with a clear error on corrupt JSON", async () => {
      await mkdir(join(root, "widgets"), { recursive: true });
      await writeFile(join(root, "widgets", "bad.json"), "{ not valid json");

      await expect(store.getDoc<Widget>("widgets", "bad")).rejects.toThrow(
        /Corrupt doc at .*bad\.json/
      );
    });

    it("listDocs returns alphabetically-stable results and honors prefix", async () => {
      await store.putDoc<Widget>("widgets", "beta-2", {
        id: "beta-2",
        label: "b2",
        count: 0
      });
      await store.putDoc<Widget>("widgets", "alpha-1", {
        id: "alpha-1",
        label: "a1",
        count: 0
      });
      await store.putDoc<Widget>("widgets", "alpha-2", {
        id: "alpha-2",
        label: "a2",
        count: 0
      });

      const all = await store.listDocs<Widget>("widgets");
      expect(all.map((w) => w.id)).toEqual(["alpha-1", "alpha-2", "beta-2"]);

      const alphas = await store.listDocs<Widget>("widgets", "alpha-");
      expect(alphas.map((w) => w.id)).toEqual(["alpha-1", "alpha-2"]);
    });

    it("deleteDoc removes the file and subsequent getDoc returns null", async () => {
      await store.putDoc<Widget>("widgets", "w1", {
        id: "w1",
        label: "a",
        count: 1
      });
      expect(await store.getDoc<Widget>("widgets", "w1")).not.toBeNull();

      await store.deleteDoc("widgets", "w1");
      expect(await store.getDoc<Widget>("widgets", "w1")).toBeNull();

      // Idempotent: second delete is a no-op.
      await expect(store.deleteDoc("widgets", "w1")).resolves.toBeUndefined();
    });
  });

  describe("logs", () => {
    it("round-trips entries via appendLog / readLog", async () => {
      await store.appendLog("events", "run-1", { id: "a", v: 1 });
      await store.appendLog("events", "run-1", { id: "b", v: 2 });
      await store.appendLog("events", "run-1", { id: "c", v: 3 });

      const entries = await store.readLog<{ id: string; v: number }>(
        "events",
        "run-1"
      );
      expect(entries.map((e) => e.id)).toEqual(["a", "b", "c"]);
    });

    it("readLog honors `limit` by returning the last N entries", async () => {
      for (const n of [1, 2, 3, 4, 5]) {
        await store.appendLog("events", "run-2", { id: `e${n}`, v: n });
      }
      const tail = await store.readLog<{ id: string; v: number }>(
        "events",
        "run-2",
        { limit: 2 }
      );
      expect(tail.map((e) => e.id)).toEqual(["e4", "e5"]);
    });

    it("readLog honors `after` as an exclusive cursor", async () => {
      for (const n of [1, 2, 3, 4]) {
        await store.appendLog("events", "run-3", { id: `e${n}`, v: n });
      }
      const after = await store.readLog<{ id: string; v: number }>(
        "events",
        "run-3",
        { after: "e2" }
      );
      expect(after.map((e) => e.id)).toEqual(["e3", "e4"]);
    });

    it("readLog returns [] when the log doesn't exist", async () => {
      const entries = await store.readLog("events", "never-written");
      expect(entries).toEqual([]);
    });
  });

  describe("blobs", () => {
    it("round-trips binary bytes exactly", async () => {
      const bytes = new Uint8Array(256);
      for (let i = 0; i < 256; i++) bytes[i] = i;

      const ref = await store.putBlob("artifacts", "bin-1", bytes, {
        contentType: "application/octet-stream"
      });

      expect(ref).toMatchObject({
        ns: "artifacts",
        id: "bin-1",
        size: 256,
        contentType: "application/octet-stream"
      });

      const loaded = await store.getBlob(ref);
      expect(loaded.length).toBe(256);
      for (let i = 0; i < 256; i++) {
        expect(loaded[i]).toBe(i);
      }
    });

    it("getBlob works on a ref constructed from primitive fields", async () => {
      const payload = new TextEncoder().encode("hello world");
      await store.putBlob("artifacts", "txt-1", payload);

      const manual: BlobRef = {
        ns: "artifacts",
        id: "txt-1",
        size: payload.byteLength
      };
      const loaded = await store.getBlob(manual);
      expect(new TextDecoder().decode(loaded)).toBe("hello world");
    });
  });

  describe("mutate", () => {
    it("creates the doc when prev is null", async () => {
      const result = await store.mutate<Widget>(
        "widgets",
        "new",
        (prev) => prev ?? { id: "new", label: "fresh", count: 1 }
      );
      expect(result).toEqual({ id: "new", label: "fresh", count: 1 });
      expect(await store.getDoc<Widget>("widgets", "new")).toEqual(result);
    });

    it("serializes 100 concurrent increments on the same (ns, id)", async () => {
      await store.putDoc<Widget>("widgets", "ctr", {
        id: "ctr",
        label: "counter",
        count: 0
      });

      const ops: Promise<Widget>[] = [];
      for (let i = 0; i < 100; i++) {
        ops.push(
          store.mutate<Widget>("widgets", "ctr", (prev) => ({
            id: "ctr",
            label: "counter",
            count: (prev?.count ?? 0) + 1
          }))
        );
      }
      await Promise.all(ops);

      const final = await store.getDoc<Widget>("widgets", "ctr");
      expect(final?.count).toBe(100);
    });
  });

  describe("watch", () => {
    it("yields a ChangeEvent when putDoc writes to the watched key, and closes cleanly", async () => {
      const events: ChangeEvent[] = [];

      const iterator = store.watch("widgets", "watched")[Symbol.asyncIterator]();
      const nextEvent = iterator.next();

      // Brief sleep so the watcher has a chance to capture baseline mtimes
      // before we trigger a write. The 250ms poll interval still governs
      // when the first event is observed; 50ms here just orders the setup.
      await new Promise((resolve) => setTimeout(resolve, 50));
      await store.putDoc<Widget>("widgets", "watched", {
        id: "watched",
        label: "hi",
        count: 1
      });

      const result = await Promise.race<
        IteratorResult<ChangeEvent> | "timeout"
      >([
        nextEvent,
        new Promise<"timeout">((resolve) =>
          setTimeout(() => resolve("timeout"), 2000)
        )
      ]);

      expect(result).not.toBe("timeout");
      if (result !== "timeout" && !result.done) {
        events.push(result.value);
      }

      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0]).toMatchObject({
        ns: "widgets",
        id: "watched",
        kind: "put"
      });

      // Return closes the async generator; the polling loop should exit.
      await iterator.return?.();
    });

    it("surfaces non-ENOENT errors from stat instead of going silent", async () => {
      // Platform guard: chmod 000 is only reliable on POSIX. On Windows we
      // skip because the permission model doesn't map cleanly.
      if (process.platform === "win32") return;
      // Root on unix can read anything regardless of perms — the chmod path
      // won't trigger EACCES. Skip so we don't green a broken test.
      if (typeof process.getuid === "function" && process.getuid() === 0) {
        return;
      }

      // Seed the watched doc so stat() succeeds on the first poll and the
      // watcher captures a baseline mtime for it.
      await store.putDoc<Widget>("watch-errs", "w1", {
        id: "w1",
        label: "seed",
        count: 0
      });

      const iterator = store
        .watch("watch-errs", "w1")
        [Symbol.asyncIterator]();
      const nextEvent = iterator.next();

      // Deny read on the namespace dir so stat() throws EACCES on the next
      // poll. The iterator should throw rather than silently coalescing
      // into a no-event stream.
      const nsDir = join(root, "watch-errs");
      await chmod(nsDir, 0o000);

      try {
        await expect(
          Promise.race<IteratorResult<ChangeEvent> | "timeout">([
            nextEvent,
            new Promise<"timeout">((resolve) =>
              setTimeout(() => resolve("timeout"), 2000)
            )
          ])
        ).rejects.toThrow();
      } finally {
        // Restore perms so afterEach cleanup can rm -rf the tmpdir.
        await chmod(nsDir, 0o700).catch(() => {});
        await iterator.return?.().catch(() => {});
      }
    });
  });

  describe("concurrency", () => {
    it("50 concurrent putDoc writes on one key never yield a torn JSON file", async () => {
      const ops: Promise<void>[] = [];
      for (let i = 0; i < 50; i++) {
        ops.push(
          store.putDoc<Widget>("widgets", "concurrent", {
            id: "concurrent",
            label: `write-${i}`,
            count: i
          })
        );
      }
      await Promise.all(ops);

      // Without tmp-file + atomic rename this would sometimes throw
      // "Unexpected token" from a half-written doc.
      const final = await store.getDoc<Widget>("widgets", "concurrent");
      expect(final).not.toBeNull();
      expect(final?.id).toBe("concurrent");
      // Final count must be one of the 50 writes — the specific winner is
      // a race and we don't care which, only that it's internally
      // consistent.
      expect(final?.count).toBeGreaterThanOrEqual(0);
      expect(final?.count).toBeLessThan(50);
      expect(final?.label).toBe(`write-${final?.count}`);
    });
  });

  describe("path traversal rejection", () => {
    const unsafeNs = "..";
    const unsafeId = "../x";

    it("getDoc rejects unsafe ns and id", async () => {
      await expect(store.getDoc("valid", unsafeId)).rejects.toThrow(
        /Unsafe path segment/
      );
      await expect(store.getDoc(unsafeNs, "valid")).rejects.toThrow(
        /Unsafe path segment/
      );
    });

    it("putDoc rejects unsafe ns and id", async () => {
      const widget: Widget = { id: "x", label: "a", count: 0 };
      await expect(store.putDoc("valid", unsafeId, widget)).rejects.toThrow(
        /Unsafe path segment/
      );
      await expect(store.putDoc(unsafeNs, "valid", widget)).rejects.toThrow(
        /Unsafe path segment/
      );
    });

    it("deleteDoc rejects unsafe ns and id", async () => {
      await expect(store.deleteDoc("valid", unsafeId)).rejects.toThrow(
        /Unsafe path segment/
      );
      await expect(store.deleteDoc(unsafeNs, "valid")).rejects.toThrow(
        /Unsafe path segment/
      );
    });

    it("appendLog rejects unsafe ns and id", async () => {
      await expect(store.appendLog("valid", unsafeId, { v: 1 })).rejects.toThrow(
        /Unsafe path segment/
      );
      await expect(store.appendLog(unsafeNs, "valid", { v: 1 })).rejects.toThrow(
        /Unsafe path segment/
      );
    });

    it("putBlob rejects unsafe ns and id", async () => {
      const bytes = new Uint8Array([0, 1, 2]);
      await expect(store.putBlob("valid", unsafeId, bytes)).rejects.toThrow(
        /Unsafe path segment/
      );
      await expect(store.putBlob(unsafeNs, "valid", bytes)).rejects.toThrow(
        /Unsafe path segment/
      );
    });
  });

  describe("readLog cursor semantics", () => {
    it("returns [] when the `after` cursor isn't in the log", async () => {
      await store.appendLog("events", "run-x", { id: "e1", v: 1 });
      await store.appendLog("events", "run-x", { id: "e2", v: 2 });
      await store.appendLog("events", "run-x", { id: "e3", v: 3 });

      // Contract: unknown cursor → []. Returning the full log would cause
      // duplicate delivery on resume.
      const out = await store.readLog<{ id: string; v: number }>(
        "events",
        "run-x",
        { after: "does-not-exist" }
      );
      expect(out).toEqual([]);
    });
  });
});
