import type { Pool } from "pg";
import { assertDatabaseMode, createDatabasePool } from "../../src/database/connection";
import { resetFixtures, seedMigrationPrerequisite } from "../../src/database/fixtures";
import { migrate } from "../../src/database/migrate";

export const testPool = () => {
  assertDatabaseMode("test");
  return createDatabasePool();
};

export const migrateTestDatabase = async (pool: Pool) =>
  migrate({
    pool,
    beforeMigration: async (name, migrationPool) => {
      if (name === "0005_catalog_demo_products.sql") await seedMigrationPrerequisite(migrationPool);
    },
  });

export const resetTestFixtures = async (pool: Pool) => {
  assertDatabaseMode("test");
  await resetFixtures(pool);
};
