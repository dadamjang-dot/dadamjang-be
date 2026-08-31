import { Inject, Injectable } from "@nestjs/common";
import { Database, DRIZZLE } from "src/modules/database/database.module";
import { accountReactivationTokens } from "src/modules/database/schema";

@Injectable()
export class FoAccountRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  insertReactivationToken = (input: typeof accountReactivationTokens.$inferInsert) =>
    this.db.insert(accountReactivationTokens).values(input);
}
