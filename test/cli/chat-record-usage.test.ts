import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handleChatRecordUsageCommand } from "../../src/cli/chat-record-usage.js";
import { __resetRelayDirCacheForTests } from "../../src/cli/paths.js";

const RM_OPTS = { recursive: true, force: true, maxRetries: 3, retryDelay: 50 };

/**
 * GREEN in PR-4: real `handleChatRecordUsageCommand` mints a TokenTracker,
 * calls record(), and (when --channel is passed) wires the threshold-feed
 * bridge.
 */
describe("handleChatRecordUsageCommand", () => {
  let root: string;
  const originalHome = process.env.HOME;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "relay-chat-record-"));
    process.env.HOME = root;
    __resetRelayDirCacheForTests();
  });

  afterEach(async () => {
    if (originalHome) process.env.HOME = originalHome;
    else delete process.env.HOME;
    __resetRelayDirCacheForTests();
    await rm(root, RM_OPTS);
  });

  it("writes a budget.jsonl line with kind: 'chat' when --kind chat is passed", async () => {
    await handleChatRecordUsageCommand({
      session: "sess-chat-1",
      input: 1500,
      output: 250,
      kind: "chat",
    });

    const path = join(root, ".relay", "sessions", "sess-chat-1", "budget.jsonl");
    expect(existsSync(path)).toBe(true);
    const text = await readFile(path, "utf8");
    const lastLine = text.trim().split("\n").filter(Boolean).pop();
    expect(lastLine).toBeDefined();
    const parsed = JSON.parse(lastLine!);
    expect(parsed.cumulativeUsed).toBe(1500 + 250);
    expect(parsed.kind).toBe("chat");
  });

  it("does not throw when called without --channel (no bridge wiring)", async () => {
    await expect(
      handleChatRecordUsageCommand({
        session: "sess-no-channel",
        input: 10,
        output: 5,
      })
    ).resolves.toBeUndefined();
  });
});
