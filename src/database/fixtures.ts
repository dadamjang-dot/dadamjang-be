import * as bcrypt from "bcrypt";
import type { Pool } from "pg";

export const FIXTURE = {
  userId: "10000000-0000-4000-8000-000000000001",
  userid: "integration-user",
  password: "IntegrationPassword123!",
  partnerId: "20000000-0000-4000-8000-000000000001",
  categoryId: "30000000-0000-4000-8000-000000000001",
  secondCategoryId: "30000000-0000-4000-8000-000000000002",
  brandId: "40000000-0000-4000-8000-000000000001",
  colorId: "50000000-0000-4000-8000-000000000001",
  sizeId: "60000000-0000-4000-8000-000000000001",
  productId: "70000000-0000-4000-8000-000000000001",
  secondProductId: "70000000-0000-4000-8000-000000000002",
  skuId: "80000000-0000-4000-8000-000000000001",
  secondSkuId: "80000000-0000-4000-8000-000000000002",
} as const;

export const seedMigrationPrerequisite = async (pool: Pool) => {
  const password = await bcrypt.hash(FIXTURE.password, 4);
  await pool.query(`INSERT INTO "users" ("userId", "userid", "email", "password") VALUES ($1, $2, $3, $4)`, [
    FIXTURE.userId,
    FIXTURE.userid,
    "integration@example.test",
    password,
  ]);
  const category = await pool.query<{ categoryId: string }>(
    `SELECT "categoryId" FROM "categories" ORDER BY "sortOrder", "categoryId" LIMIT 1`,
  );
  const categoryId = category.rows[0]?.categoryId;
  if (!categoryId) throw new Error("Migration prerequisite category missing");
  await pool.query(
    `INSERT INTO "partners" ("partnerId", "ownerUserId", "businessEmail", "businessRegistrationNumber", "tradeName", "status") VALUES ($1, $2, $3, $4, $5, 'APPROVED')`,
    [FIXTURE.partnerId, FIXTURE.userId, "partner@example.test", "1000000000", "Integration Partner"],
  );
  await pool.query(
    `INSERT INTO "products" ("productId", "partnerId", "categoryId", "title", "description", "status", "approvalStatus", "publishedAt") VALUES ($1, $2, $3, $4, $5, 'PUBLISHED', 'APPROVED', now())`,
    [FIXTURE.productId, FIXTURE.partnerId, categoryId, "Migration Source Product", "Migration source fixture"],
  );
};

export const resetFixtures = async (pool: Pool) => {
  const tables = await pool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_migrations'`,
  );
  if (tables.rows.length) {
    const names = tables.rows.map(({ tablename }) => `"${tablename.replaceAll('"', '""')}"`).join(", ");
    await pool.query(`TRUNCATE ${names} RESTART IDENTITY CASCADE`);
  }
  const password = await bcrypt.hash(FIXTURE.password, 4);
  await pool.query(
    `INSERT INTO "users" ("userId", "userid", "email", "password", "role") VALUES ($1, $2, $3, $4, 'USER')`,
    [FIXTURE.userId, FIXTURE.userid, "integration@example.test", password],
  );
  await pool.query(
    `INSERT INTO "categories" ("categoryId", "name", "slug", "sortOrder") VALUES ($1, 'Tops', 'integration-tops', 1), ($2, 'Shoes', 'integration-shoes', 2)`,
    [FIXTURE.categoryId, FIXTURE.secondCategoryId],
  );
  await pool.query(
    `INSERT INTO "brands" ("brandId", "name", "slug") VALUES ($1, 'Integration Brand', 'integration-brand')`,
    [FIXTURE.brandId],
  );
  await pool.query(
    `INSERT INTO "colors" ("colorId", "name", "slug", "hexCode") VALUES ($1, 'Black', 'integration-black', '#000000')`,
    [FIXTURE.colorId],
  );
  await pool.query(
    `INSERT INTO "sizes" ("sizeId", "name", "slug", "sortOrder") VALUES ($1, 'Medium', 'integration-medium', 1)`,
    [FIXTURE.sizeId],
  );
  await pool.query(
    `INSERT INTO "partners" ("partnerId", "ownerUserId", "businessEmail", "businessRegistrationNumber", "tradeName", "status") VALUES ($1, $2, 'partner@example.test', '1000000000', 'Integration Partner', 'APPROVED')`,
    [FIXTURE.partnerId, FIXTURE.userId],
  );
  await pool.query(
    `INSERT INTO "products" ("productId", "partnerId", "brandId", "categoryId", "title", "description", "imageUrls", "status", "approvalStatus", "isOnSale", "isExpressDelivery", "publishedAt", "createdAt") VALUES ($1, $3, $4, $5, 'Integration Sale Tee', 'Primary integration product', '[]', 'PUBLISHED', 'APPROVED', true, true, now(), '2026-01-02T00:00:00Z'), ($2, $3, $4, $6, 'Integration Shoes', 'Secondary integration product', '[]', 'PUBLISHED', 'APPROVED', false, false, now(), '2026-01-01T00:00:00Z')`,
    [
      FIXTURE.productId,
      FIXTURE.secondProductId,
      FIXTURE.partnerId,
      FIXTURE.brandId,
      FIXTURE.categoryId,
      FIXTURE.secondCategoryId,
    ],
  );
  await pool.query(
    `INSERT INTO "productSkus" ("skuId", "productId", "code", "colorId", "sizeId", "optionName", "price", "stock") VALUES ($1, $3, 'INTEGRATION-TEE-M', $5, $6, 'Black / M', 15000, 5), ($2, $4, 'INTEGRATION-SHOES-M', $5, $6, 'Black / M', 30000, 1)`,
    [FIXTURE.skuId, FIXTURE.secondSkuId, FIXTURE.productId, FIXTURE.secondProductId, FIXTURE.colorId, FIXTURE.sizeId],
  );
};
