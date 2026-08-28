import { Pool, type PoolClient } from "pg";
import { createDatabasePool } from "src/database/connection";
import { seedMigrationPrerequisite } from "src/database/fixtures";
import { migrate } from "src/database/migrate";
import { testPool } from "./support/database";

const SCHEMA_NAME = "catalog_migration_safety_test";

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
    const beforeMigration = async (name: string, pool: Pool) => {
      if (name === "0000_initial_schema.sql") {
        entrants += 1;
        if (entrants === 1) {
          reachedFirst();
          await firstRelease;
        } else {
          reachedSecond();
        }
      }
      if (name === "0005_catalog_demo_products.sql") await seedMigrationPrerequisite(pool);
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
    expect(firstJournal.rows).toHaveLength(16);
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
    const beforeMigration = async (name: string, pool: Pool) => {
      if (name === "0000_initial_schema.sql") {
        reachedFirst();
        await firstRelease;
      }
      if (name === "0005_catalog_demo_products.sql") await seedMigrationPrerequisite(pool);
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
    const beforeMigration = async (name: string, pool: Pool) => {
      if (name === "0005_catalog_demo_products.sql") await seedMigrationPrerequisite(pool);
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
      beforeMigration: async (name, pool) => {
        if (name === "0005_catalog_demo_products.sql") await seedMigrationPrerequisite(pool);
      },
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
