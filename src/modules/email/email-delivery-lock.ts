import { sql } from "drizzle-orm";
import type { DatabaseTransaction } from "src/modules/database/database.module";

const EMAIL_DELIVERY_LOCK_SEED = 7;

export const lockEmailDelivery = (transaction: DatabaseTransaction, email: string) =>
  transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${email}, ${EMAIL_DELIVERY_LOCK_SEED}))`);

export const tryLockEmailDelivery = async (transaction: DatabaseTransaction, email: string) => {
  const result = await transaction.execute<{ acquired: boolean }>(
    sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${email}, ${EMAIL_DELIVERY_LOCK_SEED})) AS "acquired"`,
  );
  return result.rows[0]?.acquired === true;
};
