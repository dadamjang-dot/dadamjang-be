import { migrateTestDatabase, resetTestFixtures, testPool } from "./database";

const globalSetup = async () => {
  const pool = testPool();
  try {
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await migrateTestDatabase(pool);
    await migrateTestDatabase(pool);
    await resetTestFixtures(pool);
  } finally {
    await pool.end();
  }
};

export default globalSetup;
