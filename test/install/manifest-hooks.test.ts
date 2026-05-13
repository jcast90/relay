import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { __resetRelayDirCacheForTests, getRelayDir } from "../../src/cli/paths.js";
import {
  diffHook,
  getHookRecord,
  markHookInstalled,
  readManifest,
  reportHookDrift,
  type InstallManifest,
} from "../../src/install/manifest.js";

/**
 * Phase 4 Plan 04-03 Task 2 — manifest `hooks` block + drift helpers.
 *
 * Pins:
 *   - Forward compat: Phase 3-shaped manifests with NO `hooks` field still
 *     parse cleanly and `getHookRecord` returns undefined.
 *   - `markHookInstalled` writes the record and a re-read sees it.
 *   - Repeated marks bump `installedAt` but never break shape.
 *   - `diffHook` returns the canonical `fresh` / `current` / `behind` words.
 *   - `reportHookDrift` covers both targets independently and skips
 *     unrequested targets (so `--skip-codex` callers don't see phantom rows).
 */
describe("manifest hooks block (Phase 4 Plan 04-03 Task 2)", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "manifest-hooks-"));
    prevHome = process.env.HOME;
    process.env.HOME = home;
    __resetRelayDirCacheForTests();
    // Ensure ~/.relay exists for writes
    await mkdir(getRelayDir(), { recursive: true });
  });

  afterEach(async () => {
    if (prevHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = prevHome;
    }
    __resetRelayDirCacheForTests();
    await rm(home, { recursive: true, force: true });
  });

  it("back-compat: parses Phase-3-shaped manifest with no hooks field", async () => {
    const manifestPath = join(getRelayDir(), "installed.json");
    const phase3 = {
      schemaVersion: 1,
      surfaces: {
        cli: { version: "0.7.0", sourceSha: "abc1234", installedAt: "2025-01-01T00:00:00.000Z" },
      },
    };
    await writeFile(manifestPath, JSON.stringify(phase3, null, 2), "utf8");

    const manifest = await readManifest();
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.surfaces.cli?.version).toBe("0.7.0");
    expect(manifest.hooks).toBeUndefined();
    expect(getHookRecord(manifest, "claude")).toBeUndefined();
    expect(getHookRecord(manifest, "codex")).toBeUndefined();
  });

  it("markHookInstalled writes the record and re-read sees it", async () => {
    await markHookInstalled(
      "claude",
      "deadbeef",
      "/home/u/.relay/crosslink/hooks/session-start.sh"
    );

    const manifest = await readManifest();
    expect(manifest.hooks?.claude?.sha).toBe("deadbeef");
    expect(manifest.hooks?.claude?.command).toBe("/home/u/.relay/crosslink/hooks/session-start.sh");
    expect(typeof manifest.hooks?.claude?.installedAt).toBe("string");
    // ISO timestamp shape — Y-M-DTH:M:S.sssZ
    expect(manifest.hooks?.claude?.installedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("markHookInstalled is idempotent on the manifest level (only installedAt churns)", async () => {
    await markHookInstalled("claude", "abc123", "/p");
    const first = await readManifest();
    const firstAt = first.hooks?.claude?.installedAt;

    // Small delay to guarantee a distinct ISO second when the resolver is
    // ms-aware — same sha+command, just a fresh timestamp.
    await new Promise((r) => setTimeout(r, 5));
    await markHookInstalled("claude", "abc123", "/p");

    const second = await readManifest();
    expect(second.hooks?.claude?.sha).toBe("abc123");
    expect(second.hooks?.claude?.command).toBe("/p");
    // Shape preserved, no extra keys.
    expect(Object.keys(second.hooks?.claude ?? {}).sort()).toEqual([
      "command",
      "installedAt",
      "sha",
    ]);
    // installedAt monotonically non-decreasing (string ISO sort works).
    expect((second.hooks?.claude?.installedAt ?? "") >= (firstAt ?? "")).toBe(true);
  });

  it("diffHook returns 'fresh' when no record, 'current' on sha match, 'behind' on sha mismatch", () => {
    expect(diffHook(undefined, { sha: "abc" })).toBe("fresh");
    expect(
      diffHook({ sha: "abc", installedAt: "2025-01-01T00:00:00Z", command: "/p" }, { sha: "abc" })
    ).toBe("current");
    expect(
      diffHook({ sha: "abc", installedAt: "2025-01-01T00:00:00Z", command: "/p" }, { sha: "def" })
    ).toBe("behind");
  });

  it("reportHookDrift covers both targets independently when both sources provided", async () => {
    await markHookInstalled("claude", "matching", "/p");
    // Codex intentionally NOT installed.

    const manifest = await readManifest();
    const drift = reportHookDrift(manifest, {
      claude: { sha: "matching" },
      codex: { sha: "anything" },
    });

    expect(drift).toHaveLength(2);
    const byTarget = Object.fromEntries(drift.map((d) => [d.target, d.state]));
    expect(byTarget.claude).toBe("current");
    expect(byTarget.codex).toBe("fresh");
  });

  it("reportHookDrift skips targets the caller did not ask about (--skip-codex friendly)", async () => {
    await markHookInstalled("claude", "abc", "/p");
    const manifest = await readManifest();

    const drift = reportHookDrift(manifest, { claude: { sha: "abc" } });
    expect(drift).toHaveLength(1);
    expect(drift[0]?.target).toBe("claude");
    expect(drift[0]?.state).toBe("current");
  });

  it("reportHookDrift reports 'behind' when sha differs", async () => {
    await markHookInstalled("claude", "old-sha", "/p");
    const manifest = await readManifest();

    const drift = reportHookDrift(manifest, { claude: { sha: "new-sha" } });
    expect(drift[0]?.state).toBe("behind");
  });

  it("writing a manifest with hooks does NOT break re-read (regression guard)", async () => {
    // Write surface + hook, ensure readManifest still parses both.
    const manifestPath = join(getRelayDir(), "installed.json");
    const merged: InstallManifest = {
      schemaVersion: 1,
      surfaces: {
        cli: { version: "0.7.0", sourceSha: "src", installedAt: "2025-01-01T00:00:00Z" },
      },
      hooks: {
        claude: { sha: "h1", installedAt: "2025-01-02T00:00:00Z", command: "/p" },
      },
    };
    await writeFile(manifestPath, JSON.stringify(merged, null, 2), "utf8");

    const re = await readManifest();
    expect(re.schemaVersion).toBe(1);
    expect(re.surfaces.cli?.version).toBe("0.7.0");
    expect(re.hooks?.claude?.sha).toBe("h1");
  });

  it("malformed hooks block falls through to empty manifest (single bad write doesn't brick)", async () => {
    const manifestPath = join(getRelayDir(), "installed.json");
    // hooks is `null` — not an object, not undefined. isManifest must reject;
    // readManifest returns the empty fallback.
    await writeFile(
      manifestPath,
      JSON.stringify({ schemaVersion: 1, surfaces: {}, hooks: null }),
      "utf8"
    );
    const re = await readManifest();
    expect(re.hooks).toBeUndefined();
    expect(re.surfaces).toEqual({});
  });

  it("schemaVersion stays at 1 (additive change, no bump)", async () => {
    const src = await readFile("src/install/manifest.ts", "utf8");
    // The literal `schemaVersion: 1` must still be the only declared
    // version. If a future change bumps to 2, this guard fires.
    expect(src.match(/schemaVersion: 1/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(src.includes("schemaVersion: 2")).toBe(false);
  });
});
