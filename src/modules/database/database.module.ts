import { Global, Module, OnApplicationShutdown } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

export const DRIZZLE = Symbol("DRIZZLE");
export type Database = ReturnType<typeof drizzle<typeof schema>>;

class DatabasePool extends Pool implements OnApplicationShutdown {
  onApplicationShutdown = async () => {
    await this.end();
  };
}

@Global()
@Module({
  providers: [
    {
      provide: DatabasePool,
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        return new DatabasePool({
          host: configService.get<string>("POSTGRES_HOST"),
          port: Number(configService.get<string>("POSTGRES_PORT")),
          user: configService.get<string>("POSTGRES_USERNAME"),
          password: configService.get<string>("POSTGRES_PASSWORD"),
          database: configService.get<string>("POSTGRES_DATABASE"),
        });
      },
    },
    {
      provide: DRIZZLE,
      inject: [DatabasePool],
      useFactory: (pool: DatabasePool) => drizzle(pool, { schema }),
    },
  ],
  exports: [DRIZZLE],
})
export class DatabaseModule {}
