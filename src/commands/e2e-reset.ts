import { assertDatabaseMode, createDatabasePool } from "src/database/connection";
import { resetFixtures, seedMigrationPrerequisite } from "src/database/fixtures";
import { migrate } from "src/database/migrate";

const requiredEnv = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const main = async () => {
  assertDatabaseMode("e2e");
  const fixtures = {
    password: requiredEnv("E2E_USER_PASSWORD"),
    userid: requiredEnv("E2E_USER_ID"),
  };
  const pool = createDatabasePool();
  try {
    await migrate({
      pool,
      beforeMigration: async (name, migrationPool) => {
        if (name === "0005_catalog_demo_products.sql") await seedMigrationPrerequisite(migrationPool);
      },
    });
    await resetFixtures(pool, fixtures);
    process.stdout.write("e2e fixtures reset\n");
  } finally {
    await pool.end();
  }
};

void main();
