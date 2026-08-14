import * as bcrypt from "bcrypt";
import type { Pool } from "pg";
import { hashToken } from "../common/security/token-hash";

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

export const ADMIN_FIXTURE = {
  userId: "11000000-0000-4000-8000-000000000001",
  userid: "integration-admin",
  email: "admin@example.test",
  password: "IntegrationAdmin123!",
  partnerOwnerUserId: "11000000-0000-4000-8000-000000000002",
  partnerOwnerUserid: "pending-owner",
  partnerOwnerEmail: "pending-owner@example.test",
  partnerId: "21000000-0000-4000-8000-000000000001",
  productId: "71000000-0000-4000-8000-000000000001",
  skuId: "81000000-0000-4000-8000-000000000001",
  orderId: "91000000-0000-4000-8000-000000000001",
  orderItemId: "92000000-0000-4000-8000-000000000001",
  orderNumber: "DJ-ADMIN-001",
  inviteId: "a1000000-0000-4000-8000-000000000001",
  inviteEmail: "invited-admin@example.test",
  inviteToken: "integration-admin-invite-token",
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
    `INSERT INTO "partners" ("partnerId", "ownerUserId", "businessEmail", "businessRegistrationNumber", "tradeName", "brandId", "status") VALUES ($1, $2, 'partner@example.test', '1000000000', 'Integration Partner', $3, 'APPROVED')`,
    [FIXTURE.partnerId, FIXTURE.userId, FIXTURE.brandId],
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
    `INSERT INTO "productSkus" ("skuId", "productId", "code", "colorId", "sizeId", "optionName", "price", "stock", "position") VALUES ($1, $3, 'INTEGRATION-TEE-M', $5, $6, 'Black / M', 15000, 5, 0), ($2, $4, 'INTEGRATION-SHOES-M', $5, $6, 'Black / M', 30000, 1, 0)`,
    [FIXTURE.skuId, FIXTURE.secondSkuId, FIXTURE.productId, FIXTURE.secondProductId, FIXTURE.colorId, FIXTURE.sizeId],
  );
};

export const seedAdminFixtures = async (pool: Pool) => {
  const password = await bcrypt.hash(ADMIN_FIXTURE.password, 4);
  await pool.query(
    `INSERT INTO "users" ("userId", "userid", "email", "password", "role") VALUES
      ($1, $2, $3, $4, 'ADMIN'),
      ($5, $6, $7, $4, 'USER')`,
    [
      ADMIN_FIXTURE.userId,
      ADMIN_FIXTURE.userid,
      ADMIN_FIXTURE.email,
      password,
      ADMIN_FIXTURE.partnerOwnerUserId,
      ADMIN_FIXTURE.partnerOwnerUserid,
      ADMIN_FIXTURE.partnerOwnerEmail,
    ],
  );
  await pool.query(
    `INSERT INTO "partners"
      ("partnerId", "ownerUserId", "businessEmail", "businessRegistrationNumber", "tradeName", "status", "createdAt")
     VALUES ($1, $2, 'pending-partner@example.test', '2000000000', 'Pending Partner', 'PENDING', '2026-08-13T03:00:00Z')`,
    [ADMIN_FIXTURE.partnerId, ADMIN_FIXTURE.partnerOwnerUserId],
  );
  await pool.query(
    `INSERT INTO "products"
      ("productId", "partnerId", "brandId", "categoryId", "title", "description", "imageUrls", "status", "approvalStatus", "createdAt")
     VALUES ($1, $2, $3, $4, 'Pending Admin Product', 'Pending product detail', '["https://example.test/product.jpg"]', 'DRAFT', 'PENDING', '2026-08-13T04:00:00Z')`,
    [ADMIN_FIXTURE.productId, ADMIN_FIXTURE.partnerId, FIXTURE.brandId, FIXTURE.categoryId],
  );
  await pool.query(
    `INSERT INTO "productSkus"
      ("skuId", "productId", "code", "colorId", "sizeId", "optionName", "price", "stock", "position")
     VALUES ($1, $2, 'ADMIN-PENDING-M', $3, $4, 'Black / M', 22000, 4, 0)`,
    [ADMIN_FIXTURE.skuId, ADMIN_FIXTURE.productId, FIXTURE.colorId, FIXTURE.sizeId],
  );
  await pool.query(
    `INSERT INTO "orders"
      ("orderId", "orderNumber", "userId", "status", "paymentStatus", "totalAmount", "createdAt")
     VALUES ($1, $2, $3, 'PAID', 'APPROVED', 30000, '2026-08-13T05:00:00Z')`,
    [ADMIN_FIXTURE.orderId, ADMIN_FIXTURE.orderNumber, FIXTURE.userId],
  );
  await pool.query(
    `INSERT INTO "orderItems"
      ("orderItemId", "orderId", "productId", "skuId", "productTitle", "skuOptionName", "unitPrice", "quantity")
     VALUES ($1, $2, $3, $4, 'Integration Sale Tee', 'Black / M', 15000, 2)`,
    [ADMIN_FIXTURE.orderItemId, ADMIN_FIXTURE.orderId, FIXTURE.productId, FIXTURE.skuId],
  );
  await pool.query(
    `INSERT INTO "adminInvites"
      ("inviteId", "email", "tokenHash", "invitedByUserId", "expiresAt")
     VALUES ($1, $2, $3, $4, now() + interval '72 hours')`,
    [ADMIN_FIXTURE.inviteId, ADMIN_FIXTURE.inviteEmail, hashToken(ADMIN_FIXTURE.inviteToken), ADMIN_FIXTURE.userId],
  );
};
