import { Global, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

export const DRIZZLE = Symbol("DRIZZLE");
export type Database = ReturnType<typeof drizzle<typeof schema>>;

@Global()
@Module({
  providers: [
    {
      provide: DRIZZLE,
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const pool = new Pool({
          host: configService.get<string>("POSTGRES_HOST"),
          port: Number(configService.get<string>("POSTGRES_PORT")),
          user: configService.get<string>("POSTGRES_USERNAME"),
          password: configService.get<string>("POSTGRES_PASSWORD"),
          database: configService.get<string>("POSTGRES_DATABASE"),
        });

        return drizzle(pool, { schema });
      },
    },
  ],
  exports: [DRIZZLE],
})
export class DatabaseModule {}
