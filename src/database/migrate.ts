import { createHash } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import type { Pool } from "pg";

type MigrateOptions = {
  readonly pool: Pool;
  readonly beforeMigration?: (name: string, pool: Pool) => Promise<void>;
  readonly advisoryLockTimeoutMs?: number;
  readonly lockTimeoutMs?: number;
  readonly statementTimeoutMs?: number;
};

const MIGRATION_ADVISORY_LOCK_KEY = "730221104885236353";
const DEFAULT_ADVISORY_LOCK_TIMEOUT_MS = 30_000;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 300_000;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export const migrate = async ({
  pool,
  beforeMigration,
  advisoryLockTimeoutMs = DEFAULT_ADVISORY_LOCK_TIMEOUT_MS,
  lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
  statementTimeoutMs = DEFAULT_STATEMENT_TIMEOUT_MS,
}: MigrateOptions) => {
  const client = await pool.connect();
  let advisoryLockAcquired = false;
  try {
    await client.query(`SELECT set_config('statement_timeout', $1, false)`, [`${advisoryLockTimeoutMs}ms`]);
    await client.query(`SELECT pg_advisory_lock($1::bigint)`, [MIGRATION_ADVISORY_LOCK_KEY]);
    advisoryLockAcquired = true;
    await client.query(`SELECT set_config('lock_timeout', $1, false)`, [`${lockTimeoutMs}ms`]);
    await client.query(`SELECT set_config('statement_timeout', $1, false)`, [`${statementTimeoutMs}ms`]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS "_migrations" (
        "name" text PRIMARY KEY,
        "checksum" text NOT NULL,
        "appliedAt" timestamp NOT NULL DEFAULT now()
      )
    `);
    const migrationsDir = path.join(process.cwd(), "migrations");
    const files = (await fs.readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
    for (const file of files) {
      const migrationSql = await fs.readFile(path.join(migrationsDir, file), "utf8");
      const checksum = sha256(migrationSql);
      const applied = await client.query<{ checksum: string }>(
        'SELECT "checksum" FROM "_migrations" WHERE "name" = $1',
        [file],
      );
      if (applied.rowCount) {
        if (applied.rows[0]?.checksum !== checksum) throw new Error(`migration checksum changed: ${file}`);
        continue;
      }
      await beforeMigration?.(file, pool);
      await client.query("BEGIN");
      try {
        await client.query(`SELECT set_config('lock_timeout', $1, true)`, [`${lockTimeoutMs}ms`]);
        await client.query(`SELECT set_config('statement_timeout', $1, true)`, [`${statementTimeoutMs}ms`]);
        await client.query(migrationSql);
        await client.query('INSERT INTO "_migrations" ("name", "checksum") VALUES ($1, $2)', [file, checksum]);
        await client.query("COMMIT");
        process.stdout.write(`applied ${file}\n`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    try {
      if (advisoryLockAcquired)
        await client.query(`SELECT pg_advisory_unlock($1::bigint)`, [MIGRATION_ADVISORY_LOCK_KEY]);
    } finally {
      client.release();
    }
  }
};
