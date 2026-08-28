import type { Pool } from "pg";
import { assertDatabaseMode, createDatabasePool } from "../../src/database/connection";
import { resetFixtures } from "../../src/database/fixtures";
import { migrate } from "../../src/database/migrate";

export const testPool = () => {
  assertDatabaseMode("test");
  return createDatabasePool();
};

export const migrateTestDatabase = async (pool: Pool) => migrate({ pool });

export const resetTestFixtures = async (pool: Pool) => {
  assertDatabaseMode("test");
  await resetFixtures(pool);
};
