import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CrosslinkStore } from "../../src/crosslink/store.js";

/**
 * Phase 4 Plan 02 Task 3 — CrosslinkStore.advanceFeedWatermark tests.
 *
 * Mirrors the shape of `test/crosslink-store.test.ts`: a fresh tmpdir-
 * rooted CrosslinkStore per case so writes are hermetic. The watermark
 * is an additive optional field on CrosslinkSession; the tests cover the
 * monotonic + idempotent contract and the back-compat property that a
 * pre-Phase-4 session.json (without the field) loads cleanly.
 *
 * NOTE on test name: file is `channel-store-watermark.test.ts` per the
 * Plan, but the SUT is `CrosslinkStore`, not `ChannelStore`. The watermark
 * field lives on `CrosslinkSession`, which `CrosslinkStore` owns — naming
 * follows the channel-feed concept ("feed lives in channels/") rather than
 * the store class. Hold this comment as the affordance: future readers
 * looking for "where does the watermark live?" should land on
 * `CrosslinkStore.advanceFeedWatermark` in `src/crosslink/store.ts`.
 */
describe("CrosslinkStore.advanceFeedWatermark (Phase 4 Plan 02 Task 3)", () => {
  let root: string;
  let store: CrosslinkStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "watermark-test-"));
    store = new CrosslinkStore(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("advanceFeedWatermark sets the field on a fresh session", async () => {
    const session = await store.registerSession({
      pid: process.pid,
      repoPath: "/tmp/wm-repo",
      description: "watermark test",
      capabilities: ["general"],
      agentProvider: "claude",
      status: "active",
    });

    const result = await store.advanceFeedWatermark(session.sessionId, 5);
    expect(result).toEqual({ ok: true, idx: 5 });

    // Verify on disk — the field is written via the underlying HarnessStore
    // namespace layout (crosslink-session/<id>.json).
    const onDiskPath = join(root, "crosslink-session", `${session.sessionId}.json`);
    const raw = JSON.parse(await readFile(onDiskPath, "utf8"));
    expect(raw.lastSeenFeedIdx).toBe(5);
  });

  it("advanceFeedWatermark is monotonic — does not go backward", async () => {
    const session = await store.registerSession({
      pid: process.pid,
      repoPath: "/tmp/wm-mono",
      description: "monotonic",
      capabilities: ["general"],
      agentProvider: "claude",
      status: "active",
    });

    const first = await store.advanceFeedWatermark(session.sessionId, 5);
    expect(first).toEqual({ ok: true, idx: 5 });

    // Try to rewind to 3 — must be rejected as a no-op write. The return
    // value carries the actual high-water mark (5), not the requested 3.
    const rewind = await store.advanceFeedWatermark(session.sessionId, 3);
    expect(rewind).toEqual({ ok: false, idx: 5 });

    // Disk still says 5.
    const onDiskPath = join(root, "crosslink-session", `${session.sessionId}.json`);
    const raw = JSON.parse(await readFile(onDiskPath, "utf8"));
    expect(raw.lastSeenFeedIdx).toBe(5);
  });

  it("advanceFeedWatermark is idempotent — same idx returns same value, advances disk only once", async () => {
    const session = await store.registerSession({
      pid: process.pid,
      repoPath: "/tmp/wm-idem",
      description: "idempotent",
      capabilities: ["general"],
      agentProvider: "claude",
      status: "active",
    });

    const first = await store.advanceFeedWatermark(session.sessionId, 5);
    expect(first).toEqual({ ok: true, idx: 5 });

    // Same idx again — return the current value, no disk write (ok:false
    // signals "no advance happened", idx carries the actual watermark).
    const second = await store.advanceFeedWatermark(session.sessionId, 5);
    expect(second).toEqual({ ok: false, idx: 5 });

    // A subsequent strict-advance still works (proves the idempotent
    // path didn't somehow corrupt the field).
    const third = await store.advanceFeedWatermark(session.sessionId, 10);
    expect(third).toEqual({ ok: true, idx: 10 });
  });

  it("advanceFeedWatermark returns null for unknown sessionId", async () => {
    const result = await store.advanceFeedWatermark("session-does-not-exist", 5);
    expect(result).toBeNull();
  });

  it("back-compat: a legacy session.json without lastSeenFeedIdx deserializes cleanly", async () => {
    // Hand-write a pre-Phase-4 session record (no lastSeenFeedIdx field)
    // and prove that CrosslinkStore.advanceFeedWatermark accepts it. The
    // missing field is treated as 0; advancing to 7 should land cleanly.
    const sessionId = "session-legacy";
    const { mkdir } = await import("node:fs/promises");
    const sessionsDir = join(root, "crosslink-session");
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(
      join(sessionsDir, `${sessionId}.json`),
      JSON.stringify({
        sessionId,
        pid: process.pid,
        repoPath: "/tmp/legacy",
        description: "pre-phase-4",
        capabilities: ["general"],
        agentProvider: "claude",
        status: "active",
        registeredAt: "2026-04-01T00:00:00Z",
        lastHeartbeat: "2026-04-01T00:00:30Z",
        // intentionally no lastSeenFeedIdx
      })
    );

    const result = await store.advanceFeedWatermark(sessionId, 7);
    expect(result).toEqual({ ok: true, idx: 7 });

    const raw = JSON.parse(await readFile(join(sessionsDir, `${sessionId}.json`), "utf8"));
    expect(raw.lastSeenFeedIdx).toBe(7);
    // Other fields are preserved — the watermark write is non-destructive.
    expect(raw.sessionId).toBe(sessionId);
    expect(raw.repoPath).toBe("/tmp/legacy");
  });
});
