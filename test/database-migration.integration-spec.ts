import { createHash } from "crypto";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { Pool, type PoolClient } from "pg";
import { createDatabasePool } from "src/database/connection";
import { migrate } from "src/database/migrate";
import { testPool } from "./support/database";

const DATABASE_NAME = "catalog_migration_safety_test";
const RETIRED_DEMO_MIGRATION = {
  name: "0005_catalog_demo_products.sql",
  checksum: "44d98c294ac8c2afa502f7bdb2c65411df7d4879dad39cd5b4fbc8cf9c94059f",
} as const;
const HISTORICAL_MIGRATIONS = [
  "0000_initial_schema.sql",
  "0001_commerce_domain.sql",
  "0002_style_posts_partner.sql",
  "0003_rename_wishlists.sql",
  "0004_catalog_filters.sql",
  RETIRED_DEMO_MIGRATION.name,
] as const;

type MigrationArtifact = {
  readonly checksum: string;
  readonly name: string;
  readonly retired: boolean;
};

type PostgreSqlConstraintError = {
  readonly code?: string;
  readonly constraint?: string;
};

const databasePool = (database: string) => createDatabasePool({ ...process.env, POSTGRES_DATABASE: database });

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

const readMigrationArtifacts = async (rootDirectory = process.cwd()): Promise<MigrationArtifact[]> => {
  const artifacts = (
    await Promise.all(
      [
        { directory: "migrations", retired: false },
        { directory: "retired-migrations", retired: true },
      ].map(async ({ directory, retired }) =>
        Promise.all(
          (await fs.readdir(path.join(rootDirectory, directory)))
            .filter((name) => name.endsWith(".sql"))
            .map(async (name) => ({
              checksum: sha256(await fs.readFile(path.join(rootDirectory, directory, name), "utf8")),
              name,
              retired,
            })),
        ),
      ),
    )
  ).flat();
  return artifacts.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
};

const historicalMigrationPath = (name: string) =>
  path.join(process.cwd(), name === RETIRED_DEMO_MIGRATION.name ? "retired-migrations" : "migrations", name);

const runHistoricalMigrations = async (
  pool: Pool,
  beforeMigration?: (name: string, pool: Pool) => Promise<void>,
  migrations: readonly string[] = HISTORICAL_MIGRATIONS,
) => {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS "_migrations" (
        "name" text PRIMARY KEY,
        "checksum" text NOT NULL,
        "appliedAt" timestamp NOT NULL DEFAULT now()
      )
    `);
    for (const name of migrations) {
      const migrationSql = await fs.readFile(historicalMigrationPath(name), "utf8");
      const checksum = sha256(migrationSql);
      const applied = await client.query<{ checksum: string }>(
        'SELECT "checksum" FROM "_migrations" WHERE "name" = $1',
        [name],
      );
      if (applied.rowCount) {
        if (applied.rows[0]?.checksum !== checksum) throw new Error(`migration checksum changed: ${name}`);
        continue;
      }
      await beforeMigration?.(name, pool);
      await client.query("BEGIN");
      try {
        await client.query(migrationSql);
        await client.query('INSERT INTO "_migrations" ("name", "checksum") VALUES ($1, $2)', [name, checksum]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    client.release();
  }
};

const seedHistoricalMigration = async (pool: Pool) => {
  await pool.query(
    `INSERT INTO "users" ("userId", "userid", "email", "password") VALUES ('10000000-0000-4000-8000-000000000001', 'migration-user', 'migration@example.test', 'x')`,
  );
  const category = await pool.query<{ categoryId: string }>(
    `SELECT "categoryId" FROM "categories" WHERE "slug" = 'tops'`,
  );
  await pool.query(
    `INSERT INTO "partners" ("partnerId", "ownerUserId", "businessEmail", "businessRegistrationNumber", "tradeName", "status") VALUES ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'migration-partner@example.test', '9999999999', 'Migration Partner', 'APPROVED')`,
  );
  await pool.query(
    `INSERT INTO "products" ("productId", "partnerId", "categoryId", "title", "description", "status", "approvalStatus", "publishedAt") VALUES ('70000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', $1, 'Migration Source Product', 'source', 'PUBLISHED', 'APPROVED', now())`,
    [category.rows[0]?.categoryId],
  );
};

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const closePool = async (pool: Pool) => {
  const openClients = pool.totalCount;
  if (!openClients) {
    await pool.end();
    return;
  }
  let removedClients = 0;
  let resolveClosed: () => void = () => undefined;
  const clientsClosed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const handleRemove = () => {
    removedClients += 1;
    if (removedClients === openClients) resolveClosed();
  };
  pool.on("remove", handleRemove);
  try {
    await pool.end();
    await clientsClosed;
  } finally {
    pool.off("remove", handleRemove);
  }
};

const waitForAdvisoryLock = async (pool: Pool) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const waiting = await pool.query<{ count: string }>(
      `SELECT count(*)
       FROM pg_stat_activity
       WHERE pid <> pg_backend_pid()
         AND state = 'active'
         AND query LIKE 'SELECT pg_advisory_lock%'
         AND wait_event IS NOT NULL`,
    );
    if (waiting.rows[0]?.count !== "0") return true;
    await wait(10);
  }
  return false;
};

const expectConstraintError = async (operation: () => Promise<unknown>, code: string, constraint: string) => {
  const outcome = await operation().then(
    () => ({ status: "fulfilled" as const }),
    (error: PostgreSqlConstraintError) => ({
      code: error.code,
      constraint: error.constraint,
      status: "rejected" as const,
    }),
  );
  expect(outcome).toEqual({ code, constraint, status: "rejected" });
};

describe("database migration PostgreSQL integration", () => {
  let adminPool: Pool;
  let migrationPool: Pool;

  beforeEach(async () => {
    adminPool = testPool();
    await adminPool.query(`DROP DATABASE IF EXISTS "${DATABASE_NAME}" WITH (FORCE)`);
    await adminPool.query(`CREATE DATABASE "${DATABASE_NAME}"`);
    migrationPool = databasePool(DATABASE_NAME);
  });

  afterEach(async () => {
    await closePool(migrationPool);
    await adminPool.query(`DROP DATABASE IF EXISTS "${DATABASE_NAME}"`);
    await adminPool.end();
  });

  it("migrates a truly empty database without temporary catalog data", async () => {
    await migrate({ pool: migrationPool });

    const catalog = await migrationPool.query<{ products: string; skus: string }>(
      `SELECT
         (SELECT count(*) FROM "products") AS products,
         (SELECT count(*) FROM "productSkus") AS skus`,
    );
    const extensions = await migrationPool.query<{ extname: string }>(
      `SELECT extname FROM pg_extension WHERE extname = 'pgcrypto'`,
    );
    const callbackTokenColumns = await migrationPool.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name IN ('kakaoLoginFlows', 'identityVerificationSessions')
         AND column_name = 'callbackTokenHash'
       ORDER BY table_name`,
    );
    const refreshRotationColumns = await migrationPool.query<{
      column_name: string;
      is_nullable: string;
      table_name: string;
    }>(
      `SELECT table_name, column_name, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND (
           (table_name = 'refreshToken' AND column_name IN ('lastRotationKey', 'lastRotationExpiresAt'))
           OR (table_name = 'refreshTokenRotationMarker' AND column_name IN ('userId', 'deviceId', 'rotationKey', 'expiresAt'))
         )
       ORDER BY table_name, column_name`,
    );
    const refreshRotationForeignKey = await migrationPool.query<{ delete_rule: string }>(
      `SELECT rc.delete_rule
       FROM information_schema.referential_constraints rc
       WHERE rc.constraint_schema = 'public'
         AND rc.constraint_name = 'refresh_token_rotation_marker_session_fk'`,
    );

    expect(catalog.rows).toEqual([{ products: "0", skus: "0" }]);
    expect(extensions.rows).toEqual([{ extname: "pgcrypto" }]);
    expect(callbackTokenColumns.rows).toEqual([
      { column_name: "callbackTokenHash", is_nullable: "YES" },
      { column_name: "callbackTokenHash", is_nullable: "YES" },
    ]);
    expect(refreshRotationColumns.rows).toEqual([
      { column_name: "deviceId", is_nullable: "NO", table_name: "refreshTokenRotationMarker" },
      { column_name: "expiresAt", is_nullable: "NO", table_name: "refreshTokenRotationMarker" },
      { column_name: "rotationKey", is_nullable: "NO", table_name: "refreshTokenRotationMarker" },
      { column_name: "userId", is_nullable: "NO", table_name: "refreshTokenRotationMarker" },
    ]);
    expect(refreshRotationForeignKey.rows).toEqual([{ delete_rule: "CASCADE" }]);
  });

  it("migrates FO accounts to nullable passwords and enforces lifecycle invariants once", async () => {
    const migrationsBeforeAccountLifecycle = (await readMigrationArtifacts())
      .filter(({ name, retired }) => !retired && name < "0025_fo_account_lifecycle.sql")
      .map(({ name }) => name);
    await runHistoricalMigrations(migrationPool, undefined, migrationsBeforeAccountLifecycle);
    const kakaoOnlyPasswordHash = "kakao-only-synthetic-password";
    const emailPasswordHash = "email-password-hash";
    const kakaoOnlyClient = await migrationPool.connect();
    try {
      await kakaoOnlyClient.query("BEGIN");
      await kakaoOnlyClient.query(
        `INSERT INTO "users" ("userId", "userid", "email", "password")
         VALUES ('10000000-0000-4000-8000-000000000025', 'kakao-only-migration', 'kakao-only@example.test', $1)`,
        [kakaoOnlyPasswordHash],
      );
      await kakaoOnlyClient.query(
        `INSERT INTO "authIdentity" ("userId", "provider", "providerUserId")
         VALUES ('10000000-0000-4000-8000-000000000025', 'kakao', 'kakao-only-migration')`,
      );
      await kakaoOnlyClient.query("COMMIT");
    } catch (error) {
      await kakaoOnlyClient.query("ROLLBACK");
      throw error;
    } finally {
      kakaoOnlyClient.release();
    }
    await migrationPool.query(
      `INSERT INTO "users" ("userId", "userid", "email", "password", "createdAt", "updatedAt")
       VALUES (
         '10000000-0000-4000-8000-000000000026',
         'linked-email-migration',
         'linked-email@example.test',
         $1,
         '2026-01-01T00:00:00Z',
         '2026-01-01T00:00:00Z'
       )`,
      [emailPasswordHash],
    );
    await migrationPool.query(
      `INSERT INTO "authIdentity" ("userId", "provider", "providerUserId", "createdAt")
       VALUES (
         '10000000-0000-4000-8000-000000000026',
         'kakao',
         'linked-email-migration',
         '2026-01-02T00:00:00Z'
       )`,
    );
    await migrationPool.query(
      `INSERT INTO "users" ("userId", "userid", "email", "password", "role")
       VALUES (
         '10000000-0000-4000-8000-000000000027',
         'partner-migration',
         'partner@example.test',
         'partner-password-hash',
         'PARTNER'
       )`,
    );

    await migrate({ pool: migrationPool });
    await migrate({ pool: migrationPool });

    const migratedUsers = await migrationPool.query<{ password: string | null; userId: string }>(
      `SELECT "userId", "password"
       FROM "users"
       WHERE "userId" IN (
         '10000000-0000-4000-8000-000000000025',
         '10000000-0000-4000-8000-000000000026',
         '10000000-0000-4000-8000-000000000027'
       )
       ORDER BY "userId"`,
    );
    const [kakaoOnly, linkedEmail, nonUser] = migratedUsers.rows;
    expect(kakaoOnly?.password).toBeNull();
    expect(linkedEmail?.password).toBe(emailPasswordHash);
    expect(nonUser?.password).toBe("partner-password-hash");

    await expect(
      migrationPool.query(
        `INSERT INTO "users" ("userId", "userid", "email", "password")
         VALUES ('10000000-0000-4000-8000-000000000028', 'passwordless-user', 'passwordless@example.test', NULL)`,
      ),
    ).resolves.toEqual(expect.objectContaining({ rowCount: 1 }));
    const insertNonUserWithoutPassword = () =>
      migrationPool.query(
        `INSERT INTO "users" ("userId", "userid", "email", "password", "role")
         VALUES ('10000000-0000-4000-8000-000000000029', 'passwordless-admin', 'passwordless-admin@example.test', NULL, 'ADMIN')`,
      );
    await expect(insertNonUserWithoutPassword()).rejects.toThrow();

    await expect(
      migrationPool.query(
        `UPDATE "users"
         SET "scheduledAnonymizationAt" = now() + interval '30 days'
         WHERE "userId" = '10000000-0000-4000-8000-000000000028'`,
      ),
    ).rejects.toThrow();
    await expect(
      migrationPool.query(
        `UPDATE "users"
         SET "deactivatedAt" = now()
         WHERE "userId" = '10000000-0000-4000-8000-000000000028'`,
      ),
    ).rejects.toThrow();
    await expect(
      migrationPool.query(
        `UPDATE "users"
         SET "deactivatedAt" = now(), "scheduledAnonymizationAt" = now() - interval '1 second'
         WHERE "userId" = '10000000-0000-4000-8000-000000000028'`,
      ),
    ).rejects.toThrow();
    await expect(
      migrationPool.query(
        `UPDATE "users"
         SET
           "deactivatedAt" = now(),
           "scheduledAnonymizationAt" = now() + interval '30 days',
           "anonymizedAt" = now() + interval '29 days'
         WHERE "userId" = '10000000-0000-4000-8000-000000000028'`,
      ),
    ).rejects.toThrow();
    await expect(
      migrationPool.query(
        `UPDATE "users"
         SET "deactivatedAt" = now(), "scheduledAnonymizationAt" = now() + interval '30 days'
         WHERE "userId" = '10000000-0000-4000-8000-000000000028'`,
      ),
    ).resolves.toEqual(expect.objectContaining({ rowCount: 1 }));
    await expect(
      migrationPool.query(
        `UPDATE "users"
         SET "anonymizedAt" = "scheduledAnonymizationAt" + interval '1 second'
         WHERE "userId" = '10000000-0000-4000-8000-000000000028'`,
      ),
    ).resolves.toEqual(expect.objectContaining({ rowCount: 1 }));

    await migrationPool.query(
      `INSERT INTO "accountReactivationTokens"
        ("tokenHash", "userId", "deviceIdHash", "expiresAt")
       VALUES (
         'reactivation-token-hash',
         '10000000-0000-4000-8000-000000000028',
         'device-id-hash',
         now() + interval '10 minutes'
       )`,
    );
    await expect(
      migrationPool.query(
        `INSERT INTO "accountReactivationTokens"
          ("tokenHash", "userId", "deviceIdHash", "expiresAt")
         VALUES (
           'reactivation-token-hash',
           '10000000-0000-4000-8000-000000000027',
           'other-device-id-hash',
           now() + interval '10 minutes'
         )`,
      ),
    ).rejects.toThrow();
    await migrationPool.query(`DELETE FROM "users" WHERE "userId" = '10000000-0000-4000-8000-000000000028'`);
    const reactivationTokens = await migrationPool.query<{ count: string }>(
      `SELECT count(*) FROM "accountReactivationTokens" WHERE "tokenHash" = 'reactivation-token-hash'`,
    );
    const dueIndex = await migrationPool.query<{ indexdef: string }>(
      `SELECT indexdef
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename = 'users'
         AND indexname = 'users_due_anonymization_idx'`,
    );
    const lifecycleMigrationJournal = await migrationPool.query<{ count: string }>(
      `SELECT count(*) FROM "_migrations" WHERE "name" = '0025_fo_account_lifecycle.sql'`,
    );

    expect(reactivationTokens.rows).toEqual([{ count: "0" }]);
    expect(dueIndex.rows).toEqual([
      {
        indexdef:
          'CREATE INDEX users_due_anonymization_idx ON public.users USING btree ("scheduledAnonymizationAt", "userId") WHERE (("deactivatedAt" IS NOT NULL) AND ("anonymizedAt" IS NULL))',
      },
    ]);
    expect(lifecycleMigrationJournal.rows).toEqual([{ count: "1" }]);
  });

  it("adds the notification schema without changing existing commerce rows and applies it once", async () => {
    const migrationsBeforeNotifications = (await readMigrationArtifacts())
      .filter(({ name, retired }) => !retired && name < "0026_notifications_push_outbox.sql")
      .map(({ name }) => name);
    await runHistoricalMigrations(migrationPool, undefined, migrationsBeforeNotifications);
    await seedHistoricalMigration(migrationPool);
    await migrationPool.query(
      `INSERT INTO "productSkus"
        ("skuId", "productId", "code", "optionName", "price", "stock", "position")
       VALUES (
         '71000000-0000-4000-8000-000000000026',
         '70000000-0000-4000-8000-000000000001',
         'NOTIFICATION-MIGRATION-SKU',
         'Migration SKU',
         15000,
         3,
         0
       )`,
    );
    await migrationPool.query(
      `INSERT INTO "wishes" ("wishId", "userId", "productId")
       VALUES (
         '72000000-0000-4000-8000-000000000026',
         '10000000-0000-4000-8000-000000000001',
         '70000000-0000-4000-8000-000000000001'
       )`,
    );
    await migrationPool.query(
      `INSERT INTO "orders"
        ("orderId", "orderNumber", "userId", "status", "paymentStatus", "totalAmount")
       VALUES (
         '73000000-0000-4000-8000-000000000026',
         'NOTIFICATION-MIGRATION-ORDER',
         '10000000-0000-4000-8000-000000000001',
         'PAID',
         'APPROVED',
         15000
       )`,
    );
    await migrationPool.query(
      `INSERT INTO "orderItems"
        ("orderItemId", "orderId", "productId", "skuId", "productTitle", "skuOptionName", "unitPrice", "quantity")
       VALUES (
         '74000000-0000-4000-8000-000000000026',
         '73000000-0000-4000-8000-000000000026',
         '70000000-0000-4000-8000-000000000001',
         '71000000-0000-4000-8000-000000000026',
         'Migration Source Product',
         'Migration SKU',
         15000,
         1
       )`,
    );
    const commerceBefore = await migrationPool.query<{
      orderItems: string;
      orders: string;
      products: string;
      skus: string;
      users: string;
      wishes: string;
    }>(
      `SELECT
         (SELECT string_agg("userId"::text, ',' ORDER BY "userId") FROM "users") AS users,
         (SELECT string_agg("productId"::text, ',' ORDER BY "productId") FROM "products") AS products,
         (SELECT string_agg("skuId"::text, ',' ORDER BY "skuId") FROM "productSkus") AS skus,
         (SELECT string_agg("wishId"::text, ',' ORDER BY "wishId") FROM "wishes") AS wishes,
         (SELECT string_agg("orderId"::text, ',' ORDER BY "orderId") FROM "orders") AS orders,
         (SELECT string_agg("orderItemId"::text, ',' ORDER BY "orderItemId") FROM "orderItems") AS "orderItems"`,
    );

    await migrate({ pool: migrationPool });
    await migrate({ pool: migrationPool });

    const commerceAfter = await migrationPool.query<{
      orderItems: string;
      orders: string;
      products: string;
      skus: string;
      users: string;
      wishes: string;
    }>(
      `SELECT
         (SELECT string_agg("userId"::text, ',' ORDER BY "userId") FROM "users") AS users,
         (SELECT string_agg("productId"::text, ',' ORDER BY "productId") FROM "products") AS products,
         (SELECT string_agg("skuId"::text, ',' ORDER BY "skuId") FROM "productSkus") AS skus,
         (SELECT string_agg("wishId"::text, ',' ORDER BY "wishId") FROM "wishes") AS wishes,
         (SELECT string_agg("orderId"::text, ',' ORDER BY "orderId") FROM "orders") AS orders,
         (SELECT string_agg("orderItemId"::text, ',' ORDER BY "orderItemId") FROM "orderItems") AS "orderItems"`,
    );
    const tables = await migrationPool.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('notifications', 'pushDevices', 'notificationPreferences', 'pushOutbox')
       ORDER BY table_name`,
    );
    const varcharStateColumns = await migrationPool.query<{
      column_name: string;
      data_type: string;
      table_name: string;
    }>(
      `SELECT table_name, column_name, data_type
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND (
           (table_name = 'notifications' AND column_name = 'type')
           OR (table_name = 'pushDevices' AND column_name = 'platform')
           OR (table_name = 'pushOutbox' AND column_name = 'status')
         )
       ORDER BY table_name, column_name`,
    );
    const timestampColumns = await migrationPool.query<{
      column_name: string;
      data_type: string;
      table_name: string;
    }>(
      `SELECT table_name, column_name, data_type
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name IN ('notifications', 'pushDevices', 'notificationPreferences', 'pushOutbox')
         AND data_type LIKE 'timestamp%'
       ORDER BY table_name, column_name`,
    );
    const defaults = await migrationPool.query<{
      column_default: string;
      column_name: string;
      table_name: string;
    }>(
      `SELECT table_name, column_name, column_default
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name IN ('notifications', 'pushDevices', 'notificationPreferences', 'pushOutbox')
         AND column_default IS NOT NULL
       ORDER BY table_name, column_name`,
    );
    const foreignKeys = await migrationPool.query<{
      constraint_name: string;
      delete_rule: string;
    }>(
      `SELECT tc.constraint_name, rc.delete_rule
       FROM information_schema.table_constraints tc
       JOIN information_schema.referential_constraints rc
         ON rc.constraint_schema = tc.constraint_schema
        AND rc.constraint_name = tc.constraint_name
       WHERE tc.constraint_schema = 'public'
         AND tc.table_name IN ('notifications', 'pushDevices', 'notificationPreferences', 'pushOutbox')
         AND tc.constraint_type = 'FOREIGN KEY'
       ORDER BY tc.constraint_name`,
    );
    const checks = await migrationPool.query<{ constraint_name: string; definition: string }>(
      `SELECT conname AS constraint_name, pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE connamespace = 'public'::regnamespace
         AND conname IN (
           'notifications_type_check',
           'push_devices_platform_check',
           'push_devices_disable_check',
           'push_outbox_status_check',
           'push_outbox_attempt_count_check',
           'push_outbox_claim_check',
           'push_outbox_rate_limit_attempt_count_check',
           'push_outbox_ticket_pair_check',
           'push_outbox_ticket_state_check'
         )
       ORDER BY conname`,
    );
    const indexes = await migrationPool.query<{ indexdef: string; indexname: string; predicate: string | null }>(
      `SELECT
         index_class.relname AS indexname,
         pg_get_indexdef(index_class.oid) AS indexdef,
         pg_get_expr(indexes.indpred, indexes.indrelid) AS predicate
       FROM pg_index indexes
       JOIN pg_class index_class ON index_class.oid = indexes.indexrelid
       WHERE index_class.relname IN (
         'notifications_user_created_idx',
         'notifications_user_unread_idx',
         'push_devices_user_state_idx',
         'push_outbox_pending_idx',
         'push_outbox_ticketed_receipt_idx',
         'push_outbox_processing_idx',
         'push_outbox_terminal_updated_idx',
         'push_outbox_device_status_idx'
       )
       ORDER BY index_class.relname`,
    );
    const notificationMigrationJournal = await migrationPool.query<{ count: string }>(
      `SELECT count(*) FROM "_migrations" WHERE "name" = '0026_notifications_push_outbox.sql'`,
    );
    const pushRateLimitMigrationJournal = await migrationPool.query<{ count: string }>(
      `SELECT count(*) FROM "_migrations" WHERE "name" = '0028_push_rate_limit_attempts.sql'`,
    );

    expect(commerceAfter.rows).toEqual(commerceBefore.rows);
    expect(tables.rows).toEqual([
      { table_name: "notificationPreferences" },
      { table_name: "notifications" },
      { table_name: "pushDevices" },
      { table_name: "pushOutbox" },
    ]);
    expect(varcharStateColumns.rows).toEqual([
      { column_name: "type", data_type: "character varying", table_name: "notifications" },
      { column_name: "platform", data_type: "character varying", table_name: "pushDevices" },
      { column_name: "status", data_type: "character varying", table_name: "pushOutbox" },
    ]);
    expect(timestampColumns.rows).toEqual([
      { column_name: "updatedAt", data_type: "timestamp with time zone", table_name: "notificationPreferences" },
      { column_name: "createdAt", data_type: "timestamp with time zone", table_name: "notifications" },
      { column_name: "readAt", data_type: "timestamp with time zone", table_name: "notifications" },
      { column_name: "createdAt", data_type: "timestamp with time zone", table_name: "pushDevices" },
      { column_name: "disabledAt", data_type: "timestamp with time zone", table_name: "pushDevices" },
      { column_name: "lastSeenAt", data_type: "timestamp with time zone", table_name: "pushDevices" },
      { column_name: "updatedAt", data_type: "timestamp with time zone", table_name: "pushDevices" },
      { column_name: "availableAt", data_type: "timestamp with time zone", table_name: "pushOutbox" },
      { column_name: "claimedAt", data_type: "timestamp with time zone", table_name: "pushOutbox" },
      { column_name: "createdAt", data_type: "timestamp with time zone", table_name: "pushOutbox" },
      { column_name: "receiptAvailableAt", data_type: "timestamp with time zone", table_name: "pushOutbox" },
      { column_name: "updatedAt", data_type: "timestamp with time zone", table_name: "pushOutbox" },
    ]);
    expect(defaults.rows).toEqual([
      { column_default: "true", column_name: "orderPushEnabled", table_name: "notificationPreferences" },
      { column_default: "true", column_name: "pushEnabled", table_name: "notificationPreferences" },
      { column_default: "true", column_name: "stylePushEnabled", table_name: "notificationPreferences" },
      { column_default: "now()", column_name: "updatedAt", table_name: "notificationPreferences" },
      { column_default: "true", column_name: "wishPushEnabled", table_name: "notificationPreferences" },
      { column_default: "now()", column_name: "createdAt", table_name: "notifications" },
      { column_default: "gen_random_uuid()", column_name: "notificationId", table_name: "notifications" },
      { column_default: "now()", column_name: "createdAt", table_name: "pushDevices" },
      { column_default: "now()", column_name: "lastSeenAt", table_name: "pushDevices" },
      { column_default: "gen_random_uuid()", column_name: "pushDeviceId", table_name: "pushDevices" },
      { column_default: "now()", column_name: "updatedAt", table_name: "pushDevices" },
      { column_default: "0", column_name: "attemptCount", table_name: "pushOutbox" },
      { column_default: "now()", column_name: "availableAt", table_name: "pushOutbox" },
      { column_default: "now()", column_name: "createdAt", table_name: "pushOutbox" },
      { column_default: "gen_random_uuid()", column_name: "pushOutboxId", table_name: "pushOutbox" },
      { column_default: "0", column_name: "rateLimitAttemptCount", table_name: "pushOutbox" },
      { column_default: "'PENDING'::character varying", column_name: "status", table_name: "pushOutbox" },
      { column_default: "now()", column_name: "updatedAt", table_name: "pushOutbox" },
    ]);
    expect(foreignKeys.rows).toEqual([
      { constraint_name: "notification_preferences_user_fk", delete_rule: "NO ACTION" },
      { constraint_name: "notifications_user_fk", delete_rule: "NO ACTION" },
      { constraint_name: "push_devices_user_fk", delete_rule: "NO ACTION" },
      { constraint_name: "push_outbox_device_fk", delete_rule: "CASCADE" },
      { constraint_name: "push_outbox_notification_fk", delete_rule: "CASCADE" },
    ]);
    expect(checks.rows.map(({ constraint_name }) => constraint_name)).toEqual([
      "notifications_type_check",
      "push_devices_disable_check",
      "push_devices_platform_check",
      "push_outbox_attempt_count_check",
      "push_outbox_claim_check",
      "push_outbox_rate_limit_attempt_count_check",
      "push_outbox_status_check",
      "push_outbox_ticket_pair_check",
      "push_outbox_ticket_state_check",
    ]);
    const checkDefinitions = Object.fromEntries(
      checks.rows.map(({ constraint_name, definition }) => [constraint_name, definition]),
    );
    expect(checkDefinitions.notifications_type_check).toContain("ORDER_STATUS");
    expect(checkDefinitions.notifications_type_check).toContain("WISH_PRICE_DROP");
    expect(checkDefinitions.notifications_type_check).toContain("WISH_RESTOCK");
    expect(checkDefinitions.notifications_type_check).toContain("STYLE_LIKE");
    expect(checkDefinitions.push_devices_platform_check).toContain("IOS");
    expect(checkDefinitions.push_devices_platform_check).toContain("ANDROID");
    expect(checkDefinitions.push_devices_disable_check).toContain("disabledReason");
    expect(checkDefinitions.push_outbox_status_check).toContain("RECEIPT_OK");
    expect(checkDefinitions.push_outbox_attempt_count_check).toContain('"attemptCount" >= 0');
    expect(checkDefinitions.push_outbox_claim_check).toContain("PROCESSING");
    expect(checkDefinitions.push_outbox_rate_limit_attempt_count_check).toContain('"rateLimitAttemptCount"');
    expect(checkDefinitions.push_outbox_rate_limit_attempt_count_check).toContain(">= 0");
    expect(checkDefinitions.push_outbox_rate_limit_attempt_count_check).toContain("<= 8");
    expect(checkDefinitions.push_outbox_ticket_pair_check).toContain("receiptAvailableAt");
    expect(checkDefinitions.push_outbox_ticket_state_check).toContain("TICKETED");
    expect(indexes.rows.map(({ indexname }) => indexname)).toEqual([
      "notifications_user_created_idx",
      "notifications_user_unread_idx",
      "push_devices_user_state_idx",
      "push_outbox_device_status_idx",
      "push_outbox_pending_idx",
      "push_outbox_processing_idx",
      "push_outbox_terminal_updated_idx",
      "push_outbox_ticketed_receipt_idx",
    ]);
    const indexByName = Object.fromEntries(indexes.rows.map((index) => [index.indexname, index]));
    expect(indexByName.notifications_user_created_idx?.indexdef).toContain(
      '("userId", "createdAt" DESC, "notificationId" DESC)',
    );
    expect(indexByName.notifications_user_created_idx?.predicate).toBeNull();
    expect(indexByName.notifications_user_unread_idx?.indexdef).toContain(
      '("userId", "createdAt" DESC, "notificationId" DESC)',
    );
    expect(indexByName.notifications_user_unread_idx?.predicate).toContain('"readAt" IS NULL');
    expect(indexByName.push_devices_user_state_idx?.indexdef).toContain('("userId", "disabledAt", "pushDeviceId")');
    expect(indexByName.push_devices_user_state_idx?.predicate).toBeNull();
    expect(indexByName.push_outbox_device_status_idx?.indexdef).toContain('("pushDeviceId", status, "pushOutboxId")');
    expect(indexByName.push_outbox_device_status_idx?.predicate).toBeNull();
    expect(indexByName.push_outbox_pending_idx?.indexdef).toContain('("availableAt", "createdAt", "pushOutboxId")');
    expect(indexByName.push_outbox_pending_idx?.predicate).toContain("PENDING");
    expect(indexByName.push_outbox_ticketed_receipt_idx?.indexdef).toContain(
      '("receiptAvailableAt", "createdAt", "pushOutboxId")',
    );
    expect(indexByName.push_outbox_ticketed_receipt_idx?.predicate).toContain("TICKETED");
    expect(indexByName.push_outbox_processing_idx?.indexdef).toContain('("claimedAt", "createdAt", "pushOutboxId")');
    expect(indexByName.push_outbox_processing_idx?.predicate).toContain("PROCESSING");
    expect(indexByName.push_outbox_terminal_updated_idx?.indexdef).toContain('("updatedAt", "pushOutboxId")');
    expect(indexByName.push_outbox_terminal_updated_idx?.predicate).toContain("RECEIPT_OK");
    expect(indexByName.push_outbox_terminal_updated_idx?.predicate).toContain("FAILED");
    expect(notificationMigrationJournal.rows).toEqual([{ count: "1" }]);
    expect(pushRateLimitMigrationJournal.rows).toEqual([{ count: "1" }]);
  });

  it("enforces notification uniqueness, ownership, state matrices, and cascades", async () => {
    await migrate({ pool: migrationPool });
    const userA = "10000000-0000-4000-8000-000000000126";
    const userB = "10000000-0000-4000-8000-000000000226";
    const missingUser = "10000000-0000-4000-8000-000000000326";
    await migrationPool.query(
      `INSERT INTO "users" ("userId", "userid", "email", "password")
       VALUES
         ($1, 'notification-user-a', 'notification-user-a@example.test', 'x'),
         ($2, 'notification-user-b', 'notification-user-b@example.test', 'x')`,
      [userA, userB],
    );
    const notificationA = "81000000-0000-4000-8000-000000000126";
    const notificationB = "81000000-0000-4000-8000-000000000226";
    const notificationC = "81000000-0000-4000-8000-000000000326";
    const notificationD = "81000000-0000-4000-8000-000000000426";
    await migrationPool.query(
      `INSERT INTO "notifications"
        ("notificationId", "userId", "type", "title", "body", "route", "entityId", "dedupeKey")
       VALUES
         ($1, $5, 'ORDER_STATUS', 'Order', 'Order body', '/order/1', '91000000-0000-4000-8000-000000000126', 'same-dedupe'),
         ($2, $6, 'WISH_PRICE_DROP', 'Price', 'Price body', '/product/1', '91000000-0000-4000-8000-000000000226', 'same-dedupe'),
         ($3, $5, 'WISH_RESTOCK', 'Stock', 'Stock body', '/product/2', '91000000-0000-4000-8000-000000000326', 'stock-dedupe'),
         ($4, $5, 'STYLE_LIKE', 'Like', 'Like body', '/style/1', '91000000-0000-4000-8000-000000000426', 'style-dedupe')`,
      [notificationA, notificationB, notificationC, notificationD, userA, userB],
    );
    await expectConstraintError(
      () =>
        migrationPool.query(
          `INSERT INTO "notifications"
            ("notificationId", "userId", "type", "title", "body", "route", "entityId", "dedupeKey")
           VALUES (
             '81000000-0000-4000-8000-000000000526',
             $1,
             'ORDER_STATUS',
             'Duplicate',
             'Duplicate body',
             '/order/2',
             '91000000-0000-4000-8000-000000000526',
             'same-dedupe'
           )`,
          [userA],
        ),
      "23505",
      "notifications_user_dedupe_unique",
    );
    await expectConstraintError(
      () =>
        migrationPool.query(
          `INSERT INTO "notifications"
            ("notificationId", "userId", "type", "title", "body", "route", "entityId", "dedupeKey")
           VALUES (
             '81000000-0000-4000-8000-000000000626',
             $1,
             'PROMOTION',
             'Invalid',
             'Invalid body',
             '/product/3',
             '91000000-0000-4000-8000-000000000626',
             'invalid-type'
           )`,
          [userA],
        ),
      "23514",
      "notifications_type_check",
    );
    await expectConstraintError(
      () =>
        migrationPool.query(
          `INSERT INTO "notifications"
            ("notificationId", "userId", "type", "title", "body", "route", "entityId", "dedupeKey")
           VALUES (
             '81000000-0000-4000-8000-000000000726',
             $1,
             'ORDER_STATUS',
             'Missing user',
             'Missing user body',
             '/order/3',
             '91000000-0000-4000-8000-000000000726',
             'missing-user'
           )`,
          [missingUser],
        ),
      "23503",
      "notifications_user_fk",
    );

    const deviceA = "82000000-0000-4000-8000-000000000126";
    const deviceB = "82000000-0000-4000-8000-000000000226";
    await migrationPool.query(
      `INSERT INTO "pushDevices"
        ("pushDeviceId", "userId", "installationId", "expoPushToken", "platform")
       VALUES
         ($1, $3, 'installation-a', 'ExponentPushToken[device-a]', 'IOS'),
         ($2, $4, 'installation-b', 'ExponentPushToken[device-b]', 'ANDROID')`,
      [deviceA, deviceB, userA, userB],
    );
    await expectConstraintError(
      () =>
        migrationPool.query(
          `INSERT INTO "pushDevices"
            ("pushDeviceId", "userId", "installationId", "expoPushToken", "platform")
           VALUES (
             '82000000-0000-4000-8000-000000000326',
             $1,
             'installation-a',
             'ExponentPushToken[device-c]',
             'IOS'
           )`,
          [userB],
        ),
      "23505",
      "push_devices_installation_unique",
    );
    await expectConstraintError(
      () =>
        migrationPool.query(
          `INSERT INTO "pushDevices"
            ("pushDeviceId", "userId", "installationId", "expoPushToken", "platform")
           VALUES (
             '82000000-0000-4000-8000-000000000426',
             $1,
             'installation-d',
             'ExponentPushToken[device-a]',
             'ANDROID'
           )`,
          [userB],
        ),
      "23505",
      "push_devices_expo_token_unique",
    );
    await expectConstraintError(
      () =>
        migrationPool.query(
          `INSERT INTO "pushDevices"
            ("pushDeviceId", "userId", "installationId", "expoPushToken", "platform")
           VALUES (
             '82000000-0000-4000-8000-000000000526',
             $1,
             'installation-web',
             'ExponentPushToken[device-web]',
             'WEB'
           )`,
          [userA],
        ),
      "23514",
      "push_devices_platform_check",
    );
    await expectConstraintError(
      () =>
        migrationPool.query(
          `INSERT INTO "pushDevices"
            ("pushDeviceId", "userId", "installationId", "expoPushToken", "platform", "disabledAt")
           VALUES (
             '82000000-0000-4000-8000-000000000626',
             $1,
             'installation-disabled-at',
             'ExponentPushToken[device-disabled-at]',
             'IOS',
             now()
           )`,
          [userA],
        ),
      "23514",
      "push_devices_disable_check",
    );
    await expectConstraintError(
      () =>
        migrationPool.query(
          `INSERT INTO "pushDevices"
            ("pushDeviceId", "userId", "installationId", "expoPushToken", "platform", "disabledReason")
           VALUES (
             '82000000-0000-4000-8000-000000000726',
             $1,
             'installation-disabled-reason',
             'ExponentPushToken[device-disabled-reason]',
             'IOS',
             'LOGOUT'
           )`,
          [userA],
        ),
      "23514",
      "push_devices_disable_check",
    );
    await expectConstraintError(
      () =>
        migrationPool.query(
          `INSERT INTO "pushDevices"
            ("pushDeviceId", "userId", "installationId", "expoPushToken", "platform")
           VALUES (
             '82000000-0000-4000-8000-000000000826',
             $1,
             'installation-missing-user',
             'ExponentPushToken[device-missing-user]',
             'IOS'
           )`,
          [missingUser],
        ),
      "23503",
      "push_devices_user_fk",
    );

    await migrationPool.query(`INSERT INTO "notificationPreferences" ("userId") VALUES ($1)`, [userA]);
    const defaultPreferences = await migrationPool.query<{
      orderPushEnabled: boolean;
      pushEnabled: boolean;
      stylePushEnabled: boolean;
      wishPushEnabled: boolean;
    }>(
      `SELECT "pushEnabled", "orderPushEnabled", "wishPushEnabled", "stylePushEnabled"
       FROM "notificationPreferences"
       WHERE "userId" = $1`,
      [userA],
    );
    expect(defaultPreferences.rows).toEqual([
      { orderPushEnabled: true, pushEnabled: true, stylePushEnabled: true, wishPushEnabled: true },
    ]);
    await expectConstraintError(
      () => migrationPool.query(`INSERT INTO "notificationPreferences" ("userId") VALUES ($1)`, [missingUser]),
      "23503",
      "notification_preferences_user_fk",
    );

    await migrationPool.query(
      `INSERT INTO "pushOutbox" ("pushOutboxId", "notificationId", "pushDeviceId")
       VALUES ('83000000-0000-4000-8000-000000000126', $1, $2)`,
      [notificationA, deviceA],
    );
    await expectConstraintError(
      () =>
        migrationPool.query(
          `INSERT INTO "pushOutbox" ("pushOutboxId", "notificationId", "pushDeviceId")
           VALUES ('83000000-0000-4000-8000-000000000226', $1, $2)`,
          [notificationA, deviceA],
        ),
      "23505",
      "push_outbox_notification_device_unique",
    );
    await expectConstraintError(
      () =>
        migrationPool.query(
          `INSERT INTO "pushOutbox" ("pushOutboxId", "notificationId", "pushDeviceId")
           VALUES (
             '83000000-0000-4000-8000-000000000326',
             '81000000-0000-4000-8000-000000000826',
             $1
           )`,
          [deviceA],
        ),
      "23503",
      "push_outbox_notification_fk",
    );
    await expectConstraintError(
      () =>
        migrationPool.query(
          `INSERT INTO "pushOutbox" ("pushOutboxId", "notificationId", "pushDeviceId")
           VALUES (
             '83000000-0000-4000-8000-000000000426',
             $1,
             '82000000-0000-4000-8000-000000000926'
           )`,
          [notificationB],
        ),
      "23503",
      "push_outbox_device_fk",
    );

    let matrixSequence = 100;
    const nextMatrixId = () => {
      matrixSequence += 1;
      return `83000000-0000-4000-8000-${String(matrixSequence).padStart(12, "0")}`;
    };
    const insertMatrixOutbox = (input: {
      readonly attemptCount?: number;
      readonly claimedAt?: string | null;
      readonly claimToken?: string | null;
      readonly expoTicketId?: string | null;
      readonly pushOutboxId: string;
      readonly rateLimitAttemptCount?: number;
      readonly receiptAvailableAt?: string | null;
      readonly status: string;
    }) =>
      migrationPool.query(
        `INSERT INTO "pushOutbox"
          ("pushOutboxId", "notificationId", "pushDeviceId", "status", "attemptCount", "rateLimitAttemptCount", "claimedAt", "claimToken", "expoTicketId", "receiptAvailableAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          input.pushOutboxId,
          notificationB,
          deviceB,
          input.status,
          input.attemptCount ?? 0,
          input.rateLimitAttemptCount ?? 0,
          input.claimedAt ?? null,
          input.claimToken ?? null,
          input.expoTicketId ?? null,
          input.receiptAvailableAt ?? null,
        ],
      );
    const validMatrixStates = [
      { status: "PENDING" },
      {
        claimedAt: "2026-08-31T01:00:00Z",
        claimToken: "84000000-0000-4000-8000-000000000126",
        status: "PROCESSING",
      },
      {
        claimedAt: "2026-08-31T01:00:00Z",
        claimToken: "84000000-0000-4000-8000-000000000226",
        expoTicketId: "ticket-processing",
        receiptAvailableAt: "2026-08-31T01:15:00Z",
        status: "PROCESSING",
      },
      {
        expoTicketId: "ticket-ticketed",
        receiptAvailableAt: "2026-08-31T01:15:00Z",
        status: "TICKETED",
      },
      {
        expoTicketId: "ticket-receipt-ok",
        receiptAvailableAt: "2026-08-31T01:15:00Z",
        status: "RECEIPT_OK",
      },
      { status: "FAILED" },
      {
        expoTicketId: "ticket-failed",
        receiptAvailableAt: "2026-08-31T01:15:00Z",
        status: "FAILED",
      },
    ] as const;
    for (const state of validMatrixStates) {
      const pushOutboxId = nextMatrixId();
      await expect(insertMatrixOutbox({ ...state, pushOutboxId })).resolves.toEqual(
        expect.objectContaining({ rowCount: 1 }),
      );
      await migrationPool.query(`DELETE FROM "pushOutbox" WHERE "pushOutboxId" = $1`, [pushOutboxId]);
    }
    await expectConstraintError(
      () => insertMatrixOutbox({ pushOutboxId: nextMatrixId(), status: "SENT" }),
      "23514",
      "push_outbox_status_check",
    );
    await expectConstraintError(
      () => insertMatrixOutbox({ attemptCount: -1, pushOutboxId: nextMatrixId(), status: "PENDING" }),
      "23514",
      "push_outbox_attempt_count_check",
    );
    await expectConstraintError(
      () => insertMatrixOutbox({ pushOutboxId: nextMatrixId(), rateLimitAttemptCount: 9, status: "PENDING" }),
      "23514",
      "push_outbox_rate_limit_attempt_count_check",
    );
    await expectConstraintError(
      () =>
        insertMatrixOutbox({
          claimedAt: "2026-08-31T01:00:00Z",
          claimToken: "84000000-0000-4000-8000-000000000326",
          pushOutboxId: nextMatrixId(),
          status: "PENDING",
        }),
      "23514",
      "push_outbox_claim_check",
    );
    await expectConstraintError(
      () => insertMatrixOutbox({ pushOutboxId: nextMatrixId(), status: "PROCESSING" }),
      "23514",
      "push_outbox_claim_check",
    );
    await expectConstraintError(
      () =>
        insertMatrixOutbox({
          claimToken: "84000000-0000-4000-8000-000000000426",
          pushOutboxId: nextMatrixId(),
          status: "PROCESSING",
        }),
      "23514",
      "push_outbox_claim_check",
    );
    await expectConstraintError(
      () =>
        insertMatrixOutbox({
          claimedAt: "2026-08-31T01:00:00Z",
          pushOutboxId: nextMatrixId(),
          status: "PROCESSING",
        }),
      "23514",
      "push_outbox_claim_check",
    );
    await expectConstraintError(
      () =>
        insertMatrixOutbox({
          claimedAt: "2026-08-31T01:00:00Z",
          claimToken: "84000000-0000-4000-8000-000000000526",
          expoTicketId: "ticket-without-receipt",
          pushOutboxId: nextMatrixId(),
          status: "PROCESSING",
        }),
      "23514",
      "push_outbox_ticket_pair_check",
    );
    await expectConstraintError(
      () =>
        insertMatrixOutbox({
          claimedAt: "2026-08-31T01:00:00Z",
          claimToken: "84000000-0000-4000-8000-000000000626",
          pushOutboxId: nextMatrixId(),
          receiptAvailableAt: "2026-08-31T01:15:00Z",
          status: "PROCESSING",
        }),
      "23514",
      "push_outbox_ticket_pair_check",
    );
    await expectConstraintError(
      () =>
        insertMatrixOutbox({
          expoTicketId: "ticket-pending",
          pushOutboxId: nextMatrixId(),
          receiptAvailableAt: "2026-08-31T01:15:00Z",
          status: "PENDING",
        }),
      "23514",
      "push_outbox_ticket_state_check",
    );
    await expectConstraintError(
      () => insertMatrixOutbox({ pushOutboxId: nextMatrixId(), status: "TICKETED" }),
      "23514",
      "push_outbox_ticket_state_check",
    );
    await expectConstraintError(
      () => insertMatrixOutbox({ pushOutboxId: nextMatrixId(), status: "RECEIPT_OK" }),
      "23514",
      "push_outbox_ticket_state_check",
    );

    const cascadeNotification = "81000000-0000-4000-8000-000000001026";
    await migrationPool.query(
      `INSERT INTO "notifications"
        ("notificationId", "userId", "type", "title", "body", "route", "entityId", "dedupeKey")
       VALUES ($1, $2, 'ORDER_STATUS', 'Cascade notification', 'Body', '/order/4', $3, 'cascade-notification')`,
      [cascadeNotification, userA, "91000000-0000-4000-8000-000000001026"],
    );
    await migrationPool.query(
      `INSERT INTO "pushOutbox" ("pushOutboxId", "notificationId", "pushDeviceId")
       VALUES ('83000000-0000-4000-8000-000000001026', $1, $2)`,
      [cascadeNotification, deviceA],
    );
    await migrationPool.query(`DELETE FROM "notifications" WHERE "notificationId" = $1`, [cascadeNotification]);
    const notificationCascade = await migrationPool.query<{ outbox: string; device: string }>(
      `SELECT
         (SELECT count(*) FROM "pushOutbox" WHERE "pushOutboxId" = '83000000-0000-4000-8000-000000001026') AS outbox,
         (SELECT count(*) FROM "pushDevices" WHERE "pushDeviceId" = $1) AS device`,
      [deviceA],
    );
    expect(notificationCascade.rows).toEqual([{ device: "1", outbox: "0" }]);

    const cascadeDevice = "82000000-0000-4000-8000-000000001126";
    const deviceCascadeNotification = "81000000-0000-4000-8000-000000001126";
    await migrationPool.query(
      `INSERT INTO "pushDevices"
        ("pushDeviceId", "userId", "installationId", "expoPushToken", "platform")
       VALUES ($1, $2, 'installation-cascade', 'ExponentPushToken[device-cascade]', 'IOS')`,
      [cascadeDevice, userA],
    );
    await migrationPool.query(
      `INSERT INTO "notifications"
        ("notificationId", "userId", "type", "title", "body", "route", "entityId", "dedupeKey")
       VALUES ($1, $2, 'STYLE_LIKE', 'Cascade device', 'Body', '/style/2', $3, 'cascade-device')`,
      [deviceCascadeNotification, userA, "91000000-0000-4000-8000-000000001126"],
    );
    await migrationPool.query(
      `INSERT INTO "pushOutbox" ("pushOutboxId", "notificationId", "pushDeviceId")
       VALUES ('83000000-0000-4000-8000-000000001126', $1, $2)`,
      [deviceCascadeNotification, cascadeDevice],
    );
    await migrationPool.query(`DELETE FROM "pushDevices" WHERE "pushDeviceId" = $1`, [cascadeDevice]);
    const deviceCascade = await migrationPool.query<{ notification: string; outbox: string }>(
      `SELECT
         (SELECT count(*) FROM "pushOutbox" WHERE "pushOutboxId" = '83000000-0000-4000-8000-000000001126') AS outbox,
         (SELECT count(*) FROM "notifications" WHERE "notificationId" = $1) AS notification`,
      [deviceCascadeNotification],
    );
    expect(deviceCascade.rows).toEqual([{ notification: "1", outbox: "0" }]);
  });

  it("rolls back a partially applied notification migration and succeeds on rerun", async () => {
    const migrationsBeforeNotifications = (await readMigrationArtifacts())
      .filter(({ name, retired }) => !retired && name < "0026_notifications_push_outbox.sql")
      .map(({ name }) => name);
    await runHistoricalMigrations(migrationPool, undefined, migrationsBeforeNotifications);
    await migrationPool.query(`CREATE TABLE "pushDevices" ("blocker" integer)`);

    const failedMigration = await migrate({ pool: migrationPool }).then(
      () => ({ status: "fulfilled" as const }),
      (error: { code?: string }) => ({ code: error.code, status: "rejected" as const }),
    );
    const rolledBackTables = await migrationPool.query<{
      notificationPreferences: string | null;
      notifications: string | null;
      pushDevices: string | null;
      pushOutbox: string | null;
    }>(
      `SELECT
         to_regclass('"notifications"')::text AS notifications,
         to_regclass('"pushDevices"')::text AS "pushDevices",
         to_regclass('"notificationPreferences"')::text AS "notificationPreferences",
         to_regclass('"pushOutbox"')::text AS "pushOutbox"`,
    );
    const failedJournal = await migrationPool.query<{ count: string }>(
      `SELECT count(*) FROM "_migrations" WHERE "name" = '0026_notifications_push_outbox.sql'`,
    );

    expect(failedMigration).toEqual({ code: "42P07", status: "rejected" });
    expect(rolledBackTables.rows).toEqual([
      { notificationPreferences: null, notifications: null, pushDevices: '"pushDevices"', pushOutbox: null },
    ]);
    expect(failedJournal.rows).toEqual([{ count: "0" }]);

    await migrationPool.query(`DROP TABLE "pushDevices"`);
    await migrate({ pool: migrationPool });
    const rerunTables = await migrationPool.query<{
      notificationPreferences: string | null;
      notifications: string | null;
      pushDevices: string | null;
      pushOutbox: string | null;
    }>(
      `SELECT
         to_regclass('"notifications"')::text AS notifications,
         to_regclass('"pushDevices"')::text AS "pushDevices",
         to_regclass('"notificationPreferences"')::text AS "notificationPreferences",
         to_regclass('"pushOutbox"')::text AS "pushOutbox"`,
    );
    const rerunJournal = await migrationPool.query<{ count: string }>(
      `SELECT count(*) FROM "_migrations" WHERE "name" = '0026_notifications_push_outbox.sql'`,
    );
    expect(rerunTables.rows).toEqual([
      {
        notificationPreferences: '"notificationPreferences"',
        notifications: "notifications",
        pushDevices: '"pushDevices"',
        pushOutbox: '"pushOutbox"',
      },
    ]);
    expect(rerunJournal.rows).toEqual([{ count: "1" }]);
  });

  it("backfills the latest price snapshot for an existing published product", async () => {
    const migrationsBeforePriceSnapshots = (await readMigrationArtifacts())
      .filter(({ name, retired }) => !retired && name < "0024_product_price_evidence_snapshots.sql")
      .map(({ name }) => name);
    await runHistoricalMigrations(migrationPool, undefined, migrationsBeforePriceSnapshots);
    await seedHistoricalMigration(migrationPool);
    await migrationPool.query(
      `INSERT INTO "productSkus" ("productId", "code", "optionName", "price", "stock", "position")
       VALUES
         ('70000000-0000-4000-8000-000000000001', 'MIGRATION-LOW', 'Low', 12000, 1, 0),
         ('70000000-0000-4000-8000-000000000001', 'MIGRATION-HIGH', 'High', 18000, 1, 1)`,
    );

    await migrate({ pool: migrationPool });

    const snapshots = await migrationPool.query<{
      basePrice: number;
      finalPrice: number;
      revision: string;
      source: string;
    }>(
      `SELECT "basePrice", "finalPrice", "revision", "source"
       FROM "productPriceEvidenceSnapshots"
       WHERE "productId" = '70000000-0000-4000-8000-000000000001'`,
    );
    expect(snapshots.rows).toEqual([
      {
        basePrice: 18000,
        finalPrice: 12000,
        revision: expect.stringMatching(/^[0-9a-f-]{36}$/),
        source: "catalog_sku_price_snapshot",
      },
    ]);
  });

  it("uses dedicated indexes for bounded anonymous-flow cleanup candidates", async () => {
    await migrate({ pool: migrationPool });
    await migrationPool.query(`SET enable_seqscan = off`);
    const scans = [
      {
        table: "kakaoLoginFlows",
        id: "flowId",
        timestamp: "expiresAt",
        condition: `"expiresAt" <= now()`,
        index: "kakao_login_flows_cleanup_expires_idx",
      },
      {
        table: "kakaoLoginFlows",
        id: "flowId",
        timestamp: "consumedAt",
        condition: `"consumedAt" IS NOT NULL`,
        index: "kakao_login_flows_cleanup_consumed_idx",
      },
      {
        table: "identityVerificationSessions",
        id: "sessionId",
        timestamp: "expiresAt",
        condition: `"expiresAt" <= now()`,
        index: "identity_verification_cleanup_expires_idx",
      },
      {
        table: "identityVerificationSessions",
        id: "sessionId",
        timestamp: "consumedAt",
        condition: `"consumedAt" IS NOT NULL`,
        index: "identity_verification_cleanup_consumed_idx",
      },
    ] as const;

    for (const scan of scans) {
      const plan = await migrationPool.query<{ "QUERY PLAN": unknown }>(
        `EXPLAIN (FORMAT JSON, COSTS OFF)
         SELECT "${scan.id}"
         FROM "${scan.table}"
         WHERE ${scan.condition}
         ORDER BY "${scan.timestamp}", "${scan.id}"
         FOR UPDATE SKIP LOCKED
         LIMIT 100`,
      );
      expect(JSON.stringify(plan.rows[0]?.["QUERY PLAN"])).toContain(scan.index);
    }

    const terminalPlan = await migrationPool.query<{ "QUERY PLAN": unknown }>(
      `EXPLAIN (FORMAT JSON, COSTS OFF)
       SELECT "id"
       FROM "emailDeliveryOutbox"
       WHERE "status" IN ('SENT', 'SUPPRESSED', 'FAILED')
         AND "updatedAt" <= now()
       ORDER BY "updatedAt", "id"
       FOR UPDATE SKIP LOCKED
       LIMIT 100`,
    );
    expect(JSON.stringify(terminalPlan.rows[0]?.["QUERY PLAN"])).toContain(
      "email_delivery_outbox_terminal_updated_idx",
    );

    const terminalScrubPlan = await migrationPool.query<{ "QUERY PLAN": unknown }>(
      `EXPLAIN (FORMAT JSON, COSTS OFF)
       SELECT "id"
       FROM "emailDeliveryOutbox"
       WHERE "status" IN ('SENT', 'SUPPRESSED', 'FAILED')
         AND (
           "email" <> 'redacted@invalid'
           OR "requestIpHash" IS NOT NULL
           OR "payloadCiphertext" IS NOT NULL
           OR "proofId" IS NOT NULL
           OR "lastError" IS NOT NULL
         )
       ORDER BY "updatedAt", "id"
       FOR UPDATE SKIP LOCKED
       LIMIT 100`,
    );
    expect(JSON.stringify(terminalScrubPlan.rows[0]?.["QUERY PLAN"])).toContain(
      "email_delivery_outbox_terminal_updated_idx",
    );

    const refreshRotationPlan = await migrationPool.query<{ "QUERY PLAN": unknown }>(
      `EXPLAIN (FORMAT JSON, COSTS OFF)
       SELECT "id"
       FROM "refreshTokenRotationMarker"
       WHERE "expiresAt" <= now()
       ORDER BY "expiresAt", "id"
       FOR UPDATE SKIP LOCKED
       LIMIT 100`,
    );
    expect(JSON.stringify(refreshRotationPlan.rows[0]?.["QUERY PLAN"])).toContain(
      "refresh_token_rotation_marker_expires_idx",
    );
  });

  it("adds nullable callback-token hashes without losing pre-migration auth flows", async () => {
    const originalDirectory = process.cwd();
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "dadamjang-callback-token-migration-"));
    try {
      await fs.cp(path.join(originalDirectory, "migrations"), path.join(temporaryDirectory, "migrations"), {
        recursive: true,
      });
      await fs.cp(
        path.join(originalDirectory, "retired-migrations"),
        path.join(temporaryDirectory, "retired-migrations"),
        { recursive: true },
      );
      await fs.rm(path.join(temporaryDirectory, "migrations/0020_callback_tokens.sql"));
      process.chdir(temporaryDirectory);
      await migrate({ pool: migrationPool });
      await migrationPool.query(
        `INSERT INTO "kakaoLoginFlows" ("flowId", "deviceIdHash", "expiresAt")
         VALUES ('d0000000-0000-4000-8000-000000000020', 'device-hash', now() + interval '10 minutes')`,
      );
      await migrationPool.query(
        `INSERT INTO "identityVerificationSessions"
          ("sessionId", "purpose", "provider", "deviceIdHash", "merchantTransactionId", "expiresAt")
         VALUES ('c0000000-0000-4000-8000-000000000020', 'SIGNUP', 'KAKAO', 'device-hash', 'callbackmigration001', now() + interval '10 minutes')`,
      );
      await fs.copyFile(
        path.join(originalDirectory, "migrations/0020_callback_tokens.sql"),
        path.join(temporaryDirectory, "migrations/0020_callback_tokens.sql"),
      );

      await migrate({ pool: migrationPool });

      const flows = await migrationPool.query<{ kakao: string | null; identity: string | null }>(
        `SELECT
          (SELECT "callbackTokenHash" FROM "kakaoLoginFlows" WHERE "flowId" = 'd0000000-0000-4000-8000-000000000020') AS kakao,
          (SELECT "callbackTokenHash" FROM "identityVerificationSessions" WHERE "sessionId" = 'c0000000-0000-4000-8000-000000000020') AS identity`,
      );
      expect(flows.rows).toEqual([{ kakao: null, identity: null }]);
    } finally {
      process.chdir(originalDirectory);
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("records artifact checksums in deterministic order and tombstones the retired migration", async () => {
    const artifacts = await readMigrationArtifacts();
    const executed: string[] = [];

    await migrate({
      pool: migrationPool,
      beforeMigration: async (name, pool) => {
        const artifactIndex = artifacts.findIndex((artifact) => artifact.name === name);
        const applied = await pool.query<{ name: string }>(`SELECT "name" FROM "_migrations" ORDER BY "name"`);
        expect(artifactIndex).toBeGreaterThanOrEqual(0);
        expect(applied.rows.map((row) => row.name)).toEqual(
          artifacts.slice(0, artifactIndex).map((artifact) => artifact.name),
        );
        executed.push(name);
      },
    });

    const journal = await migrationPool.query<{ name: string; checksum: string }>(
      `SELECT "name", "checksum" FROM "_migrations" ORDER BY "name"`,
    );

    expect(executed).toEqual(artifacts.filter(({ retired }) => !retired).map(({ name }) => name));
    expect(executed).not.toContain(RETIRED_DEMO_MIGRATION.name);
    expect(journal.rows).toEqual(artifacts.map(({ name, checksum }) => ({ name, checksum })));
    expect(artifacts.find(({ name }) => name === RETIRED_DEMO_MIGRATION.name)).toEqual({
      ...RETIRED_DEMO_MIGRATION,
      retired: true,
    });
    expect(journal.rows.find(({ name }) => name === RETIRED_DEMO_MIGRATION.name)).toEqual(RETIRED_DEMO_MIGRATION);
  });

  it("rejects a wrong existing checksum for the retired migration", async () => {
    await runHistoricalMigrations(migrationPool, undefined, HISTORICAL_MIGRATIONS.slice(0, -1));
    await migrationPool.query('INSERT INTO "_migrations" ("name", "checksum") VALUES ($1, $2)', [
      RETIRED_DEMO_MIGRATION.name,
      "wrong-checksum",
    ]);

    await expect(migrate({ pool: migrationPool })).rejects.toThrow(
      `migration checksum changed: ${RETIRED_DEMO_MIGRATION.name}`,
    );
    const nextMigration = await migrationPool.query(
      `SELECT 1 FROM "_migrations" WHERE "name" = '0006_assign_demo_product_categories.sql'`,
    );
    expect(nextMigration.rowCount).toBe(0);
  });

  it("accepts an applied historical migration with the original checksum", async () => {
    await runHistoricalMigrations(migrationPool, async (name, pool) => {
      if (name === RETIRED_DEMO_MIGRATION.name) await seedHistoricalMigration(pool);
    });

    await migrate({ pool: migrationPool });

    const retired = await migrationPool.query<{ name: string; checksum: string }>(
      'SELECT "name", "checksum" FROM "_migrations" WHERE "name" = $1',
      [RETIRED_DEMO_MIGRATION.name],
    );
    expect(retired.rows).toEqual([RETIRED_DEMO_MIGRATION]);
  });

  it("makes the historical runner skip the retired migration after a current upgrade", async () => {
    await runHistoricalMigrations(migrationPool, undefined, HISTORICAL_MIGRATIONS.slice(0, -1));
    await seedHistoricalMigration(migrationPool);
    await migrate({ pool: migrationPool });

    await runHistoricalMigrations(migrationPool);

    const catalog = await migrationPool.query<{ products: string; skus: string }>(
      `SELECT
         (SELECT count(*) FROM "products") AS products,
         (SELECT count(*) FROM "productSkus") AS skus`,
    );
    expect(catalog.rows).toEqual([{ products: "1", skus: "0" }]);
  });

  it("retains active migration checksum validation", async () => {
    await migrate({ pool: migrationPool });
    await migrationPool.query(
      `UPDATE "_migrations" SET "checksum" = 'wrong-checksum' WHERE "name" = '0004_catalog_filters.sql'`,
    );

    await expect(migrate({ pool: migrationPool })).rejects.toThrow(
      "migration checksum changed: 0004_catalog_filters.sql",
    );
  });

  it("rejects duplicate active and retired migration names", async () => {
    const originalDirectory = process.cwd();
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "dadamjang-migrations-"));
    try {
      await fs.mkdir(path.join(temporaryDirectory, "migrations"));
      await fs.mkdir(path.join(temporaryDirectory, "retired-migrations"));
      await fs.writeFile(path.join(temporaryDirectory, "migrations", "0000_duplicate.sql"), "SELECT 1;\n");
      await fs.writeFile(path.join(temporaryDirectory, "retired-migrations", "0000_duplicate.sql"), "SELECT 1;\n");
      process.chdir(temporaryDirectory);

      await expect(migrate({ pool: migrationPool })).rejects.toThrow("duplicate migration: 0000_duplicate.sql");
    } finally {
      process.chdir(originalDirectory);
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("accepts a legitimate next migration and still rejects its checksum mutation", async () => {
    const originalDirectory = process.cwd();
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "dadamjang-future-migration-"));
    const currentArtifacts = await readMigrationArtifacts(originalDirectory);
    const nextNumber = Math.max(...currentArtifacts.map(({ name }) => Number.parseInt(name, 10))) + 1;
    const nextName = `${String(nextNumber).padStart(4, "0")}_future_migration_probe.sql`;
    const nextSql = 'CREATE TABLE "futureMigrationProbe" ("id" integer PRIMARY KEY);\n';
    try {
      await fs.cp(path.join(originalDirectory, "migrations"), path.join(temporaryDirectory, "migrations"), {
        recursive: true,
      });
      await fs.cp(
        path.join(originalDirectory, "retired-migrations"),
        path.join(temporaryDirectory, "retired-migrations"),
        { recursive: true },
      );
      await fs.writeFile(path.join(temporaryDirectory, "migrations", nextName), nextSql);
      process.chdir(temporaryDirectory);
      const artifacts = await readMigrationArtifacts(temporaryDirectory);
      const executed: string[] = [];

      await migrate({
        pool: migrationPool,
        beforeMigration: async (name) => {
          executed.push(name);
        },
      });

      const journal = await migrationPool.query<{ name: string; checksum: string }>(
        `SELECT "name", "checksum" FROM "_migrations" ORDER BY "name"`,
      );
      expect(executed).toEqual(artifacts.filter(({ retired }) => !retired).map(({ name }) => name));
      expect(journal.rows).toEqual(artifacts.map(({ name, checksum }) => ({ name, checksum })));
      expect(journal.rows[journal.rows.length - 1]).toEqual({ name: nextName, checksum: sha256(nextSql) });
      await expect(migrationPool.query(`SELECT to_regclass('"futureMigrationProbe"') AS table`)).resolves.toEqual(
        expect.objectContaining({ rows: [{ table: '"futureMigrationProbe"' }] }),
      );

      await migrate({ pool: migrationPool });
      await fs.appendFile(path.join(temporaryDirectory, "migrations", nextName), "SELECT 1;\n");
      await expect(migrate({ pool: migrationPool })).rejects.toThrow(`migration checksum changed: ${nextName}`);
      const unchangedJournal = await migrationPool.query<{ name: string; checksum: string }>(
        `SELECT "name", "checksum" FROM "_migrations" ORDER BY "name"`,
      );
      expect(unchangedJournal.rows).toEqual(journal.rows);
    } finally {
      process.chdir(originalDirectory);
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("serializes concurrent runners and preserves an idempotent journal rerun", async () => {
    const expectedJournal = (await readMigrationArtifacts()).map(({ name, checksum }) => ({ name, checksum }));
    let releaseFirst: () => void = () => undefined;
    let reachedFirst: () => void = () => undefined;
    const firstPaused = new Promise<void>((resolve) => {
      reachedFirst = resolve;
    });
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let reachedSecond: () => void = () => undefined;
    const secondEnteredMigration = new Promise<void>((resolve) => {
      reachedSecond = resolve;
    });
    let entrants = 0;
    const beforeMigration = async (name: string) => {
      if (name === "0000_initial_schema.sql") {
        entrants += 1;
        if (entrants === 1) {
          reachedFirst();
          await firstRelease;
        } else {
          reachedSecond();
        }
      }
    };

    const first = migrate({ pool: migrationPool, beforeMigration });
    await firstPaused;
    const second = migrate({ pool: migrationPool, beforeMigration });
    const contention = await Promise.race([
      secondEnteredMigration.then(() => "unserialized" as const),
      waitForAdvisoryLock(adminPool).then((waiting) => (waiting ? ("serialized" as const) : ("missing" as const))),
    ]);
    releaseFirst();
    const outcomes = await Promise.allSettled([first, second]);

    expect(contention).toBe("serialized");
    expect(outcomes).toEqual([
      expect.objectContaining({ status: "fulfilled" }),
      expect.objectContaining({ status: "fulfilled" }),
    ]);
    const firstJournal = await migrationPool.query<{ name: string; checksum: string }>(
      `SELECT "name", "checksum" FROM "_migrations" ORDER BY "name"`,
    );
    await migrate({ pool: migrationPool, beforeMigration });
    const rerunJournal = await migrationPool.query<{ name: string; checksum: string }>(
      `SELECT "name", "checksum" FROM "_migrations" ORDER BY "name"`,
    );
    expect(firstJournal.rows).toEqual(expectedJournal);
    expect(rerunJournal.rows).toEqual(firstJournal.rows);
  });

  it("bounds advisory lock waits before a second runner can touch the journal", async () => {
    let releaseFirst: () => void = () => undefined;
    let reachedFirst: () => void = () => undefined;
    const firstPaused = new Promise<void>((resolve) => {
      reachedFirst = resolve;
    });
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const beforeMigration = async (name: string) => {
      if (name === "0000_initial_schema.sql") {
        reachedFirst();
        await firstRelease;
      }
    };
    const first = migrate({ pool: migrationPool, beforeMigration });
    await firstPaused;
    const second = migrate({ pool: migrationPool, beforeMigration, advisoryLockTimeoutMs: 100 });
    const outcome = await Promise.race([
      second.then(
        () => ({ status: "fulfilled" as const }),
        (error: { code?: string }) => ({ status: "rejected" as const, code: error.code }),
      ),
      wait(300).then(() => ({ status: "waiting" as const })),
    ]);
    const journalBeforeRelease = await migrationPool.query<{ count: string }>(`SELECT count(*) FROM "_migrations"`);
    releaseFirst();
    await first;
    await second.catch(() => undefined);

    expect(outcome).toEqual({ status: "rejected", code: "57014" });
    expect(journalBeforeRelease.rows).toEqual([{ count: "0" }]);
  });

  it("bounds catalog index lock waits, rolls back its journal, and succeeds on rerun", async () => {
    let blocker: PoolClient | undefined;
    let blockerReady: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      blockerReady = resolve;
    });
    const beforeMigration = async (name: string) => {
      if (name === "0015_catalog_keyset_indexes.sql") {
        blocker = await migrationPool.connect();
        await blocker.query("BEGIN");
        await blocker.query(`LOCK TABLE "products" IN ROW EXCLUSIVE MODE`);
        blockerReady();
      }
    };
    const migration = migrate({
      pool: migrationPool,
      beforeMigration,
      lockTimeoutMs: 100,
      statementTimeoutMs: 2_000,
    });
    await blocked;
    const outcome = await Promise.race([
      migration.then(
        () => ({ status: "fulfilled" as const }),
        (error: { code?: string }) => ({ status: "rejected" as const, code: error.code }),
      ),
      wait(300).then(() => ({ status: "waiting" as const })),
    ]);

    await blocker?.query("ROLLBACK");
    blocker?.release();
    await migration.catch(() => undefined);

    expect(outcome).toEqual({ status: "rejected", code: "55P03" });
    const failedJournal = await migrationPool.query<{ count: string }>(
      `SELECT count(*) FROM "_migrations" WHERE "name" = '0015_catalog_keyset_indexes.sql'`,
    );
    expect(failedJournal.rows).toEqual([{ count: "0" }]);

    await migrate({
      pool: migrationPool,
      lockTimeoutMs: 100,
      statementTimeoutMs: 2_000,
    });
    const indexes = await migrationPool.query<{ indexrelid: string; indisvalid: boolean }>(
      `SELECT indexrelid::regclass::text, indisvalid
       FROM pg_index
       WHERE indexrelid IN (
         'products_catalog_default_keyset_idx'::regclass,
         'products_catalog_category_keyset_idx'::regclass
       )
       ORDER BY indexrelid::regclass::text`,
    );
    expect(indexes.rows).toEqual([
      { indexrelid: "products_catalog_category_keyset_idx", indisvalid: true },
      { indexrelid: "products_catalog_default_keyset_idx", indisvalid: true },
    ]);
  });
});
