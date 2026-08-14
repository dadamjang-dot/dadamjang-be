import { promises as fs } from "fs";
import path from "path";
import type { Pool } from "pg";
import { testPool } from "./support/database";

describe("partner catalog integrity migration", () => {
  let pool: Pool;
  let migration: string;

  beforeAll(async () => {
    pool = testPool();
    migration = await fs.readFile(path.join(process.cwd(), "migrations/0014_partner_catalog_integrity.sql"), "utf8");
  });

  afterAll(async () => pool.end());

  it("backfills a legacy null brand and deterministically orders existing SKUs", async () => {
    await pool.query("BEGIN");
    try {
      const product = await pool.query<{ productId: string; brandId: string }>(
        `SELECT product."productId", partner."brandId"
         FROM "products" product
         JOIN "partners" partner ON partner."partnerId" = product."partnerId"
         WHERE partner."brandId" IS NOT NULL
         LIMIT 1`,
      );
      expect(product.rowCount).toBe(1);
      const row = product.rows[0]!;
      await pool.query('UPDATE "products" SET "brandId" = NULL WHERE "productId" = $1', [row.productId]);
      await pool.query('DROP INDEX "product_skus_product_position_idx"');
      await pool.query('ALTER TABLE "productSkus" DROP COLUMN "position"');

      await pool.query(migration);

      const migrated = await pool.query<{ brandId: string }>(
        'SELECT "brandId" FROM "products" WHERE "productId" = $1',
        [row.productId],
      );
      expect(migrated.rows[0]?.brandId).toBe(row.brandId);
      const positions = await pool.query<{ position: number }>(
        'SELECT "position" FROM "productSkus" WHERE "productId" = $1 ORDER BY "createdAt", "skuId"',
        [row.productId],
      );
      expect(positions.rows.map(({ position }) => position)).toEqual(positions.rows.map((_, index) => index));
    } finally {
      await pool.query("ROLLBACK");
    }
  });

  it("fails explicitly when a product and its partner have different brands", async () => {
    await pool.query("BEGIN");
    try {
      const product = await pool.query<{ productId: string }>(
        `SELECT product."productId"
         FROM "products" product
         JOIN "partners" partner ON partner."partnerId" = product."partnerId"
         WHERE partner."brandId" IS NOT NULL
         LIMIT 1`,
      );
      const brand = await pool.query<{ brandId: string }>(
        `INSERT INTO "brands" ("name", "slug", "isActive")
         VALUES ('Mismatch', 'migration-mismatch', true)
         RETURNING "brandId"`,
      );
      await pool.query('UPDATE "products" SET "brandId" = $1 WHERE "productId" = $2', [
        brand.rows[0]!.brandId,
        product.rows[0]!.productId,
      ]);
      await pool.query('DROP INDEX "product_skus_product_position_idx"');
      await pool.query('ALTER TABLE "productSkus" DROP COLUMN "position"');

      await expect(pool.query(migration)).rejects.toThrow("partner catalog brand backfill failed");
    } finally {
      await pool.query("ROLLBACK");
    }
  });
});
