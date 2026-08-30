import { createDatabasePool } from "../src/database/connection";
import { migrate } from "../src/database/migrate";

const main = async () => {
  const pool = createDatabasePool();
  try {
    await migrate({ pool });
  } finally {
    await pool.end();
  }
};

void main();
