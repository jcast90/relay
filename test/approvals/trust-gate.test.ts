import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ApprovalsQueue } from "../../src/approvals/queue.js";
import {
  RELAY_AL7_GOD_AUTOMERGE,
  decide,
  isGodAutomergeEnabled,
} from "../../src/approvals/trust-gate.js";

describe("trust-gate.decide", () => {
  let root: string;
  let queue: ApprovalsQueue;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "relay-trust-gate-"));
    let i = 0;
    queue = new ApprovalsQueue({
      rootDir: root,
      clock: () => Date.parse("2026-01-01T00:00:00.000Z"),
      idFactory: () => `id-${++i}`,
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe("supervised trust mode", () => {
    it("enqueues a merge-pr action and never auto-executes", async () => {
      const result = await decide({
        sessionId: "sess-1",
        trust: "supervised",
        queue,
        env: {},
        action: {
          kind: "merge-pr",
          payload: { prUrl: "https://github.com/foo/bar/pull/42", reviewSummary: "LGTM" },
        },
      });

      expect(result.kind).toBe("enqueue");
      if (result.kind !== "enqueue") throw new Error("unreachable");
      expect(result.approvalId).toBe("id-1");
      expect(result.record.status).toBe("pending");
      expect(result.record.kind).toBe("merge-pr");
      expect(result.record.payload).toEqual({
        prUrl: "https://github.com/foo/bar/pull/42",
        reviewSummary: "LGTM",
      });

      const list = await queue.list("sess-1");
      expect(list).toHaveLength(1);
      expect(list[0]!.status).toBe("pending");
    });

    it("enqueues a create-ticket action and never auto-executes", async () => {
      const result = await decide({
        sessionId: "sess-1",
        trust: "supervised",
        queue,
        env: {},
        action: {
          kind: "create-ticket",
          payload: {
            title: "Fix flaky test",
            body: "retry loop swallows the real error",
            channelId: "ch-1",
          },
        },
      });

      expect(result.kind).toBe("enqueue");
      const list = await queue.list("sess-1");
      expect(list[0]!.kind).toBe("create-ticket");
      expect(list[0]!.payload).toMatchObject({ title: "Fix flaky test", channelId: "ch-1" });
    });

    it("ignores RELAY_AL7_GOD_AUTOMERGE — supervised NEVER auto-executes", async () => {
      const result = await decide({
        sessionId: "sess-1",
        trust: "supervised",
        queue,
        env: { [RELAY_AL7_GOD_AUTOMERGE]: "1" },
        action: {
          kind: "merge-pr",
          payload: { prUrl: "u" },
        },
      });
      expect(result.kind).toBe("enqueue");
    });
  });

  describe("god trust mode", () => {
    it("enqueues when RELAY_AL7_GOD_AUTOMERGE is unset (safety fall-back)", async () => {
      const result = await decide({
        sessionId: "sess-1",
        trust: "god",
        queue,
        env: {},
        action: {
          kind: "merge-pr",
          payload: { prUrl: "u" },
        },
      });

      expect(result.kind).toBe("enqueue");
      const list = await queue.list("sess-1");
      expect(list).toHaveLength(1);
    });

    it("executes when RELAY_AL7_GOD_AUTOMERGE=1 and writes an auto-approved audit record", async () => {
      const result = await decide({
        sessionId: "sess-1",
        trust: "god",
        queue,
        env: { [RELAY_AL7_GOD_AUTOMERGE]: "1" },
        action: {
          kind: "merge-pr",
          payload: { prUrl: "u" },
        },
      });

      expect(result.kind).toBe("execute");
      if (result.kind !== "execute") throw new Error("unreachable");
      // Execute branch writes an audit record so god-mode executions are
      // not invisible — the record is born approved + tagged "god-mode".
      expect(result.auditRecordId).toBe("id-1");
      expect(result.record.status).toBe("approved");
      expect(result.record.autoApprovedBy).toBe("god-mode");
      expect(result.record.decidedAt).toBe("2026-01-01T00:00:00.000Z");

      const list = await queue.list("sess-1");
      expect(list).toHaveLength(1);
      expect(list[0]!.id).toBe(result.auditRecordId);
      expect(list[0]!.status).toBe("approved");
      expect(list[0]!.autoApprovedBy).toBe("god-mode");
      expect(list[0]!.kind).toBe("merge-pr");
    });

    it("executes for create-ticket actions too and also writes an audit record", async () => {
      const result = await decide({
        sessionId: "sess-1",
        trust: "god",
        queue,
        env: { [RELAY_AL7_GOD_AUTOMERGE]: "true" },
        action: {
          kind: "create-ticket",
          payload: { title: "t", body: "b" },
        },
      });
      expect(result.kind).toBe("execute");
      if (result.kind !== "execute") throw new Error("unreachable");
      expect(result.record.autoApprovedBy).toBe("god-mode");
      expect(result.record.kind).toBe("create-ticket");
      const list = await queue.list("sess-1");
      expect(list).toHaveLength(1);
      expect(list[0]!.autoApprovedBy).toBe("god-mode");
    });

    it("treats typos / empty strings as off, not on", async () => {
      const result = await decide({
        sessionId: "sess-1",
        trust: "god",
        queue,
        env: { [RELAY_AL7_GOD_AUTOMERGE]: "yeah-maybe" },
        action: {
          kind: "merge-pr",
          payload: { prUrl: "u" },
        },
      });
      expect(result.kind).toBe("enqueue");
    });
  });

  describe("approve / reject state transitions downstream", () => {
    it("queued supervised record flows through approve without re-entering the gate", async () => {
      const result = await decide({
        sessionId: "sess-1",
        trust: "supervised",
        queue,
        env: {},
        action: { kind: "merge-pr", payload: { prUrl: "u" } },
      });
      if (result.kind !== "enqueue") throw new Error("unreachable");

      const approved = await queue.approve("sess-1", result.approvalId);
      expect(approved.status).toBe("approved");

      const pending = await queue.list("sess-1", { status: "pending" });
      expect(pending).toEqual([]);
    });

    it("queued supervised record flows through reject with feedback", async () => {
      const result = await decide({
        sessionId: "sess-1",
        trust: "supervised",
        queue,
        env: {},
        action: { kind: "create-ticket", payload: { title: "t", body: "b" } },
      });
      if (result.kind !== "enqueue") throw new Error("unreachable");

      const rejected = await queue.reject("sess-1", result.approvalId, "duplicate");
      expect(rejected.status).toBe("rejected");
      expect(rejected.feedback).toBe("duplicate");
    });
  });
});

describe("isGodAutomergeEnabled", () => {
  it("recognises true-ish values case-insensitively", () => {
    for (const v of ["1", "true", "yes", "on", "TRUE", "Yes", "ON"]) {
      expect(isGodAutomergeEnabled({ [RELAY_AL7_GOD_AUTOMERGE]: v })).toBe(true);
    }
  });

  it("trims surrounding whitespace before matching true-ish values", () => {
    // Env files / shell quirks sometimes leave padding on `RELAY_AL7_GOD_AUTOMERGE=" 1 "`.
    // The parser trims before comparing, so these must still parse as true.
    for (const v of [" 1 ", "\ttrue\n", "  yes", "on\r\n", " TRUE\t"]) {
      expect(isGodAutomergeEnabled({ [RELAY_AL7_GOD_AUTOMERGE]: v })).toBe(true);
    }
  });

  it("treats anything else (including unset / empty / typos) as false", () => {
    expect(isGodAutomergeEnabled({})).toBe(false);
    expect(isGodAutomergeEnabled({ [RELAY_AL7_GOD_AUTOMERGE]: "" })).toBe(false);
    expect(isGodAutomergeEnabled({ [RELAY_AL7_GOD_AUTOMERGE]: "0" })).toBe(false);
    expect(isGodAutomergeEnabled({ [RELAY_AL7_GOD_AUTOMERGE]: "false" })).toBe(false);
    expect(isGodAutomergeEnabled({ [RELAY_AL7_GOD_AUTOMERGE]: "no" })).toBe(false);
    expect(isGodAutomergeEnabled({ [RELAY_AL7_GOD_AUTOMERGE]: "enabled?" })).toBe(false);
    // Whitespace around a false-ish value stays false.
    expect(isGodAutomergeEnabled({ [RELAY_AL7_GOD_AUTOMERGE]: "  " })).toBe(false);
    expect(isGodAutomergeEnabled({ [RELAY_AL7_GOD_AUTOMERGE]: "\t0\n" })).toBe(false);
  });
});
