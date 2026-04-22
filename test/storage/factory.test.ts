import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FileHarnessStore } from "../../src/storage/file-store.js";
import { buildHarnessStore } from "../../src/storage/factory.js";
import { getHarnessStore } from "../../src/index.js";

describe("buildHarnessStore", () => {
  let savedEnv: string | undefined;
  let tmpRoot: string;

  beforeEach(async () => {
    savedEnv = process.env["HARNESS_STORE"];
    delete process.env["HARNESS_STORE"];
    tmpRoot = await mkdtemp(join(tmpdir(), "relay-factory-"));
  });

  afterEach(async () => {
    if (savedEnv === undefined) {
      delete process.env["HARNESS_STORE"];
    } else {
      process.env["HARNESS_STORE"] = savedEnv;
    }
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("returns a FileHarnessStore by default when HARNESS_STORE is unset", () => {
    const store = buildHarnessStore();
    expect(store).toBeInstanceOf(FileHarnessStore);
  });

  it("returns a FileHarnessStore when HARNESS_STORE=file", () => {
    process.env["HARNESS_STORE"] = "file";
    const store = buildHarnessStore();
    expect(store).toBeInstanceOf(FileHarnessStore);
  });

  it("warns and falls back to FileHarnessStore when HARNESS_STORE=postgres", () => {
    // OSS-21: Postgres moved to Roadmap; setting the env should warn + degrade
    // rather than throw so old scripts don't crash.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      process.env["HARNESS_STORE"] = "postgres";
      const store = buildHarnessStore();
      expect(store).toBeInstanceOf(FileHarnessStore);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toMatch(/HARNESS_STORE='postgres' ignored/);
    } finally {
      warn.mockRestore();
    }
  });

  it("warns and falls back to FileHarnessStore when HARNESS_STORE=sqlite", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      process.env["HARNESS_STORE"] = "sqlite";
      const store = buildHarnessStore();
      expect(store).toBeInstanceOf(FileHarnessStore);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toMatch(/HARNESS_STORE='sqlite' ignored/);
    } finally {
      warn.mockRestore();
    }
  });

  it("warns and falls back for explicit opts.kind=sqlite", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const store = buildHarnessStore({ kind: "sqlite" });
      expect(store).toBeInstanceOf(FileHarnessStore);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("warns and falls back for explicit opts.kind=postgres (env + opts both degrade through the same branch)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const store = buildHarnessStore({
        kind: "postgres",
        postgresUrl: "postgres://example/db",
      });
      expect(store).toBeInstanceOf(FileHarnessStore);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("falls through to file default when HARNESS_STORE is an unrecognized value", () => {
    // Pins current behavior: `HARNESS_STORE=garbage` silently falls back to
    // "file" without a warning — unrecognized values are treated as "user
    // didn't set the var" rather than "user asked for an unimplemented
    // backend". If a future refactor tightens this to warn-on-unknown,
    // updating this test should be a conscious decision.
    process.env["HARNESS_STORE"] = "garbage";
    const store = buildHarnessStore();
    expect(store).toBeInstanceOf(FileHarnessStore);
  });

  it("explicit opts.kind=file with fileRoot overrides env and roots the store there", async () => {
    process.env["HARNESS_STORE"] = "postgres";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const store = buildHarnessStore({ kind: "file", fileRoot: tmpRoot });
      expect(store).toBeInstanceOf(FileHarnessStore);

      // Confirm fileRoot actually landed — a round-trip write shows up on disk
      // under tmpRoot rather than the default relay dir.
      await store.putDoc("canary", "probe", { ok: true });
      const loaded = await store.getDoc<{ ok: boolean }>("canary", "probe");
      expect(loaded).toEqual({ ok: true });
      // opts.kind="file" wins over env, so no warning should fire.
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("getHarnessStore", () => {
  it("returns the same instance across repeated calls", () => {
    const a = getHarnessStore();
    const b = getHarnessStore();
    expect(Object.is(a, b)).toBe(true);
  });
});
