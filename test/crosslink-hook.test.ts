import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { generateHookScripts } from "../src/crosslink/hook.js";
import { __resetRelayDirCacheForTests } from "../src/cli/paths.js";

/**
 * The crosslink hook script is generated as a standalone node file that
 * reads `FileHarnessStore`'s namespace directories directly — it doesn't
 * import the rest of the harness at runtime. If any of these strings drift
 * (typo in the namespace, wrong separator) the script silently stops
 * delivering messages, and nothing else will catch it because the generator
 * just embeds string literals. These tests pin the emitted shape and then
 * run the generated script against a synthetic fixture to prove the
 * read/write paths line up with what `CrosslinkStore` writes.
 */
describe("generateHookScripts", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "crosslink-hook-"));
    prevHome = process.env.HOME;
    process.env.HOME = home;
    // Force `getRelayDir()` to re-resolve against the fresh HOME.
    __resetRelayDirCacheForTests();
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

  it("emits a node script referencing the crosslink-session and crosslink-mailbox namespaces and the __ separator", async () => {
    const { nodeScriptPath, shellScriptPath } = await generateHookScripts();

    const script = await readFile(nodeScriptPath, "utf8");

    // Guards the exact strings that have to match `STORE_NS.crosslinkSession`,
    // `STORE_NS.crosslinkMailbox`, and `MAILBOX_ID_SEPARATOR` from
    // `src/crosslink/store.ts`. A typo here = silent loss of message delivery.
    expect(script).toContain("crosslink-session");
    expect(script).toContain("crosslink-mailbox");
    expect(script).toContain('MAILBOX_ID_SEPARATOR = "__"');

    // Shell wrapper must point at the generated node script.
    const shell = await readFile(shellScriptPath, "utf8");
    expect(shell).toContain(nodeScriptPath);
  });

  it("runs end-to-end: reads a synthetic pending message and writes it back as delivered", async () => {
    const { nodeScriptPath } = await generateHookScripts();

    // The hook uses `<HOME>/.relay` as RELAY_DIR. Seed one active session
    // plus one pending message addressed to that session, in the exact
    // FileHarnessStore layout the generator targets
    // (`crosslink-session/<id>.json`,
    // `crosslink-mailbox/<to>__<msgId>.json`).
    const relayDir = join(home, ".relay");
    const sessionsDir = join(relayDir, "crosslink-session");
    const mailboxesDir = join(relayDir, "crosslink-mailbox");
    await mkdir(sessionsDir, { recursive: true });
    await mkdir(mailboxesDir, { recursive: true });

    const sessionId = "session-hook-test";
    const messageId = "msg-hook-test";

    await writeFile(
      join(sessionsDir, `${sessionId}.json`),
      JSON.stringify({
        sessionId,
        pid: process.pid,
        repoPath: "/tmp/hook-test",
        description: "hook test session",
        capabilities: ["general"],
        agentProvider: "claude",
        status: "active",
        registeredAt: new Date().toISOString(),
        lastHeartbeat: new Date().toISOString()
      })
    );

    const messagePath = join(mailboxesDir, `${sessionId}__${messageId}.json`);
    await writeFile(
      messagePath,
      JSON.stringify({
        messageId,
        fromSessionId: "session-hook-sender",
        toSessionId: sessionId,
        type: "message",
        content: "hook-delivered-content",
        inReplyTo: null,
        status: "pending",
        createdAt: new Date().toISOString(),
        deliveredAt: null,
        repliedAt: null
      })
    );

    // Run the generated script. Set RELAY_SESSION so it targets our fixture
    // session deterministically regardless of PID-ancestry heuristics.
    const out = execFileSync(process.execPath, [nodeScriptPath], {
      env: { ...process.env, RELAY_SESSION: sessionId },
      encoding: "utf8"
    });

    expect(out).toContain("CROSSLINK INBOUND");
    expect(out).toContain("hook-delivered-content");
    expect(out).toContain(`messageId=${messageId}`);

    // The script should have atomically rewritten the same file, flipping
    // status to "delivered" and stamping `deliveredAt`. Proves the write
    // path keys off `<to>__<msgId>.json` correctly.
    const after = JSON.parse(await readFile(messagePath, "utf8"));
    expect(after.status).toBe("delivered");
    expect(typeof after.deliveredAt).toBe("string");
    expect(after.deliveredAt).not.toBeNull();
  });
});
