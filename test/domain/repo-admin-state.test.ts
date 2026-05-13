/**
 * Phase 4 Plan 01 Task 1 — truth-table tests for `deriveRepoAdminState`.
 *
 * Asserts the four-state derivation matches the Rust `derive_state`
 * byte-for-byte (see `crates/harness-data/src/lib.rs`). The cases enumerated
 * here are the same cases the Rust test block in `harness-data` asserts —
 * any divergence between TS and Rust is a Phase 4 invariant violation.
 *
 * Precedence assertions ("stale wins over ready") are explicit because
 * they're easy to break with a sloppy if-chain reordering.
 */

import { describe, expect, it } from "vitest";

import {
  RepoAdminStateSchema,
  STALE_HEARTBEAT_MS,
  deriveRepoAdminState,
} from "../../src/domain/repo-admin-state.js";

const NOW_MS = Date.parse("2026-05-11T12:00:00Z");
const FRESH_HEARTBEAT = new Date(NOW_MS - 5_000).toISOString(); // 5s ago
const STALE_HEARTBEAT = new Date(NOW_MS - STALE_HEARTBEAT_MS - 1_000).toISOString(); // > 2min ago

const ALIVE = (_pid: number) => true;
const DEAD = (_pid: number) => false;

describe("deriveRepoAdminState (Phase 4 D-06 truth table)", () => {
  it("returns 'disconnected' for a null session", () => {
    expect(deriveRepoAdminState(null, NOW_MS, ALIVE)).toBe("disconnected");
  });

  it("returns 'booting' when alive + fresh heartbeat + readyAt absent", () => {
    expect(
      deriveRepoAdminState(
        { pid: 1234, lastHeartbeat: FRESH_HEARTBEAT, readyAt: undefined },
        NOW_MS,
        ALIVE
      )
    ).toBe("booting");
  });

  it("returns 'booting' when readyAt is explicit null (Phase 3 back-compat)", () => {
    // Phase 3 disk shape can carry `readyAt: null` after legacy reads —
    // must be treated identically to `undefined`.
    expect(
      deriveRepoAdminState(
        { pid: 1234, lastHeartbeat: FRESH_HEARTBEAT, readyAt: null },
        NOW_MS,
        ALIVE
      )
    ).toBe("booting");
  });

  it("returns 'ready' when alive + fresh heartbeat + readyAt set", () => {
    expect(
      deriveRepoAdminState(
        {
          pid: 1234,
          lastHeartbeat: FRESH_HEARTBEAT,
          readyAt: "2026-05-11T11:59:50Z",
        },
        NOW_MS,
        ALIVE
      )
    ).toBe("ready");
  });

  it("returns 'stale' when heartbeat is older than STALE_HEARTBEAT_MS", () => {
    expect(
      deriveRepoAdminState(
        { pid: 1234, lastHeartbeat: STALE_HEARTBEAT, readyAt: undefined },
        NOW_MS,
        ALIVE
      )
    ).toBe("stale");
  });

  it("returns 'stale' when pid is dead even with a fresh heartbeat", () => {
    expect(
      deriveRepoAdminState(
        { pid: 1234, lastHeartbeat: FRESH_HEARTBEAT, readyAt: undefined },
        NOW_MS,
        DEAD
      )
    ).toBe("stale");
  });

  it("returns 'stale' when readyAt is set but pid is dead (stale precedence)", () => {
    // Critical precedence: a session that managed to set readyAt before
    // dying must surface as `stale`, not `ready`. Matches the Rust branch
    // order in derive_state: liveness/staleness check fires BEFORE
    // readyAt check.
    expect(
      deriveRepoAdminState(
        {
          pid: 1234,
          lastHeartbeat: FRESH_HEARTBEAT,
          readyAt: "2026-05-11T11:59:50Z",
        },
        NOW_MS,
        DEAD
      )
    ).toBe("stale");
  });

  it("returns 'stale' when heartbeat is aged AND readyAt is set", () => {
    expect(
      deriveRepoAdminState(
        {
          pid: 1234,
          lastHeartbeat: STALE_HEARTBEAT,
          readyAt: "2026-05-11T11:00:00Z",
        },
        NOW_MS,
        ALIVE
      )
    ).toBe("stale");
  });

  it("boundary: heartbeat exactly at STALE_HEARTBEAT_MS is still fresh", () => {
    // The derivation uses strict `>` — exactly equal to the threshold
    // counts as fresh. Matches Rust (`hb_age > STALE_HEARTBEAT_MS`).
    const boundaryHeartbeat = new Date(NOW_MS - STALE_HEARTBEAT_MS).toISOString();
    expect(
      deriveRepoAdminState(
        { pid: 1234, lastHeartbeat: boundaryHeartbeat, readyAt: undefined },
        NOW_MS,
        ALIVE
      )
    ).toBe("booting");
  });
});

describe("RepoAdminStateSchema", () => {
  it("accepts exactly the four kebab-case wire values", () => {
    for (const v of ["disconnected", "booting", "ready", "stale"] as const) {
      expect(RepoAdminStateSchema.parse(v)).toBe(v);
    }
  });

  it("rejects values outside the four-state enum", () => {
    expect(() => RepoAdminStateSchema.parse("unknown")).toThrow();
    expect(() => RepoAdminStateSchema.parse("Ready")).toThrow(); // case-sensitive
    expect(() => RepoAdminStateSchema.parse("dis_connected")).toThrow(); // snake_case rejected
    expect(() => RepoAdminStateSchema.parse("")).toThrow();
  });
});
