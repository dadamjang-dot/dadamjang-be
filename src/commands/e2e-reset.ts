import { assertDatabaseMode, createDatabasePool } from "src/database/connection";
import { resetFixtures, seedAdminFixtures } from "src/database/fixtures";

const main = async () => {
  assertDatabaseMode("e2e");
  const pool = createDatabasePool();
  try {
    await resetFixtures(pool);
    await seedAdminFixtures(pool);
    process.stdout.write("e2e fixtures reset\n");
  } finally {
    await pool.end();
  }
};

void main();
