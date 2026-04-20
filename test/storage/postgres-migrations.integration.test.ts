import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pg from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it
} from "vitest";

import { migrate } from "../../src/storage/migrations/runner.js";

/**
 * Integration tests for the forward-only migration runner, gated on
 * HARNESS_TEST_POSTGRES_URL. The runner is small but load-bearing — a
 * silent partial apply would poison the store. These tests pin the
 * rerun-is-noop contract, lexical ordering, and rollback-on-failure.
 */

const TEST_URL = process.env["HARNESS_TEST_POSTGRES_URL"];
const skipReason =
  "requires HARNESS_TEST_POSTGRES_URL; set e.g. postgres://postgres@localhost:5432/relay_test";

const maybeDescribe = TEST_URL ? describe : describe.skip;

maybeDescribe(
  `migrate() runner (integration, ${TEST_URL ?? skipReason})`,
  () => {
    let pool: pg.Pool;
    let migrationsDir: string;
    let schemaPrefix: string;

    beforeAll(async () => {
      if (!TEST_URL) return;
      pool = new pg.Pool({ connectionString: TEST_URL });
    });

    afterAll(async () => {
      if (!pool) return;
      await pool.end();
    });

    beforeEach(async () => {
      if (!TEST_URL) return;
      // Unique per-test prefix lets multiple migration tests coexist in the
      // same DB without fighting each other for the same table names. The
      // SQL written into tmp files below interpolates this prefix so we
      // never touch the real `harness_*` tables.
      schemaPrefix = `mig_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
      migrationsDir = await mkdtemp(join(tmpdir(), "relay-mig-"));
    });

    afterEach(async () => {
      if (!TEST_URL) return;
      if (pool) {
        // Clean up anything these tests created. CASCADE avoids FK noise.
        await pool.query(
          `DROP TABLE IF EXISTS ${schemaPrefix}_a, ${schemaPrefix}_b CASCADE`
        );
        // Guarded because `harness_schema_migrations` is only created the
        // first time any migrate() call runs in the DB; the `skip reason`
        // test doesn't invoke migrate() so the table may not exist yet.
        await pool
          .query(
            `DELETE FROM harness_schema_migrations WHERE version LIKE $1`,
            [`${schemaPrefix}%`]
          )
          .catch(() => undefined);
      }
      if (migrationsDir) {
        await rm(migrationsDir, { recursive: true, force: true });
      }
    });

    it("skip reason", () => {
      if (!TEST_URL) {
        // eslint-disable-next-line no-console
        console.log(skipReason);
      }
      expect(true).toBe(true);
    });

    it("applies a single migration, then the second call is a no-op", async () => {
      if (!TEST_URL) return;
      const v1 = `001_${schemaPrefix}`;
      await writeFile(
        join(migrationsDir, `${v1}.sql`),
        `CREATE TABLE ${schemaPrefix}_a (id INT PRIMARY KEY);`
      );

      const first = await migrate({ pool, migrationsDir });
      expect(first).toEqual([{ version: v1, alreadyApplied: false }]);

      const second = await migrate({ pool, migrationsDir });
      expect(second).toEqual([{ version: v1, alreadyApplied: true }]);

      const row = await pool.query(
        "SELECT 1 FROM harness_schema_migrations WHERE version = $1",
        [v1]
      );
      expect(row.rowCount).toBe(1);
    });

    it("applies migrations in lexical order", async () => {
      if (!TEST_URL) return;
      const vA = `001_${schemaPrefix}`;
      const vB = `002_${schemaPrefix}`;
      await writeFile(
        join(migrationsDir, `${vB}.sql`),
        `CREATE TABLE ${schemaPrefix}_b (id INT PRIMARY KEY REFERENCES ${schemaPrefix}_a(id));`
      );
      await writeFile(
        join(migrationsDir, `${vA}.sql`),
        `CREATE TABLE ${schemaPrefix}_a (id INT PRIMARY KEY);`
      );
      // The 002 file references 001's table — if the runner applied them
      // out of order the CREATE TABLE would fail on a missing FK target.
      const applied = await migrate({ pool, migrationsDir });
      expect(applied.map((m) => m.version)).toEqual([vA, vB]);
    });

    it("rolls a failing migration back and leaves harness_schema_migrations untouched", async () => {
      if (!TEST_URL) return;
      const vGood = `001_${schemaPrefix}`;
      const vBad = `002_${schemaPrefix}`;
      await writeFile(
        join(migrationsDir, `${vGood}.sql`),
        `CREATE TABLE ${schemaPrefix}_a (id INT PRIMARY KEY);`
      );
      await writeFile(
        join(migrationsDir, `${vBad}.sql`),
        `THIS IS NOT SQL AT ALL`
      );

      await expect(migrate({ pool, migrationsDir })).rejects.toThrow();

      const good = await pool.query(
        "SELECT 1 FROM harness_schema_migrations WHERE version = $1",
        [vGood]
      );
      expect(good.rowCount).toBe(1);
      const bad = await pool.query(
        "SELECT 1 FROM harness_schema_migrations WHERE version = $1",
        [vBad]
      );
      expect(bad.rowCount).toBe(0);
    });
  }
);
