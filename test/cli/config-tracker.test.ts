import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readConfig, writeConfig } from "../../src/cli/config.js";
import { __resetRelayDirCacheForTests } from "../../src/cli/paths.js";
import { DEFAULT_TRACKER_CONFIG } from "../../src/domain/tracker-config.js";

/**
 * Round-trip tests for the tracker block in `~/.relay/config.json`.
 * Drives `HOME` at a tmp dir + resets the relay-dir cache so we never
 * touch the user's real config.
 */

describe("cli/config tracker round-trip", () => {
  let tmpHome: string;
  let prevHome: string | undefined;

  beforeEach(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), "relay-cfg-"));
    prevHome = process.env.HOME;
    process.env.HOME = tmpHome;
    __resetRelayDirCacheForTests();
  });

  afterEach(async () => {
    if (prevHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = prevHome;
    }
    __resetRelayDirCacheForTests();
    await rm(tmpHome, { recursive: true, force: true });
  });

  it("synthesizes the default tracker block when the file does not exist", async () => {
    const cfg = await readConfig();
    expect(cfg.tracker).toEqual(DEFAULT_TRACKER_CONFIG);
    expect(cfg.projectDirs).toEqual([]);
  });

  it("returns the default tracker block when the file has no `tracker` key", async () => {
    await mkdir(join(tmpHome, ".relay"), { recursive: true });
    await writeFile(
      join(tmpHome, ".relay", "config.json"),
      JSON.stringify({ projectDirs: ["~/projects"] })
    );
    const cfg = await readConfig();
    expect(cfg.tracker).toEqual(DEFAULT_TRACKER_CONFIG);
  });

  it("preserves the tracker block across a write → read cycle", async () => {
    await writeConfig({
      projectDirs: [],
      tracker: {
        default: "github_projects",
        providers: {
          github_projects: {
            owner: "jcast90",
            ownerType: "user",
            project_naming: "per_primary_repo",
            epic_model: "parent_draft_item",
            use_draft_items: true,
            sync_interval_seconds: 60,
            min_rate_limit_budget: 300,
          },
          github_issues: { enabled: false },
          relay_native: { enabled: true },
        },
      },
    });
    const cfg = await readConfig();
    expect(cfg.tracker.default).toBe("github_projects");
    expect(cfg.tracker.providers.github_projects?.owner).toBe("jcast90");
    expect(cfg.tracker.providers.github_projects?.sync_interval_seconds).toBe(60);
  });

  it("falls back to the default when the file has malformed JSON (rather than crashing the CLI)", async () => {
    await mkdir(join(tmpHome, ".relay"), { recursive: true });
    await writeFile(join(tmpHome, ".relay", "config.json"), "{not json");
    const cfg = await readConfig();
    expect(cfg.tracker).toEqual(DEFAULT_TRACKER_CONFIG);
  });
});
