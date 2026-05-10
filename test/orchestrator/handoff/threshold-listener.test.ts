/**
 * Phase 2 PR-3: 90% threshold listener tests.
 *
 * Wires a tmp ~/.relay/, instantiates `ChannelStore` + `ApprovalsQueue`,
 * posts the Phase 1-shaped `context_threshold` feed entries, and asserts
 * the listener:
 *   - Enqueues exactly one `kind: "handoff-prompt"` approval per crossing
 *     with `payload.thresholdPct === 90` (NUMBER, not the wire STRING).
 *   - Dedupes within-process re-posts (D-03).
 *   - Filters non-90 thresholds.
 *   - Does NOT cross-fire between sessions (H2b defense in depth).
 *   - Stops polling on `unsubscribe()`.
 *   - Survives orchestrator restart without double-enqueueing
 *     (`approvalsQueue.list(sessionId)` seeds the in-memory dedup Set).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ApprovalsQueue } from "../../../src/approvals/queue.js";
import { ChannelStore } from "../../../src/channels/channel-store.js";
import {
  attachHandoffThresholdListener,
  DEFAULT_HANDOFF_THRESHOLD_POLL_MS,
} from "../../../src/orchestrator/handoff/threshold-listener.js";
import type { HandoffPromptPayload } from "../../../src/domain/handoff.js";

const POLL_MS = 30;
const WAIT_MS = 200;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface ThresholdMetadataInput {
  sessionId: string;
  threshold?: string;
  pct?: string;
  used?: string;
  total?: string;
  schemaVersion?: string;
}

async function postContextThreshold(
  store: ChannelStore,
  channelId: string,
  meta: ThresholdMetadataInput
): Promise<void> {
  await store.postEntry(channelId, {
    type: "status_update",
    fromAgentId: null,
    fromDisplayName: "system",
    content: `context-threshold ${meta.threshold ?? "90"}% crossed`,
    metadata: {
      kind: "context_threshold",
      schemaVersion: meta.schemaVersion ?? "1",
      threshold: meta.threshold ?? "90",
      pct: meta.pct ?? "91.23",
      used: meta.used ?? "182000",
      total: meta.total ?? "200000",
      sessionId: meta.sessionId,
      channelId,
    },
  });
}

describe("attachHandoffThresholdListener", () => {
  let root: string;
  let channelsDir: string;
  let store: ChannelStore;
  let queue: ApprovalsQueue;
  let channelId: string;
  let unsubs: Array<() => void>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "handoff-threshold-"));
    channelsDir = join(root, "channels");
    store = new ChannelStore(channelsDir);
    queue = new ApprovalsQueue({ rootDir: root });
    const ch = await store.createChannel({ name: "fixture", description: "" });
    channelId = ch.channelId;
    unsubs = [];
  });

  afterEach(async () => {
    for (const u of unsubs) {
      try {
        u();
      } catch {
        /* noop */
      }
    }
    await rm(root, { recursive: true, force: true });
  });

  it("enqueues a single handoff-prompt approval on a threshold === '90' feed entry", async () => {
    await postContextThreshold(store, channelId, { sessionId: "sess-x" });

    const sub = attachHandoffThresholdListener({
      channelStore: store,
      approvalsQueue: queue,
      channelId,
      sessionId: "sess-x",
      pollIntervalMs: POLL_MS,
    });
    unsubs.push(sub.unsubscribe);

    await wait(WAIT_MS);

    const records = (await queue.list("sess-x")).filter((r) => r.kind === "handoff-prompt");
    expect(records).toHaveLength(1);
    const payload = records[0].payload as HandoffPromptPayload;
    // M1 pinpoint: NUMBER, not wire STRING "90".
    expect(payload.thresholdPct).toBe(90);
    expect(typeof payload.thresholdPct).toBe("number");
    expect(payload.used).toBe(182000);
    expect(payload.total).toBe(200000);
    expect(payload.sessionId).toBe("sess-x");
    expect(payload.channelId).toBe(channelId);
    expect(payload.schemaVersion).toBe(1);
  });

  it("does NOT re-enqueue when an identical 90% entry is posted for the same session (D-03 dedup)", async () => {
    await postContextThreshold(store, channelId, { sessionId: "sess-x" });

    const sub = attachHandoffThresholdListener({
      channelStore: store,
      approvalsQueue: queue,
      channelId,
      sessionId: "sess-x",
      pollIntervalMs: POLL_MS,
    });
    unsubs.push(sub.unsubscribe);

    await wait(WAIT_MS);

    // Post a second identical entry; the listener has already seen
    // (sessionId, "90") so the dedup Set must prevent a second enqueue.
    await postContextThreshold(store, channelId, { sessionId: "sess-x", pct: "92.5" });
    await wait(WAIT_MS);

    const records = (await queue.list("sess-x")).filter((r) => r.kind === "handoff-prompt");
    expect(records).toHaveLength(1);
  });

  it("filters out threshold === '75' entries (only 90% triggers)", async () => {
    await postContextThreshold(store, channelId, {
      sessionId: "sess-x",
      threshold: "75",
      pct: "75.0",
    });

    const sub = attachHandoffThresholdListener({
      channelStore: store,
      approvalsQueue: queue,
      channelId,
      sessionId: "sess-x",
      pollIntervalMs: POLL_MS,
    });
    unsubs.push(sub.unsubscribe);

    await wait(WAIT_MS);

    const records = (await queue.list("sess-x")).filter((r) => r.kind === "handoff-prompt");
    expect(records).toHaveLength(0);
  });

  it("ignores entries with mismatched sessionId (no cross-session leakage)", async () => {
    await postContextThreshold(store, channelId, { sessionId: "sess-other" });

    const sub = attachHandoffThresholdListener({
      channelStore: store,
      approvalsQueue: queue,
      channelId,
      sessionId: "sess-x",
      pollIntervalMs: POLL_MS,
    });
    unsubs.push(sub.unsubscribe);

    await wait(WAIT_MS);

    const records = (await queue.list("sess-x")).filter((r) => r.kind === "handoff-prompt");
    expect(records).toHaveLength(0);
  });

  it("two distinct sessionIds both crossing 90% enqueue independent approvals (H2b defense in depth)", async () => {
    await postContextThreshold(store, channelId, { sessionId: "sess-A", pct: "91.0" });
    await postContextThreshold(store, channelId, { sessionId: "sess-B", pct: "92.0" });

    const subA = attachHandoffThresholdListener({
      channelStore: store,
      approvalsQueue: queue,
      channelId,
      sessionId: "sess-A",
      pollIntervalMs: POLL_MS,
    });
    const subB = attachHandoffThresholdListener({
      channelStore: store,
      approvalsQueue: queue,
      channelId,
      sessionId: "sess-B",
      pollIntervalMs: POLL_MS,
    });
    unsubs.push(subA.unsubscribe, subB.unsubscribe);

    await wait(WAIT_MS);

    const apprA = (await queue.list("sess-A")).filter((r) => r.kind === "handoff-prompt");
    const apprB = (await queue.list("sess-B")).filter((r) => r.kind === "handoff-prompt");
    expect(apprA).toHaveLength(1);
    expect(apprB).toHaveLength(1);
    expect((apprA[0].payload as HandoffPromptPayload).sessionId).toBe("sess-A");
    expect((apprB[0].payload as HandoffPromptPayload).sessionId).toBe("sess-B");
  });

  it("unsubscribe() stops the poll loop", async () => {
    const sub = attachHandoffThresholdListener({
      channelStore: store,
      approvalsQueue: queue,
      channelId,
      sessionId: "sess-x",
      pollIntervalMs: POLL_MS,
    });
    sub.unsubscribe();

    await postContextThreshold(store, channelId, { sessionId: "sess-x" });
    await wait(WAIT_MS);

    const records = (await queue.list("sess-x")).filter((r) => r.kind === "handoff-prompt");
    expect(records).toHaveLength(0);
  });

  it("survives orchestrator restart without double-enqueueing (seed via approvalsQueue.list)", async () => {
    // Pretend a prior listener-run already enqueued the handoff-prompt
    // approval. After the orchestrator restarts and re-attaches the
    // listener, the seed step (approvalsQueue.list(sessionId) filtered to
    // kind === "handoff-prompt") MUST mark (sess-x, 90) as already seen so
    // the next poll does not re-enqueue.
    await queue.enqueue({
      sessionId: "sess-x",
      kind: "handoff-prompt",
      payload: {
        schemaVersion: 1,
        channelId,
        sessionId: "sess-x",
        thresholdPct: 90,
        used: 182000,
        total: 200000,
      },
    });
    await postContextThreshold(store, channelId, { sessionId: "sess-x" });

    const sub = attachHandoffThresholdListener({
      channelStore: store,
      approvalsQueue: queue,
      channelId,
      sessionId: "sess-x",
      pollIntervalMs: POLL_MS,
    });
    unsubs.push(sub.unsubscribe);

    await wait(WAIT_MS);

    const records = (await queue.list("sess-x")).filter((r) => r.kind === "handoff-prompt");
    expect(records).toHaveLength(1); // still only the seeded one
  });

  it("filters out entries with mismatched schemaVersion (T-02-12 fail-closed)", async () => {
    await postContextThreshold(store, channelId, {
      sessionId: "sess-x",
      schemaVersion: "2",
    });

    const sub = attachHandoffThresholdListener({
      channelStore: store,
      approvalsQueue: queue,
      channelId,
      sessionId: "sess-x",
      pollIntervalMs: POLL_MS,
    });
    unsubs.push(sub.unsubscribe);

    await wait(WAIT_MS);

    const records = (await queue.list("sess-x")).filter((r) => r.kind === "handoff-prompt");
    expect(records).toHaveLength(0);
  });

  it("exports DEFAULT_HANDOFF_THRESHOLD_POLL_MS = 5000 per M8", () => {
    expect(DEFAULT_HANDOFF_THRESHOLD_POLL_MS).toBe(5000);
  });
});
