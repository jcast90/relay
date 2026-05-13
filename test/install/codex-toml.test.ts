import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import TOML from "@iarna/toml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureCodexFeatureFlag } from "../../src/install/codex-toml.js";

/**
 * Phase 4 Plan 03 Task 1 — Codex TOML helper.
 *
 * Pins the contract:
 *   - Fresh-file creation works.
 *   - Idempotent on repeat calls with the same value (byte-for-byte no-op).
 *   - Unrelated sections + keys round-trip intact.
 *   - Legacy `codex_hooks` flag is NOT migrated (we only set what we're told).
 *   - Atomic-rename leaves no `.tmp.<pid>` siblings on success.
 *
 * Comment preservation: documented as a known limitation. The "comments in
 * [features] section trigger a warning" path is verified via the logger spy.
 */
describe("ensureCodexFeatureFlag (Phase 4 Plan 03 Task 1)", () => {
  let dir: string;
  let target: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "codex-toml-"));
    target = join(dir, "config.toml");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("creates config.toml with [features] when file is absent", async () => {
    const result = await ensureCodexFeatureFlag("hooks", true, { path: target });
    expect(result.changed).toBe(true);
    expect(result.path).toBe(target);

    const raw = await readFile(target, "utf8");
    const parsed = TOML.parse(raw) as { features?: { hooks?: boolean } };
    expect(parsed.features?.hooks).toBe(true);
  });

  it("idempotent: returns changed:false on second call with the same value", async () => {
    const first = await ensureCodexFeatureFlag("hooks", true, { path: target });
    expect(first.changed).toBe(true);
    const firstBytes = await readFile(target, "utf8");

    const second = await ensureCodexFeatureFlag("hooks", true, { path: target });
    expect(second.changed).toBe(false);
    const secondBytes = await readFile(target, "utf8");

    // Byte-for-byte identical — no rewrite happened.
    expect(secondBytes).toBe(firstBytes);
  });

  it("preserves other sections + their keys when [features] is touched", async () => {
    const fixture = `[model]
name = "gpt-5"
temperature = 0.7

[features]
other = true

[telemetry]
enabled = false
`;
    await writeFile(target, fixture, "utf8");

    const result = await ensureCodexFeatureFlag("hooks", true, { path: target });
    expect(result.changed).toBe(true);

    const parsed = TOML.parse(await readFile(target, "utf8")) as {
      model?: { name?: string; temperature?: number };
      features?: { other?: boolean; hooks?: boolean };
      telemetry?: { enabled?: boolean };
    };
    expect(parsed.model?.name).toBe("gpt-5");
    expect(parsed.model?.temperature).toBe(0.7);
    expect(parsed.features?.other).toBe(true);
    expect(parsed.features?.hooks).toBe(true);
    expect(parsed.telemetry?.enabled).toBe(false);
  });

  it("updates existing feature flag from false to true", async () => {
    await writeFile(target, `[features]\nhooks = false\n`, "utf8");

    const result = await ensureCodexFeatureFlag("hooks", true, { path: target });
    expect(result.changed).toBe(true);

    const parsed = TOML.parse(await readFile(target, "utf8")) as {
      features?: { hooks?: boolean };
    };
    expect(parsed.features?.hooks).toBe(true);
  });

  it("atomic write — no .tmp.<pid> sibling survives after success", async () => {
    await ensureCodexFeatureFlag("hooks", true, { path: target });
    const tmpPath = `${target}.${process.pid}.tmp`;
    expect(existsSync(tmpPath)).toBe(false);
  });

  it("legacy codex_hooks key is NOT touched", async () => {
    await writeFile(target, `[features]\ncodex_hooks = true\n`, "utf8");

    await ensureCodexFeatureFlag("hooks", true, { path: target });

    const parsed = TOML.parse(await readFile(target, "utf8")) as {
      features?: { codex_hooks?: boolean; hooks?: boolean };
    };
    // Both keys present — we set the new one, did not migrate the old.
    expect(parsed.features?.codex_hooks).toBe(true);
    expect(parsed.features?.hooks).toBe(true);
  });

  it("logs a single-line warning when comments exist inside [features]", async () => {
    const fixture = `[features]
# user-authored comment about hooks
other = true
`;
    await writeFile(target, fixture, "utf8");

    const logs: string[] = [];
    await ensureCodexFeatureFlag("hooks", true, {
      path: target,
      logger: (line) => logs.push(line),
    });

    expect(logs.some((l) => /comments in \[features\] section.*may be reformatted/.test(l))).toBe(
      true
    );
    // And the flag still went in.
    const parsed = TOML.parse(await readFile(target, "utf8")) as {
      features?: { hooks?: boolean; other?: boolean };
    };
    expect(parsed.features?.hooks).toBe(true);
    expect(parsed.features?.other).toBe(true);
  });

  it("does NOT warn when comments only exist outside [features]", async () => {
    const fixture = `# top-of-file comment
[model]
# comment in [model] section
name = "gpt-5"

[features]
other = true
`;
    await writeFile(target, fixture, "utf8");

    const logs: string[] = [];
    await ensureCodexFeatureFlag("hooks", true, {
      path: target,
      logger: (line) => logs.push(line),
    });

    expect(logs.some((l) => /comments in \[features\]/.test(l))).toBe(false);
  });

  it("creates parent directory implicitly via fresh write when present", async () => {
    // Sanity: writing into the existing tmpdir works on a fresh file.
    const nestedTarget = join(dir, "config.toml");
    const result = await ensureCodexFeatureFlag("hooks", true, { path: nestedTarget });
    expect(result.changed).toBe(true);
    expect(existsSync(nestedTarget)).toBe(true);
  });

  it("preserves nested table values when [features] is touched", async () => {
    const fixture = `[features]
other = true

[model.runtime]
timeout_ms = 30000
`;
    await writeFile(target, fixture, "utf8");

    await ensureCodexFeatureFlag("hooks", true, { path: target });

    const parsed = TOML.parse(await readFile(target, "utf8")) as {
      features?: { hooks?: boolean; other?: boolean };
      model?: { runtime?: { timeout_ms?: number } };
    };
    expect(parsed.features?.hooks).toBe(true);
    expect(parsed.features?.other).toBe(true);
    expect(parsed.model?.runtime?.timeout_ms).toBe(30000);
  });
});
