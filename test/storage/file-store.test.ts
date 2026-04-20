import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

      // Wait long enough for the watcher's baseline poll, then trigger a write.
      // 300ms > 250ms poll interval + small margin for mtime resolution.
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
  });
});
