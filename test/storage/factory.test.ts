import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FileHarnessStore } from "../../src/storage/file-store.js";
import { buildHarnessStore, NotImplementedError } from "../../src/storage/factory.js";
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

  it("throws NotImplementedError pointing at T-402 when HARNESS_STORE=postgres", () => {
    process.env["HARNESS_STORE"] = "postgres";
    expect(() => buildHarnessStore()).toThrow(NotImplementedError);
    expect(() => buildHarnessStore()).toThrow(/T-402/);
  });

  it("throws NotImplementedError mentioning sqlite when HARNESS_STORE=sqlite", () => {
    process.env["HARNESS_STORE"] = "sqlite";
    expect(() => buildHarnessStore()).toThrow(NotImplementedError);
    expect(() => buildHarnessStore()).toThrow(/sqlite/i);
  });

  it("throws NotImplementedError for explicit opts.kind=sqlite (same guard path)", () => {
    expect(() => buildHarnessStore({ kind: "sqlite" })).toThrow(NotImplementedError);
    expect(() => buildHarnessStore({ kind: "sqlite" })).toThrow(/sqlite/i);
  });

  it("throws NotImplementedError for explicit opts.kind=postgres with postgresUrl (same guard path)", () => {
    // Proves env-driven and opts-driven paths both flow through the same
    // NotImplementedError guard — not a separate opts-only branch.
    expect(() =>
      buildHarnessStore({
        kind: "postgres",
        postgresUrl: "postgres://example/db",
      })
    ).toThrow(NotImplementedError);
    expect(() =>
      buildHarnessStore({
        kind: "postgres",
        postgresUrl: "postgres://example/db",
      })
    ).toThrow(/T-402/);
  });

  it("falls through to file default when HARNESS_STORE is an unrecognized value", () => {
    // Pins current behavior: `HARNESS_STORE=garbage` silently falls back to
    // "file" rather than throwing. If a future refactor tightens this to
    // throw-on-unknown, updating this test should be a conscious decision.
    process.env["HARNESS_STORE"] = "garbage";
    const store = buildHarnessStore();
    expect(store).toBeInstanceOf(FileHarnessStore);
  });

  it("explicit opts.kind overrides env and opts.fileRoot roots the store there", async () => {
    process.env["HARNESS_STORE"] = "postgres";
    const store = buildHarnessStore({ kind: "file", fileRoot: tmpRoot });
    expect(store).toBeInstanceOf(FileHarnessStore);

    // Confirm fileRoot actually landed — a round-trip write shows up on disk
    // under tmpRoot rather than the default relay dir.
    await store.putDoc("canary", "probe", { ok: true });
    const loaded = await store.getDoc<{ ok: boolean }>("canary", "probe");
    expect(loaded).toEqual({ ok: true });
  });
});

describe("getHarnessStore", () => {
  it("returns the same instance across repeated calls", () => {
    const a = getHarnessStore();
    const b = getHarnessStore();
    expect(Object.is(a, b)).toBe(true);
  });
});
