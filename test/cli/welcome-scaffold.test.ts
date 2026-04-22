import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { scaffoldConfigEnv } from "../../src/cli/welcome.js";

/**
 * Unit tests for the `scaffoldConfigEnv` helper used by `rly welcome`.
 *
 * The welcome flow needs to drop a `config.env` into a fresh `~/.relay/` when
 * the user opts in. These tests pin down the three cases the welcome prompt
 * can land on: template present / target already present / template missing.
 * Idempotency matters — running the welcome tour twice must not clobber a
 * config file the user has already edited.
 */

describe("scaffoldConfigEnv", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "relay-scaffold-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("copies template -> config.env when target is missing", async () => {
    const templateBody = '# test template\n# export GITHUB_TOKEN=""\n';
    await writeFile(join(dir, "config.env.template"), templateBody);

    const result = await scaffoldConfigEnv(dir);

    expect(result.status).toBe("created");
    if (result.status === "created") {
      expect(result.to).toBe(join(dir, "config.env"));
      expect(result.from).toBe(join(dir, "config.env.template"));
    }

    const copied = await readFile(join(dir, "config.env"), "utf8");
    expect(copied).toBe(templateBody);
  });

  it("is idempotent — never overwrites an existing config.env", async () => {
    await writeFile(join(dir, "config.env.template"), "# template\n");
    await writeFile(join(dir, "config.env"), "# user edits — do not touch\n");

    const first = await scaffoldConfigEnv(dir);
    expect(first.status).toBe("already-exists");

    // Run again — still untouched.
    const second = await scaffoldConfigEnv(dir);
    expect(second.status).toBe("already-exists");

    const preserved = await readFile(join(dir, "config.env"), "utf8");
    expect(preserved).toBe("# user edits — do not touch\n");
  });

  it("returns missing-template when the template isn't there", async () => {
    const result = await scaffoldConfigEnv(dir);
    expect(result.status).toBe("missing-template");
    if (result.status === "missing-template") {
      expect(result.expectedTemplate).toBe(join(dir, "config.env.template"));
    }

    // And no config.env was created as a side effect.
    await expect(stat(join(dir, "config.env"))).rejects.toThrow();
  });
});
