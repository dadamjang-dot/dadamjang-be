import { Pool, type PoolClient } from "pg";
import { createDatabasePool } from "src/database/connection";
import { migrate } from "src/database/migrate";
import { testPool } from "./support/database";

const SCHEMA_NAME = "catalog_migration_safety_test";
const RETIRED_DEMO_MIGRATION = {
  name: "0005_catalog_demo_products.sql",
  checksum: "44d98c294ac8c2afa502f7bdb2c65411df7d4879dad39cd5b4fbc8cf9c94059f",
} as const;

const scopedPool = () => createDatabasePool(process.env, `-c search_path=${SCHEMA_NAME},public`);

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

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

describe("database migration PostgreSQL integration", () => {
  let adminPool: Pool;
  let migrationPool: Pool;

  beforeEach(async () => {
    adminPool = testPool();
    await adminPool.query(`DROP SCHEMA IF EXISTS "${SCHEMA_NAME}" CASCADE`);
    await adminPool.query(`CREATE SCHEMA "${SCHEMA_NAME}"`);
    migrationPool = scopedPool();
  });

  afterEach(async () => {
    await migrationPool.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS "${SCHEMA_NAME}" CASCADE`);
    await adminPool.end();
  });

  it("migrates an empty schema without temporary catalog data", async () => {
    await migrate({ pool: migrationPool });

    const journal = await migrationPool.query<{ name: string }>(`SELECT "name" FROM "_migrations" ORDER BY "name"`);
    const catalog = await migrationPool.query<{ products: string; skus: string }>(
      `SELECT
         (SELECT count(*) FROM "products") AS products,
         (SELECT count(*) FROM "productSkus") AS skus`,
    );

    expect(journal.rows.map(({ name }) => name)).toEqual([
      "0000_initial_schema.sql",
      "0001_commerce_domain.sql",
      "0002_style_posts_partner.sql",
      "0003_rename_wishlists.sql",
      "0004_catalog_filters.sql",
      "0006_assign_demo_product_categories.sql",
      "0007_style_posts_feed.sql",
      "0008_style_post_like_snapshots.sql",
      "0009_wish_library_collections.sql",
      "0010_auth_account_recovery.sql",
      "0011_admin_backoffice.sql",
      "0012_partner_catalog_portal.sql",
      "0013_partner_product_image_keys_array.sql",
      "0014_partner_catalog_integrity.sql",
      "0015_catalog_keyset_indexes.sql",
    ]);
    expect(catalog.rows).toEqual([{ products: "0", skus: "0" }]);
  });

  it("accepts an existing journal entry for the retired demo migration", async () => {
    await migrate({ pool: migrationPool });
    await migrationPool.query('INSERT INTO "_migrations" ("name", "checksum") VALUES ($1, $2)', [
      RETIRED_DEMO_MIGRATION.name,
      RETIRED_DEMO_MIGRATION.checksum,
    ]);

    await migrate({ pool: migrationPool });

    const retired = await migrationPool.query<{ name: string; checksum: string }>(
      'SELECT "name", "checksum" FROM "_migrations" WHERE "name" = $1',
      [RETIRED_DEMO_MIGRATION.name],
    );
    expect(retired.rows).toEqual([RETIRED_DEMO_MIGRATION]);
  });

  it("serializes concurrent runners and preserves an idempotent journal rerun", async () => {
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
    expect(firstJournal.rows).toHaveLength(15);
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
