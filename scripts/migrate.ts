import { Pool } from "pg";
import { migrate } from "src/database/migrate";

const requiredEnv = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

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
    await migrate({ pool });
  } finally {
    await pool.end();
  }
};

void main();
