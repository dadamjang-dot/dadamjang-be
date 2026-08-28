import { Global, Injectable, Module } from "@nestjs/common";
import { drizzle } from "drizzle-orm/node-postgres";
import { createDatabasePool, DatabasePool } from "src/database/connection";
import * as schema from "./schema";

export const DRIZZLE = Symbol("DRIZZLE");
export type Database = ReturnType<typeof drizzle<typeof schema>>;

@Injectable()
export class DatabaseHealth {
  constructor(private readonly pool: DatabasePool) {}

  check = async () => {
    const query = { text: "SELECT 1", query_timeout: 3000 };
    await this.pool.query(query);
  };
}

@Global()
@Module({
  providers: [
    {
      provide: DatabasePool,
      useFactory: createDatabasePool,
    },
    DatabaseHealth,
    {
      provide: DRIZZLE,
      inject: [DatabasePool],
      useFactory: (pool: DatabasePool) => drizzle(pool, { schema }),
    },
  ],
  exports: [DRIZZLE, DatabaseHealth],
})
export class DatabaseModule {}
