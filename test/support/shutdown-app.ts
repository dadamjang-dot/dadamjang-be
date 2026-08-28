import { createApp } from "src/app";
import { DatabasePool } from "src/database/connection";

const main = async () => {
  const app = await createApp();
  const pool = app.get(DatabasePool);
  const shutdown = pool.onApplicationShutdown;
  pool.onApplicationShutdown = async (signal?: string) => {
    process.stdout.write(`database-pool-shutdown:${signal}\n`);
    await shutdown();
  };
  await app.listen(0, "127.0.0.1");
  process.stdout.write("shutdown-ready\n");
};

void main();
