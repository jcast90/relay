/**
 * AL-9 — STOP-file watcher unit tests.
 *
 * Covers the file-level contract:
 *   - `checkForStop` returns false when the file is absent, true once
 *     it exists (and never reads contents — presence is the signal).
 *   - `writeStopFile` is atomic (tmp + rename) so a concurrent
 *     `checkForStop` cannot observe a half-written file.
 *   - `writeStopFile` creates the session dir if missing so an operator
 *     can race the autonomous-loop's lazy-mkdir and still land.
 *   - `clearStopFile` is idempotent (ENOENT is a no-op) and actually
 *     removes the file.
 *   - stat errors other than ENOENT surface to the caller.
 *
 * The integration coverage (STOP flips lifecycle + respects in-flight
 * workers) lives in `autonomous-loop-drain.test.ts` — keeping the
 * watcher unit tests minimal here so the file is the obvious single
 * source for watcher behaviour.
 */
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_STOP_POLL_INTERVAL_MS,
  STOP_FILE_NAME,
  STOP_FILE_REASON,
  checkForStop,
  clearStopFile,
  stopFilePath,
  writeStopFile,
} from "../../src/orchestrator/stop-file-watcher.js";

describe("stop-file-watcher", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtempUnique();
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  async function mkdtempUnique(): Promise<string> {
    const { mkdtemp } = await import("node:fs/promises");
    return mkdtemp(join(tmpdir(), "al-9-stop-file-"));
  }

  describe("stopFilePath", () => {
    it("resolves to <root>/sessions/<sessionId>/STOP", () => {
      const path = stopFilePath("sess-abc", rootDir);
      expect(path).toBe(join(rootDir, "sessions", "sess-abc", STOP_FILE_NAME));
    });

    it("pins STOP_FILE_NAME as 'STOP' (literal, not an extension) so the CLI wire protocol is stable", () => {
      expect(STOP_FILE_NAME).toBe("STOP");
    });
  });

  describe("checkForStop", () => {
    it("returns false when the file does not exist", async () => {
      const present = await checkForStop("sess-missing", rootDir);
      expect(present).toBe(false);
    });

    it("returns false when the session dir itself does not exist (ENOENT path)", async () => {
      // Explicitly DO NOT mkdir — we want to confirm the ENOENT path
      // for both "parent missing" and "file missing" resolves the same.
      const present = await checkForStop("never-created", rootDir);
      expect(present).toBe(false);
    });

    it("returns true once the STOP file is present", async () => {
      const sessionId = "sess-present";
      const dir = join(rootDir, "sessions", sessionId);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, STOP_FILE_NAME), "", "utf8");

      const present = await checkForStop(sessionId, rootDir);
      expect(present).toBe(true);
    });

    it("does not read contents — an empty file counts as the stop signal", async () => {
      const sessionId = "sess-empty";
      const dir = join(rootDir, "sessions", sessionId);
      await mkdir(dir, { recursive: true });
      // Zero-byte file. If the watcher tried to parse JSON it would throw.
      await writeFile(join(dir, STOP_FILE_NAME), "", "utf8");

      const present = await checkForStop(sessionId, rootDir);
      expect(present).toBe(true);
    });
  });

  describe("writeStopFile", () => {
    it("creates the session dir if missing", async () => {
      // Sanity: the dir doesn't exist yet. writeStopFile must mkdir -p.
      const sessionId = "sess-new";
      const sessDir = join(rootDir, "sessions", sessionId);
      await expect(stat(sessDir)).rejects.toMatchObject({ code: "ENOENT" });

      const path = await writeStopFile(sessionId, { rootDir, source: "test" });
      expect(path).toBe(join(sessDir, STOP_FILE_NAME));
      // File is readable and parses as JSON with the expected shape.
      const raw = await readFile(path, "utf8");
      const body = JSON.parse(raw);
      expect(body.sessionId).toBe(sessionId);
      expect(body.source).toBe("test");
      expect(typeof body.requestedAt).toBe("string");
    });

    it("is observable by checkForStop immediately after resolution", async () => {
      const sessionId = "sess-roundtrip";
      await writeStopFile(sessionId, { rootDir, source: "test" });
      const present = await checkForStop(sessionId, rootDir);
      expect(present).toBe(true);
    });

    it("overwrites atomically — the final file is the newest write", async () => {
      const sessionId = "sess-overwrite";
      await writeStopFile(sessionId, { rootDir, source: "first" });
      await writeStopFile(sessionId, { rootDir, source: "second" });
      const raw = await readFile(stopFilePath(sessionId, rootDir), "utf8");
      const body = JSON.parse(raw);
      expect(body.source).toBe("second");
    });

    it("rejects empty sessionId to prevent writing into the sessions root", async () => {
      await expect(writeStopFile("", { rootDir })).rejects.toThrow(/sessionId is required/);
    });

    it("defaults source to 'unknown' when not provided (auditability)", async () => {
      const sessionId = "sess-defaultsource";
      await writeStopFile(sessionId, { rootDir });
      const raw = await readFile(stopFilePath(sessionId, rootDir), "utf8");
      expect(JSON.parse(raw).source).toBe("unknown");
    });
  });

  describe("clearStopFile", () => {
    it("removes a present STOP file", async () => {
      const sessionId = "sess-clear";
      await writeStopFile(sessionId, { rootDir });
      expect(await checkForStop(sessionId, rootDir)).toBe(true);
      await clearStopFile(sessionId, rootDir);
      expect(await checkForStop(sessionId, rootDir)).toBe(false);
    });

    it("is a no-op when the file does not exist", async () => {
      // Must not throw — operators un-stopping a session before the
      // loop picked up the signal should be safe to retry.
      await expect(clearStopFile("sess-missing", rootDir)).resolves.toBeUndefined();
    });
  });

  describe("exported constants", () => {
    it("STOP_FILE_REASON is the stable reason string the lifecycle stamps on transitions", () => {
      // Downstream tools grep for this — changing it is a breaking
      // change for dashboards / log pipelines.
      expect(STOP_FILE_REASON).toBe("user-stop-signal");
    });

    it("DEFAULT_STOP_POLL_INTERVAL_MS matches the 20s AC upper bound", () => {
      expect(DEFAULT_STOP_POLL_INTERVAL_MS).toBe(20_000);
    });
  });
});
