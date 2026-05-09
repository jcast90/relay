import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  formatActiveSessionsBlock,
  loadActiveSessions,
  type ActiveSessionRow,
} from "../../src/cli/print-status-context.js";

const RM_OPTS = { recursive: true, force: true, maxRetries: 3, retryDelay: 50 };

/**
 * RED tests for the `rly status` Active Sessions block. PR-1 ships the
 * stub-throwing formatters; PR-4 (Task 11) lands the implementations.
 */
describe.todo("formatActiveSessionsBlock", () => {
  it("renders one line per session with model + ctx pct + used/total", () => {
    const rows: ActiveSessionRow[] = [
      {
        sessionId: "sess-abc",
        channelId: "ch-1",
        pct: 76,
        used: 152_000,
        total: 200_000,
        model: "Sonnet 4.5",
        kind: "chat",
      },
    ];
    const out = formatActiveSessionsBlock(rows);
    expect(out).toMatch(/sess-abc/);
    expect(out).toMatch(/ch-1/);
    expect(out).toMatch(/76%/);
    expect(out).toMatch(/Sonnet 4\.5/);
  });

  it("returns an empty (or 'no active sessions') block on empty input", () => {
    const out = formatActiveSessionsBlock([]);
    expect(out).toBeDefined();
  });
});

describe.todo("loadActiveSessions", () => {
  let root: string;
  const originalHome = process.env.HOME;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "relay-status-"));
    process.env.HOME = root;
  });

  afterEach(async () => {
    if (originalHome) process.env.HOME = originalHome;
    else delete process.env.HOME;
    await rm(root, RM_OPTS);
  });

  it("returns [] when ~/.relay/sessions/ does not exist (L3 isolation)", () => {
    // No sessions dir under root/.relay/. Must return empty without throwing.
    const result = loadActiveSessions();
    expect(result).toEqual([]);
  });

  it("filters out kind=run and kind=admin budgets, surfaces only kind=chat (M3 + M4)", async () => {
    const sessionsRoot = join(root, ".relay", "sessions");
    await mkdir(join(sessionsRoot, "sess-chat"), { recursive: true });
    await writeFile(
      join(sessionsRoot, "sess-chat", "budget.jsonl"),
      JSON.stringify({ cumulativeUsed: 100, kind: "chat" }) + "\n"
    );
    await mkdir(join(sessionsRoot, "run-x"), { recursive: true });
    await writeFile(
      join(sessionsRoot, "run-x", "budget.jsonl"),
      JSON.stringify({ cumulativeUsed: 100, kind: "run" }) + "\n"
    );
    await mkdir(join(sessionsRoot, "admin-y"), { recursive: true });
    await writeFile(
      join(sessionsRoot, "admin-y", "budget.jsonl"),
      JSON.stringify({ cumulativeUsed: 100, kind: "admin" }) + "\n"
    );

    const rows = loadActiveSessions();
    expect(rows.map((r) => r.sessionId)).toEqual(["sess-chat"]);
  });

  it("isolates a malformed session file so other sessions still surface (L3)", async () => {
    const sessionsRoot = join(root, ".relay", "sessions");
    await mkdir(join(sessionsRoot, "sess-good"), { recursive: true });
    await writeFile(
      join(sessionsRoot, "sess-good", "budget.jsonl"),
      JSON.stringify({ cumulativeUsed: 50, kind: "chat" }) + "\n"
    );
    await mkdir(join(sessionsRoot, "sess-bad"), { recursive: true });
    await writeFile(join(sessionsRoot, "sess-bad", "budget.jsonl"), "{ malformed line\n");

    const rows = loadActiveSessions();
    expect(rows.find((r) => r.sessionId === "sess-good")).toBeDefined();
  });
});
