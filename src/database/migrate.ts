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
    const migrations = (
      await Promise.all(
        [
          { directory: path.join(process.cwd(), "migrations"), retired: false },
          { directory: path.join(process.cwd(), "retired-migrations"), retired: true },
        ].map(async ({ directory, retired }) =>
          (await fs.readdir(directory))
            .filter((name) => name.endsWith(".sql"))
            .map((name) => ({ directory, name, retired })),
        ),
      )
    )
      .flat()
      .sort((left, right) => left.name.localeCompare(right.name));
    for (let index = 1; index < migrations.length; index += 1) {
      if (migrations[index - 1]?.name === migrations[index]?.name)
        throw new Error(`duplicate migration: ${migrations[index]?.name}`);
    }
    for (const { directory, name, retired } of migrations) {
      const migrationSql = await fs.readFile(path.join(directory, name), "utf8");
      const checksum = sha256(migrationSql);
      const applied = await client.query<{ checksum: string }>(
        'SELECT "checksum" FROM "_migrations" WHERE "name" = $1',
        [name],
      );
      if (applied.rowCount) {
        if (applied.rows[0]?.checksum !== checksum) throw new Error(`migration checksum changed: ${name}`);
        continue;
      }
      if (retired) {
        await client.query('INSERT INTO "_migrations" ("name", "checksum") VALUES ($1, $2)', [name, checksum]);
        continue;
      }
      await beforeMigration?.(name, pool);
      await client.query("BEGIN");
      try {
        await client.query(`SELECT set_config('lock_timeout', $1, true)`, [`${lockTimeoutMs}ms`]);
        await client.query(`SELECT set_config('statement_timeout', $1, true)`, [`${statementTimeoutMs}ms`]);
        await client.query(migrationSql);
        await client.query('INSERT INTO "_migrations" ("name", "checksum") VALUES ($1, $2)', [name, checksum]);
        await client.query("COMMIT");
        process.stdout.write(`applied ${name}\n`);
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
