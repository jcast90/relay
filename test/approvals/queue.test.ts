import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ApprovalsQueue, type ApprovalRecord } from "../../src/approvals/queue.js";

describe("ApprovalsQueue", () => {
  let root: string;
  let now: number;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "relay-approvals-"));
    now = Date.parse("2026-01-01T00:00:00.000Z");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function makeQueue(opts?: { ids?: string[] }) {
    const ids = opts?.ids ?? ["id-1", "id-2", "id-3", "id-4", "id-5"];
    let i = 0;
    return new ApprovalsQueue({
      rootDir: root,
      clock: () => now,
      idFactory: () => ids[i++] ?? `id-fallback-${i}`,
    });
  }

  describe("enqueue", () => {
    it("writes a pending record under ~/.relay/approvals/<sessionId>/queue.jsonl", async () => {
      const queue = makeQueue();
      const record = await queue.enqueue({
        sessionId: "sess-1",
        kind: "merge-pr",
        payload: { prUrl: "https://github.com/foo/bar/pull/42" },
      });

      expect(record.id).toBe("id-1");
      expect(record.status).toBe("pending");
      expect(record.sessionId).toBe("sess-1");
      expect(record.kind).toBe("merge-pr");
      expect(record.createdAt).toBe("2026-01-01T00:00:00.000Z");
      expect(record.decidedAt).toBeUndefined();

      const path = join(root, "approvals", "sess-1", "queue.jsonl");
      const raw = await readFile(path, "utf8");
      expect(raw.trim().split("\n")).toHaveLength(1);
      expect(JSON.parse(raw.trim())).toEqual(record);
    });

    it("scopes queue files per session — two sessions never share a file", async () => {
      const queue = makeQueue();
      await queue.enqueue({
        sessionId: "sess-a",
        kind: "merge-pr",
        payload: { prUrl: "https://example/pr/1" },
      });
      await queue.enqueue({
        sessionId: "sess-b",
        kind: "create-ticket",
        payload: { title: "t", body: "b" },
      });

      const listA = await queue.list("sess-a");
      const listB = await queue.list("sess-b");
      expect(listA).toHaveLength(1);
      expect(listB).toHaveLength(1);
      expect(listA[0]!.kind).toBe("merge-pr");
      expect(listB[0]!.kind).toBe("create-ticket");

      // Files are separate on disk.
      await stat(join(root, "approvals", "sess-a", "queue.jsonl"));
      await stat(join(root, "approvals", "sess-b", "queue.jsonl"));
    });

    it("atomic-appends: two enqueue calls produce two JSONL lines, both parseable", async () => {
      const queue = makeQueue();
      await queue.enqueue({
        sessionId: "sess-1",
        kind: "merge-pr",
        payload: { prUrl: "u-1" },
      });
      await queue.enqueue({
        sessionId: "sess-1",
        kind: "create-ticket",
        payload: { title: "a", body: "b" },
      });

      const raw = await readFile(join(root, "approvals", "sess-1", "queue.jsonl"), "utf8");
      const lines = raw.trim().split("\n");
      expect(lines).toHaveLength(2);
      const parsed = lines.map((l) => JSON.parse(l) as ApprovalRecord);
      expect(parsed[0]!.id).toBe("id-1");
      expect(parsed[1]!.id).toBe("id-2");
    });

    it("returns the full record including the payload shape", async () => {
      const queue = makeQueue();
      const record = await queue.enqueue({
        sessionId: "sess-1",
        kind: "create-ticket",
        payload: {
          title: "Fix flaky test",
          body: "The audit agent noticed the retry loop swallows the real error.",
          channelId: "ch-1",
          rationale: "observed 3 times in the last run",
        },
      });
      expect(record.payload).toEqual({
        title: "Fix flaky test",
        body: "The audit agent noticed the retry loop swallows the real error.",
        channelId: "ch-1",
        rationale: "observed 3 times in the last run",
      });
    });
  });

  describe("list", () => {
    it("returns [] when no queue file exists yet", async () => {
      const queue = makeQueue();
      const records = await queue.list("never-seen");
      expect(records).toEqual([]);
    });

    it("filters by status when provided", async () => {
      const queue = makeQueue();
      const a = await queue.enqueue({
        sessionId: "s",
        kind: "merge-pr",
        payload: { prUrl: "u1" },
      });
      await queue.enqueue({
        sessionId: "s",
        kind: "merge-pr",
        payload: { prUrl: "u2" },
      });
      await queue.approve("s", a.id);

      const pending = await queue.list("s", { status: "pending" });
      const approved = await queue.list("s", { status: "approved" });
      expect(pending).toHaveLength(1);
      expect(pending[0]!.payload).toEqual({ prUrl: "u2" });
      expect(approved).toHaveLength(1);
      expect(approved[0]!.id).toBe(a.id);
    });

    it("collapses duplicate ids keeping the newest record per id", async () => {
      const queue = makeQueue();
      const rec = await queue.enqueue({
        sessionId: "s",
        kind: "merge-pr",
        payload: { prUrl: "u" },
      });
      await queue.reject("s", rec.id, "not ready");

      const all = await queue.list("s");
      expect(all).toHaveLength(1);
      expect(all[0]!.status).toBe("rejected");
      expect(all[0]!.feedback).toBe("not ready");

      // Raw file has two lines — collapse happens in `list`, not on disk.
      const raw = await readFile(join(root, "approvals", "s", "queue.jsonl"), "utf8");
      expect(raw.trim().split("\n")).toHaveLength(2);
    });

    it("skips unparseable (torn) trailing lines", async () => {
      const queue = makeQueue();
      await queue.enqueue({
        sessionId: "s",
        kind: "merge-pr",
        payload: { prUrl: "u" },
      });
      // Simulate a crash mid-append by concatenating a half-written line.
      const path = join(root, "approvals", "s", "queue.jsonl");
      const raw = await readFile(path, "utf8");
      const { writeFile } = await import("node:fs/promises");
      await writeFile(path, raw + '{"id":"half', "utf8");

      const records = await queue.list("s");
      expect(records).toHaveLength(1);
      expect(records[0]!.status).toBe("pending");
    });
  });

  describe("approve / reject state transitions", () => {
    it("approve flips pending -> approved + stamps decidedAt", async () => {
      const queue = makeQueue();
      const rec = await queue.enqueue({
        sessionId: "s",
        kind: "merge-pr",
        payload: { prUrl: "u" },
      });
      expect(rec.status).toBe("pending");

      now = Date.parse("2026-01-01T00:05:00.000Z");
      const approved = await queue.approve("s", rec.id);
      expect(approved.status).toBe("approved");
      expect(approved.decidedAt).toBe("2026-01-01T00:05:00.000Z");
      expect(approved.id).toBe(rec.id);

      const list = await queue.list("s");
      expect(list).toHaveLength(1);
      expect(list[0]!.status).toBe("approved");
    });

    it("reject flips pending -> rejected + preserves optional feedback", async () => {
      const queue = makeQueue();
      const rec = await queue.enqueue({
        sessionId: "s",
        kind: "create-ticket",
        payload: { title: "t", body: "b" },
      });
      const rejected = await queue.reject("s", rec.id, "out of scope");
      expect(rejected.status).toBe("rejected");
      expect(rejected.feedback).toBe("out of scope");

      const rejectedNoFeedback = await queue.enqueue({
        sessionId: "s",
        kind: "merge-pr",
        payload: { prUrl: "u" },
      });
      const r2 = await queue.reject("s", rejectedNoFeedback.id);
      expect(r2.status).toBe("rejected");
      expect(r2.feedback).toBeUndefined();
    });

    it("throws on unknown id", async () => {
      const queue = makeQueue();
      await queue.enqueue({
        sessionId: "s",
        kind: "merge-pr",
        payload: { prUrl: "u" },
      });
      await expect(queue.approve("s", "nope")).rejects.toThrow(/no record with id "nope"/);
      await expect(queue.reject("s", "nope")).rejects.toThrow(/no record with id "nope"/);
    });

    it("refuses to re-decide a terminal record", async () => {
      const queue = makeQueue();
      const rec = await queue.enqueue({
        sessionId: "s",
        kind: "merge-pr",
        payload: { prUrl: "u" },
      });
      await queue.approve("s", rec.id);
      await expect(queue.approve("s", rec.id)).rejects.toThrow(/already approved/);
      await expect(queue.reject("s", rec.id)).rejects.toThrow(/already approved/);
    });

    it("rejected records are also terminal", async () => {
      const queue = makeQueue();
      const rec = await queue.enqueue({
        sessionId: "s",
        kind: "merge-pr",
        payload: { prUrl: "u" },
      });
      await queue.reject("s", rec.id, "nope");
      await expect(queue.approve("s", rec.id)).rejects.toThrow(/already rejected/);
    });
  });

  describe("compact", () => {
    it("rewrites the queue file in collapsed form and keeps list() stable", async () => {
      const queue = makeQueue();
      const a = await queue.enqueue({
        sessionId: "s",
        kind: "merge-pr",
        payload: { prUrl: "u1" },
      });
      const b = await queue.enqueue({
        sessionId: "s",
        kind: "merge-pr",
        payload: { prUrl: "u2" },
      });
      await queue.approve("s", a.id);
      await queue.reject("s", b.id, "x");

      const beforeRaw = await readFile(join(root, "approvals", "s", "queue.jsonl"), "utf8");
      expect(beforeRaw.trim().split("\n")).toHaveLength(4);

      const count = await queue.compact("s");
      expect(count).toBe(2);

      const afterRaw = await readFile(join(root, "approvals", "s", "queue.jsonl"), "utf8");
      expect(afterRaw.trim().split("\n")).toHaveLength(2);

      const list = await queue.list("s");
      expect(list.map((r) => [r.id, r.status])).toEqual([
        [a.id, "approved"],
        [b.id, "rejected"],
      ]);
    });
  });
});
