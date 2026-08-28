import { createApp } from "src/app";
import { DatabasePool } from "src/database/connection";

const main = async () => {
  const app = await createApp();
  const pool = app.get(DatabasePool);
  const end = pool.end.bind(pool);
  Object.defineProperty(pool, "end", {
    value: async () => {
      await end();
      process.stdout.write("database-pool-ended\n");
    },
  });
  await app.listen(0, "127.0.0.1");
  process.stdout.write("shutdown-ready\n");
};

void main();
