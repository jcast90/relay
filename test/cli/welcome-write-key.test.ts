import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeConfigEnvKey } from "../../src/cli/welcome.js";

/**
 * Unit tests for the `writeConfigEnvKey` helper used by `rly welcome` when the
 * user pastes tokens during onboarding. The helper rewrites a matching
 * `[# ]export KEY=...` line in `config.env` (or appends one), escapes shell
 * metacharacters inside the double-quoted value, and reapplies 0600 perms.
 */

describe("writeConfigEnvKey", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "relay-write-key-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("replaces a commented template line and uncomments it", async () => {
    const body = [
      "# header comment",
      '# export GITHUB_TOKEN=""',
      '# export LINEAR_API_KEY=""'
    ].join("\n");
    await writeFile(join(dir, "config.env"), body);

    const result = await writeConfigEnvKey(dir, "GITHUB_TOKEN", "ghp_abc123");
    expect(result).toEqual({ status: "written", mode: "replaced" });

    const out = await readFile(join(dir, "config.env"), "utf8");
    expect(out).toContain('export GITHUB_TOKEN="ghp_abc123"');
    // The Linear template line is untouched.
    expect(out).toContain('# export LINEAR_API_KEY=""');
    // The header comment survives.
    expect(out).toContain("# header comment");
  });

  it("replaces an existing uncommented value in place", async () => {
    const body = 'export GITHUB_TOKEN="old_value"\n# other\n';
    await writeFile(join(dir, "config.env"), body);

    const result = await writeConfigEnvKey(dir, "GITHUB_TOKEN", "new_value");
    expect(result).toEqual({ status: "written", mode: "replaced" });

    const out = await readFile(join(dir, "config.env"), "utf8");
    expect(out).toContain('export GITHUB_TOKEN="new_value"');
    expect(out).not.toContain("old_value");
  });

  it("appends the export when no matching line exists", async () => {
    await writeFile(join(dir, "config.env"), "# no tokens here\n");

    const result = await writeConfigEnvKey(dir, "GITHUB_TOKEN", "ghp_xyz");
    expect(result).toEqual({ status: "written", mode: "appended" });

    const out = await readFile(join(dir, "config.env"), "utf8");
    expect(out).toContain("# no tokens here");
    expect(out.trim().endsWith('export GITHUB_TOKEN="ghp_xyz"')).toBe(true);
  });

  it("escapes shell metacharacters inside the quoted value", async () => {
    await writeFile(join(dir, "config.env"), '# export SECRET=""\n');

    await writeConfigEnvKey(dir, "SECRET", 'a"b\\c$d`e');
    const out = await readFile(join(dir, "config.env"), "utf8");
    expect(out).toContain('export SECRET="a\\"b\\\\c\\$d\\`e"');
  });

  it("returns missing-config when config.env is absent", async () => {
    const result = await writeConfigEnvKey(dir, "GITHUB_TOKEN", "x");
    expect(result).toEqual({ status: "missing-config" });
  });

  it("handles a file with no trailing newline on the replace path", async () => {
    // No `\n` at the end of the last line.
    await writeFile(join(dir, "config.env"), 'export GITHUB_TOKEN="old"');

    const result = await writeConfigEnvKey(dir, "GITHUB_TOKEN", "new");
    expect(result).toEqual({ status: "written", mode: "replaced" });

    const out = await readFile(join(dir, "config.env"), "utf8");
    expect(out).toContain('export GITHUB_TOKEN="new"');
    expect(out).not.toContain("old");
  });

  it("rejects bogus env var names so the inlined regex can't be gamed", async () => {
    await writeFile(join(dir, "config.env"), "# stub\n");
    await expect(
      writeConfigEnvKey(dir, "GITHUB_TOKEN.*", "x")
    ).rejects.toThrow(/invalid env var name/);
  });

  it("re-applies 0600 permissions after writing", async () => {
    await writeFile(join(dir, "config.env"), '# export GITHUB_TOKEN=""\n', {
      mode: 0o644
    });

    await writeConfigEnvKey(dir, "GITHUB_TOKEN", "v");
    const st = await stat(join(dir, "config.env"));
    // Compare the low 9 perm bits — filesystem may expose extra bits on macOS.
    expect(st.mode & 0o777).toBe(0o600);
  });
});
