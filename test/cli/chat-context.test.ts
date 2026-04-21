import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readAgentsMdSummary } from "../../src/cli/chat-context.js";

describe("readAgentsMdSummary", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "chat-ctx-agents-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns null when no AGENTS.md variant exists", () => {
    expect(readAgentsMdSummary(dir)).toBeNull();
  });

  it("returns null for an unreadable/missing path", () => {
    const bogus = join(dir, "does-not-exist");
    expect(readAgentsMdSummary(bogus)).toBeNull();
  });

  it("reads AGENTS.md and caps the output at the requested line count", async () => {
    const lines = Array.from({ length: 80 }, (_, i) => `line-${i + 1}`);
    await writeFile(join(dir, "AGENTS.md"), lines.join("\n"));

    const summary = readAgentsMdSummary(dir, 40);
    expect(summary).not.toBeNull();

    const out = summary!.split("\n");
    expect(out).toHaveLength(40);
    expect(out[0]).toBe("line-1");
    expect(out[39]).toBe("line-40");
  });

  it("accepts alternate case variants (Agents.md, agents.md)", async () => {
    await writeFile(join(dir, "agents.md"), "# Hello\nBody line");
    const summary = readAgentsMdSummary(dir);
    expect(summary).toBe("# Hello\nBody line");
  });

  it("returns null when AGENTS.md is empty", async () => {
    await writeFile(join(dir, "AGENTS.md"), "");
    expect(readAgentsMdSummary(dir)).toBeNull();
  });

  it("defaults to a 40-line cap when no limit is passed", async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `l${i}`);
    await writeFile(join(dir, "AGENTS.md"), lines.join("\n"));

    const summary = readAgentsMdSummary(dir);
    expect(summary!.split("\n")).toHaveLength(40);
  });
});
