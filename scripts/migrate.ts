import { createHash } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { Pool } from "pg";

const migrationsDir = path.join(process.cwd(), "migrations");

const requiredEnv = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

const main = async () => {
  const pool = new Pool({
    host: process.env.POSTGRES_HOST,
    port: Number(process.env.POSTGRES_PORT ?? 5432),
    user: process.env.POSTGRES_USERNAME,
    password: process.env.POSTGRES_PASSWORD,
    database: requiredEnv("POSTGRES_DATABASE"),
    ssl: process.env.POSTGRES_SSL === "true" ? { rejectUnauthorized: false } : undefined,
  });

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS "_migrations" (
        "name" text PRIMARY KEY,
        "checksum" text NOT NULL,
        "appliedAt" timestamp NOT NULL DEFAULT now()
      )
    `);

    const files = (await fs.readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();

    for (const file of files) {
      const sql = await fs.readFile(path.join(migrationsDir, file), "utf8");
      const checksum = sha256(sql);
      const applied = await pool.query<{ checksum: string }>('SELECT "checksum" FROM "_migrations" WHERE "name" = $1', [
        file,
      ]);

      if (applied.rowCount) {
        if (applied.rows[0].checksum !== checksum) throw new Error(`migration checksum changed: ${file}`);
        continue;
      }

      await pool.query("BEGIN");
      try {
        await pool.query(sql);
        await pool.query('INSERT INTO "_migrations" ("name", "checksum") VALUES ($1, $2)', [file, checksum]);
        await pool.query("COMMIT");
        console.log(`applied ${file}`);
      } catch (error) {
        await pool.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await pool.end();
  }
};

void main();
