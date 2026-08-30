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
