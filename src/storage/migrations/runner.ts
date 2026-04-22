import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

/**
 * Tiny forward-only migration runner. Reads `NNN_*.sql` files from this
 * directory in lexical order, runs each inside a transaction, and records the
 * version in `harness_schema_migrations`. Re-running is a no-op.
 *
 * Deliberately minimal — we don't need down migrations, checksums, or
 * branching histories. A separate library adds weight we don't earn back at
 * this scale.
 */

export interface MigrateOptions {
  pool?: pg.Pool;
  connectionString?: string;
  migrationsDir?: string;
}

export interface AppliedMigration {
  version: string;
  alreadyApplied: boolean;
}

const SCHEMA_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS harness_schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)
`;

export async function migrate(opts: MigrateOptions = {}): Promise<AppliedMigration[]> {
  const { pool, ownsPool } = resolvePool(opts);
  const dir = opts.migrationsDir ?? defaultMigrationsDir();

  try {
    await pool.query(SCHEMA_TABLE_DDL);
    const files = (await readdir(dir)).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();

    const applied: AppliedMigration[] = [];
    for (const file of files) {
      const version = file.replace(/\.sql$/, "");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { rowCount } = await client.query(
          "SELECT 1 FROM harness_schema_migrations WHERE version = $1",
          [version]
        );
        if (rowCount && rowCount > 0) {
          await client.query("COMMIT");
          applied.push({ version, alreadyApplied: true });
          continue;
        }
        const sql = await readFile(join(dir, file), "utf8");
        await client.query(sql);
        await client.query("INSERT INTO harness_schema_migrations (version) VALUES ($1)", [
          version,
        ]);
        await client.query("COMMIT");
        applied.push({ version, alreadyApplied: false });
      } catch (err) {
        await client.query("ROLLBACK").catch((rollbackErr) => {
          console.warn(
            `[migration] ROLLBACK failed after ${version} error: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`
          );
        });
        throw err;
      } finally {
        client.release();
      }
    }
    return applied;
  } finally {
    if (ownsPool) await pool.end();
  }
}

function resolvePool(opts: MigrateOptions): {
  pool: pg.Pool;
  ownsPool: boolean;
} {
  if (opts.pool) return { pool: opts.pool, ownsPool: false };
  const connectionString = opts.connectionString ?? process.env["HARNESS_POSTGRES_URL"];
  if (!connectionString) {
    throw new Error(
      "migrate(): pass { pool } or { connectionString }, or set HARNESS_POSTGRES_URL"
    );
  }
  return { pool: new pg.Pool({ connectionString }), ownsPool: true };
}

function defaultMigrationsDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

// CLI entry: `tsx src/storage/migrations/runner.ts migrate`
const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("runner.ts") === true ||
  process.argv[1]?.endsWith("runner.js") === true;

if (isMain && process.argv[2] === "migrate") {
  migrate()
    .then((results) => {
      for (const r of results) {
        const tag = r.alreadyApplied ? "skip" : "apply";
        process.stdout.write(`${tag} ${r.version}\n`);
      }
    })
    .catch((err) => {
      process.stderr.write(`migrate failed: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
