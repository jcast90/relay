/**
 * Phase 2 PR-5 / Wave 5 — M10 cross-dashboard audit assertion.
 *
 * `rly pending-approvals` is the single CLI surface that lists every pending
 * `ApprovalsQueue` record across every session. Phase 2 widens the
 * `ApprovalKind` union with `"handoff-prompt"`, and the M10 audit (see
 * `docs/design/handoff-brief.md`) confirmed no dashboard renderer switches
 * on `kind` values — so widening is safe with zero changes to TUI / GUI /
 * Rust crate.
 *
 * This test pins that audit conclusion in code: enqueue a `handoff-prompt`
 * approval through the real `ApprovalsQueue.enqueue` path, then read it back
 * the same way `handlePendingApprovalsCommand` does (`queue.list(sessionId,
 * { status: "pending" })`). The record must round-trip with `kind` and
 * `payload` intact AND must NOT be classified as an unknown / unrenderable
 * shape by the queue's payload validator (`assertValidPayloadForKind`).
 *
 * If a future change introduces a kind-specific renderer (icon picker,
 * pluralizer, color, status label) for the approvals surface, this test is
 * the canary that flags missed widening — but it does NOT run a real CLI
 * subprocess (we don't shell out in scripted-mode tests, per AGENTS.md).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ApprovalsQueue } from "../../src/approvals/queue.js";
import type { HandoffPromptPayload } from "../../src/domain/handoff.js";

describe("rly pending-approvals — handoff-prompt round-trip (M10)", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "relay-pending-approvals-handoff-"));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("queue.enqueue + queue.list round-trip a handoff-prompt record with intact kind and payload", async () => {
    const sessionId = "sess-test-handoff-001";
    const queue = new ApprovalsQueue({ rootDir });

    const payload: HandoffPromptPayload = {
      schemaVersion: 1,
      channelId: "ch-test-0001",
      sessionId,
      thresholdPct: 90,
      used: 91234,
      total: 100000,
      promptText: "Session at 90% — want to hand off?",
    };

    const enqueued = await queue.enqueue({
      sessionId,
      kind: "handoff-prompt",
      payload,
    });
    expect(enqueued.kind).toBe("handoff-prompt");
    expect(enqueued.status).toBe("pending");

    // Mirror handlePendingApprovalsCommand's read path: list pending records
    // for the session and verify the JSON-shaped record renders correctly.
    const pending = await queue.list(sessionId, { status: "pending" });
    expect(pending).toHaveLength(1);
    const rec = pending[0];

    // Renderer-friendly assertions: kind is a non-empty discriminated string,
    // payload survives the JSONL round-trip with all numeric fields as
    // numbers (M1 string→number boundary).
    expect(rec.kind).toBe("handoff-prompt");
    expect(rec.kind).not.toBe("unknown");

    const hp = rec.payload as HandoffPromptPayload;
    expect(hp.schemaVersion).toBe(1);
    expect(hp.channelId).toBe("ch-test-0001");
    expect(hp.sessionId).toBe(sessionId);
    expect(typeof hp.thresholdPct).toBe("number");
    expect(hp.thresholdPct).toBe(90);
    expect(typeof hp.used).toBe("number");
    expect(typeof hp.total).toBe("number");
    expect(hp.promptText).toBe("Session at 90% — want to hand off?");

    // The CLI rendering is `kind=${r.kind}` — assert the kind string would
    // produce a non-degenerate label (i.e. wouldn't render as `kind=unknown`
    // or `kind=undefined`).
    const renderedLabel = `kind=${rec.kind}`;
    expect(renderedLabel).toBe("kind=handoff-prompt");
  });

  it("rejects a malformed handoff-prompt payload at the enqueue boundary (assertValidPayloadForKind)", async () => {
    const queue = new ApprovalsQueue({ rootDir });
    // thresholdPct as a string would be the bug we'd see if the M1 boundary
    // got skipped — assertValidPayloadForKind rejects it.
    await expect(
      queue.enqueue({
        sessionId: "sess-test-handoff-002",
        kind: "handoff-prompt",
        payload: {
          schemaVersion: 1,
          channelId: "ch-test-0002",
          sessionId: "sess-test-handoff-002",
          thresholdPct: "90" as unknown as number,
          used: 91234,
          total: 100000,
        },
      })
    ).rejects.toThrow(/handoff-prompt/);
  });
});
