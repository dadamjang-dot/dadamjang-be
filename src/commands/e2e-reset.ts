import { assertDatabaseMode, createDatabasePool } from "src/database/connection";
import { resetFixtures } from "src/database/fixtures";

const requiredEnv = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const main = async () => {
  assertDatabaseMode("e2e");
  const pool = createDatabasePool();
  try {
    await resetFixtures(pool, {
      password: requiredEnv("E2E_USER_PASSWORD"),
      userid: requiredEnv("E2E_USER_ID"),
    });
    process.stdout.write("e2e fixtures reset\n");
  } finally {
    await pool.end();
  }
};

void main();
