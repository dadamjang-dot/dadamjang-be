import { createHash } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import type { Pool } from "pg";

type MigrateOptions = {
  readonly pool: Pool;
  readonly beforeMigration?: (name: string, pool: Pool) => Promise<void>;
};

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export const migrate = async ({ pool, beforeMigration }: MigrateOptions) => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "_migrations" (
      "name" text PRIMARY KEY,
      "checksum" text NOT NULL,
      "appliedAt" timestamp NOT NULL DEFAULT now()
    )
  `);
  const migrationsDir = path.join(process.cwd(), "migrations");
  const files = (await fs.readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) {
    const sql = await fs.readFile(path.join(migrationsDir, file), "utf8");
    const checksum = sha256(sql);
    const applied = await pool.query<{ checksum: string }>('SELECT "checksum" FROM "_migrations" WHERE "name" = $1', [
      file,
    ]);
    if (applied.rowCount) {
      if (applied.rows[0]?.checksum !== checksum) throw new Error(`migration checksum changed: ${file}`);
      continue;
    }
    await beforeMigration?.(file, pool);
    await pool.query("BEGIN");
    try {
      await pool.query(sql);
      await pool.query('INSERT INTO "_migrations" ("name", "checksum") VALUES ($1, $2)', [file, checksum]);
      await pool.query("COMMIT");
      process.stdout.write(`applied ${file}\n`);
    } catch (error) {
      await pool.query("ROLLBACK");
      throw error;
    }
  }
};
