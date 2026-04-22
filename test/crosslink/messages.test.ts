/**
 * AL-16 message-shape validation.
 *
 * Covers the three accepted payload shapes and the malformed-case
 * surface. These tests sit at the schema boundary — higher layers
 * (coordinator, MCP tool) re-use `parseCoordinationMessage` so the
 * shape checks only need to live here.
 */

import { describe, expect, it } from "vitest";

import {
  BlockedOnRepoSchema,
  COORDINATION_MESSAGE_KINDS,
  CoordinationMessageSchema,
  MergeOrderProposalSchema,
  RepoReadySchema,
  parseCoordinationMessage,
} from "../../src/crosslink/messages.js";

describe("AL-16 coordination message schemas", () => {
  it("accepts a valid blocked-on-repo payload", () => {
    const raw = {
      kind: "blocked-on-repo",
      requester: "backend",
      blocker: "frontend",
      ticketId: "AL-X",
      dependsOnTicketId: "AL-Y",
      reason: "backend API change lands after frontend consumer update",
      requestedAt: "2026-04-21T12:00:00.000Z",
    };
    const result = parseCoordinationMessage(raw);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.message.kind).toBe("blocked-on-repo");

    // Direct schema parse should match too.
    expect(BlockedOnRepoSchema.parse(raw)).toMatchObject(raw);
    expect(CoordinationMessageSchema.parse(raw)).toMatchObject(raw);
  });

  it("accepts a valid repo-ready payload (PR open, no mergedAt)", () => {
    const raw = {
      kind: "repo-ready",
      alias: "frontend",
      ticketId: "AL-Y",
      prUrl: "https://github.com/jcast90/relay/pull/123",
      announcedAt: "2026-04-21T12:05:00.000Z",
    };
    const result = parseCoordinationMessage(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.message.kind).toBe("repo-ready");
      if (result.message.kind === "repo-ready") {
        expect(result.message.mergedAt).toBeUndefined();
      }
    }
    expect(RepoReadySchema.parse(raw)).toMatchObject(raw);
  });

  it("accepts a valid repo-ready payload with mergedAt", () => {
    const raw = {
      kind: "repo-ready",
      alias: "frontend",
      ticketId: "AL-Y",
      prUrl: "https://github.com/jcast90/relay/pull/123",
      mergedAt: "2026-04-21T12:10:00.000Z",
      announcedAt: "2026-04-21T12:10:01.000Z",
    };
    const result = parseCoordinationMessage(raw);
    expect(result.ok).toBe(true);
  });

  it("accepts a valid merge-order-proposal payload", () => {
    const raw = {
      kind: "merge-order-proposal",
      proposer: "backend",
      sequence: [
        {
          alias: "frontend",
          ticketId: "AL-Y",
          prUrl: "https://github.com/o/r/pull/1",
        },
        {
          alias: "backend",
          ticketId: "AL-X",
          prUrl: "https://github.com/o/r/pull/2",
        },
      ],
      rationale: "frontend consumer must land before backend API swap",
      proposedAt: "2026-04-21T12:15:00.000Z",
    };
    const result = parseCoordinationMessage(raw);
    expect(result.ok).toBe(true);
    if (result.ok && result.message.kind === "merge-order-proposal") {
      expect(result.message.sequence).toHaveLength(2);
    }
    expect(MergeOrderProposalSchema.parse(raw)).toMatchObject(raw);
  });

  it("rejects a payload with an unknown kind", () => {
    const result = parseCoordinationMessage({ kind: "bogus", foo: "bar" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // zod's discriminated union reports the invalid discriminator at
      // the `kind` path — assert we surface a useful error rather than
      // a generic "invalid union".
      expect(result.error.toLowerCase()).toContain("kind");
    }
  });

  it("rejects a blocked-on-repo missing required fields", () => {
    const result = parseCoordinationMessage({
      kind: "blocked-on-repo",
      requester: "backend",
      // missing blocker, ticketId, dependsOnTicketId, reason, requestedAt
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("blocker");
    }
  });

  it("rejects a repo-ready payload with an invalid prUrl", () => {
    const result = parseCoordinationMessage({
      kind: "repo-ready",
      alias: "frontend",
      ticketId: "AL-Y",
      prUrl: "not-a-url",
      announcedAt: "2026-04-21T12:05:00.000Z",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("prUrl");
    }
  });

  it("rejects a merge-order-proposal with an empty sequence", () => {
    const result = parseCoordinationMessage({
      kind: "merge-order-proposal",
      proposer: "backend",
      sequence: [],
      rationale: "empty",
      proposedAt: "2026-04-21T12:15:00.000Z",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("sequence");
    }
  });

  it("rejects a payload that isn't an object", () => {
    expect(parseCoordinationMessage(null).ok).toBe(false);
    expect(parseCoordinationMessage("blocked-on-repo").ok).toBe(false);
    expect(parseCoordinationMessage(42).ok).toBe(false);
  });

  it("rejects extra (unknown) fields via .strict()", () => {
    const result = parseCoordinationMessage({
      kind: "repo-ready",
      alias: "frontend",
      ticketId: "AL-Y",
      prUrl: "https://github.com/o/r/pull/1",
      announcedAt: "2026-04-21T12:05:00.000Z",
      extraField: "drive-by",
    });
    expect(result.ok).toBe(false);
  });

  it("exports the full list of supported kinds", () => {
    expect(COORDINATION_MESSAGE_KINDS).toEqual([
      "blocked-on-repo",
      "repo-ready",
      "merge-order-proposal",
    ]);
  });
});
