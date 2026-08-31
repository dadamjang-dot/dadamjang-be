import { CopyObjectCommand, GetObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { INestApplication } from "@nestjs/common";
import type { Pool } from "pg";
import request from "supertest";
import sharp from "sharp";
import { createApp } from "src/app";
import { hashToken } from "src/common/security/token-hash";
import { FIXTURE } from "src/database/fixtures";
import { NotificationService } from "src/modules/notification/notification.service";
import { PartnerService } from "src/modules/partner/partner.service";
import { resetTestFixtures, testPool } from "./support/database";

const validImageKey = "products/10000000-0000-4000-8000-000000000001/90000000-0000-4000-8000-000000000001.png";
const pendingImageKey =
  "pending/products/10000000-0000-4000-8000-000000000001/90000000-0000-4000-8000-000000000003.png";
const publishedSkuId = "80000000-0000-4000-8000-000000000003";
const wishUserIds = ["10000000-0000-4000-8000-000000000011", "10000000-0000-4000-8000-000000000012"] as const;
let pngBytes: Buffer;

const seedEmailProof = async (pool: Pool, verificationId: string, email: string, token: string) => {
  await pool.query(
    `INSERT INTO "emailVerification" ("id", "email", "purpose", "codeHash", "expiresAt", "verifiedAt")
     VALUES ($1, $2, 'SIGNUP', 'hash', now() + interval '10 minutes', now())`,
    [verificationId, email],
  );
  await pool.query(
    `INSERT INTO "emailVerificationToken" ("tokenHash", "email", "purpose", "verificationId", "expiresAt")
     VALUES ($1, $2, 'SIGNUP', $3, now() + interval '10 minutes')`,
    [hashToken(token), email, verificationId],
  );
};

const validImageObject = () => {
  let destination: { key: string; metadata: Record<string, string> } | undefined;
  return async (command: unknown) => {
    if (command instanceof HeadObjectCommand) {
      const promoted = destination;
      if (promoted && promoted.key === command.input.Key)
        return {
          ContentType: "image/png",
          ContentLength: pngBytes.byteLength,
          Metadata: promoted.metadata,
          ETag: '"copied-etag"',
        };
      if (/\/[0-9a-f]{64}\./.test(command.input.Key ?? ""))
        throw Object.assign(new Error("missing"), { $metadata: { httpStatusCode: 404 } });
      return {
        ContentType: "image/png",
        ContentLength: pngBytes.byteLength,
        Metadata: {
          "owner-id": FIXTURE.userId,
          "declared-content-type": "image/png",
          "declared-size": String(pngBytes.byteLength),
        },
        ETag: '"image-etag"',
      };
    }
    if (command instanceof GetObjectCommand)
      return {
        ContentType: "image/png",
        ContentLength: pngBytes.byteLength,
        ETag: destination?.key === command.input.Key ? '"copied-etag"' : '"image-etag"',
        Body: { transformToByteArray: async () => pngBytes },
      };
    if (command instanceof CopyObjectCommand) {
      if (!command.input.Key) throw new Error("Copy destination is required");
      destination = { key: command.input.Key, metadata: command.input.Metadata ?? {} };
      return { CopyObjectResult: { ETag: '"copied-etag"' } };
    }
    throw new Error("Unexpected storage command");
  };
};

describe("partner catalog GraphQL integration", () => {
  let app: INestApplication;
  let pool: Pool;

  const graphql = async (accessToken: string, query: string, variables: Record<string, unknown> = {}) =>
    request(app.getHttpServer())
      .post("/graphql")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ query, variables })
      .expect(200);

  const signin = async (portal: "FO" | "PARTNER" = "PARTNER") => {
    const response = await request(app.getHttpServer())
      .post("/graphql")
      .set("x-device-id", "partner-integration-device")
      .send({
        query: `mutation Signin($input: SigninAuthInput!) {
          signin(input: $input) { accessToken }
        }`,
        variables: {
          input: { userid: FIXTURE.userid, password: FIXTURE.password, portal },
        },
      })
      .expect(200);
    expect(response.body.errors).toBeUndefined();
    return response.body.data.signin.accessToken as string;
  };

  const input = (codes = ["PARTNER-SKU-A", "PARTNER-SKU-B"]) => ({
    categoryId: FIXTURE.categoryId,
    title: "Partner draft",
    description: "Partner product integration test",
    imageKeys: [validImageKey],
    isOnSale: true,
    isExpressDelivery: false,
    skus: codes.map((code, index) => ({
      code,
      optionName: `Option ${index + 1}`,
      price: 10000 + index,
      stock: 5 + index,
    })),
  });

  const updatePublishedProductSkus = async (
    accessToken: string,
    productId: string,
    skus: { skuId: string; price: number; stock: number }[],
  ) =>
    graphql(
      accessToken,
      `
        mutation UpdatePublishedProductSkus($input: UpdatePublishedProductSkusInput!) {
          updatePublishedProductSkus(input: $input) {
            productId
            title
            description
            status
            approvalStatus
            skus {
              skuId
              code
              optionName
              price
              stock
            }
          }
        }
      `,
      { input: { productId, skus } },
    );

  const seedPublishedSku = async (input: { isActive?: boolean; price?: number; stock?: number } = {}) => {
    await pool.query(
      `INSERT INTO "productSkus"
        ("skuId", "productId", "code", "colorId", "sizeId", "optionName", "price", "stock", "position", "isActive")
       VALUES ($1, $2, 'INTEGRATION-TEE-L', $3, $4, 'Black / L', $5, $6, 1, $7)`,
      [
        publishedSkuId,
        FIXTURE.productId,
        FIXTURE.colorId,
        FIXTURE.sizeId,
        input.price ?? 20000,
        input.stock ?? 0,
        input.isActive ?? true,
      ],
    );
  };

  const seedWishers = async () => {
    await pool.query(
      `INSERT INTO "users" ("userId", "userid", "email", "password", "role")
       VALUES
        ($1, 'wish-user-1', 'wish-user-1@example.test', 'unused', 'USER'),
        ($2, 'wish-user-2', 'wish-user-2@example.test', 'unused', 'USER')`,
      [...wishUserIds],
    );
    await pool.query(`INSERT INTO "wishes" ("userId", "productId") VALUES ($1, $3), ($2, $3)`, [
      ...wishUserIds,
      FIXTURE.productId,
    ]);
  };

  beforeAll(async () => {
    pngBytes = await sharp({
      create: { width: 4, height: 3, channels: 4, background: "#ff00ffff" },
    })
      .png()
      .toBuffer();
    pool = testPool();
    app = await createApp();
    await app.init();
  });

  beforeEach(async () => {
    await resetTestFixtures(pool);
    await pool.query(`UPDATE "users" SET "role" = 'PARTNER' WHERE "userId" = $1`, [FIXTURE.userId]);
    jest.spyOn(S3Client.prototype, "send").mockImplementation(validImageObject() as never);
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it("requires a Partner access token for published SKU updates", async () => {
    const unauthenticated = await updatePublishedProductSkus("", FIXTURE.productId, [
      { skuId: FIXTURE.skuId, price: 14000, stock: 5 },
    ]);
    expect(unauthenticated.body.errors[0].extensions.code).toBe("UNAUTHENTICATED");

    await pool.query(`UPDATE "users" SET "role" = 'USER' WHERE "userId" = $1`, [FIXTURE.userId]);
    const userAccessToken = await signin("FO");
    const forbidden = await updatePublishedProductSkus(userAccessToken, FIXTURE.productId, [
      { skuId: FIXTURE.skuId, price: 14000, stock: 5 },
    ]);
    expect(forbidden.body.errors[0].extensions.code).toBe("FORBIDDEN");
  });

  it("rejects invalid published SKU numbers before product lookup", async () => {
    const service = app.get(PartnerService) as unknown as {
      updatePublishedProductSkus: (
        ownerUserId: string,
        input: { productId: string; skus: { skuId: string; price: number; stock: number }[] },
      ) => Promise<unknown>;
    };
    const invalid = [
      { price: -1, stock: 0 },
      { price: 1.5, stock: 0 },
      { price: 0, stock: -1 },
      { price: 0, stock: Number.NaN },
    ];

    for (const values of invalid)
      await expect(
        service.updatePublishedProductSkus("invalid-owner", {
          productId: "invalid-product",
          skus: [{ skuId: "invalid-sku", ...values }],
        }),
      ).rejects.toThrow("Invalid partner product input");
  });

  it("rejects non-published products and incomplete, duplicate, or foreign SKU sets", async () => {
    const accessToken = await signin();
    const invalidSkuSets = [
      [],
      [
        { skuId: FIXTURE.skuId, price: 14000, stock: 5 },
        { skuId: FIXTURE.skuId, price: 13000, stock: 4 },
      ],
      [{ skuId: FIXTURE.secondSkuId, price: 14000, stock: 5 }],
      [{ skuId: FIXTURE.skuId, price: -1, stock: 5 }],
      [{ skuId: FIXTURE.skuId, price: 14000, stock: -1 }],
    ];

    for (const skus of invalidSkuSets) {
      const response = await updatePublishedProductSkus(accessToken, FIXTURE.productId, skus);
      expect(response.body.errors[0].extensions.code).toBe("BAD_USER_INPUT");
    }

    await pool.query(`UPDATE "products" SET "approvalStatus" = 'REJECTED' WHERE "productId" = $1`, [FIXTURE.productId]);
    const rejected = await updatePublishedProductSkus(accessToken, FIXTURE.productId, [
      { skuId: FIXTURE.skuId, price: 14000, stock: 5 },
    ]);
    expect(rejected.body.errors[0].extensions.code).toBe("BAD_USER_INPUT");

    await pool.query(`UPDATE "products" SET "status" = 'DRAFT', "approvalStatus" = 'APPROVED' WHERE "productId" = $1`, [
      FIXTURE.productId,
    ]);
    const draft = await updatePublishedProductSkus(accessToken, FIXTURE.productId, [
      { skuId: FIXTURE.skuId, price: 14000, stock: 5 },
    ]);
    expect(draft.body.errors[0].extensions.code).toBe("BAD_USER_INPUT");

    const sku = await pool.query<{ price: number; stock: number }>(
      `SELECT "price", "stock" FROM "productSkus" WHERE "skuId" = $1`,
      [FIXTURE.skuId],
    );
    expect(sku.rows).toEqual([{ price: 15000, stock: 5 }]);
  });

  it("updates published SKU inventory in place and creates both wish boundaries", async () => {
    await pool.query(`UPDATE "productSkus" SET "stock" = 0 WHERE "skuId" = $1`, [FIXTURE.skuId]);
    await seedPublishedSku({ isActive: false, price: 1, stock: 50 });
    await seedWishers();
    const accessToken = await signin();
    const beforeProduct = await pool.query(
      `SELECT "productId", "partnerId", "brandId", "categoryId", "title", "description", "imageKeys", "imageUrls",
              "status", "approvalStatus", "rejectionReason", "isOnSale", "isExpressDelivery", "publishedAt", "createdAt", "updatedAt"
       FROM "products" WHERE "productId" = $1`,
      [FIXTURE.productId],
    );
    const beforeSkus = await pool.query<{
      skuId: string;
      productId: string;
      colorId: string | null;
      sizeId: string | null;
      code: string;
      optionName: string;
      position: number;
      isActive: boolean;
      createdAt: Date;
    }>(
      `SELECT "skuId", "productId", "colorId", "sizeId", "code", "optionName", "position", "isActive", "createdAt"
       FROM "productSkus" WHERE "productId" = $1 ORDER BY "position", "skuId"`,
      [FIXTURE.productId],
    );

    const response = await updatePublishedProductSkus(accessToken, FIXTURE.productId, [
      { skuId: publishedSkuId, price: 0, stock: 100 },
      { skuId: FIXTURE.skuId, price: 9000, stock: 2 },
    ]);

    expect(response.body.errors).toBeUndefined();
    expect(response.body.data.updatePublishedProductSkus.skus.map(({ skuId }: { skuId: string }) => skuId)).toEqual([
      FIXTURE.skuId,
      publishedSkuId,
    ]);
    const afterProduct = await pool.query(
      `SELECT "productId", "partnerId", "brandId", "categoryId", "title", "description", "imageKeys", "imageUrls",
              "status", "approvalStatus", "rejectionReason", "isOnSale", "isExpressDelivery", "publishedAt", "createdAt", "updatedAt"
       FROM "products" WHERE "productId" = $1`,
      [FIXTURE.productId],
    );
    const afterSkus = await pool.query<{
      skuId: string;
      productId: string;
      colorId: string | null;
      sizeId: string | null;
      code: string;
      optionName: string;
      price: number;
      stock: number;
      position: number;
      isActive: boolean;
      createdAt: Date;
      updatedAt: Date;
    }>(
      `SELECT "skuId", "productId", "colorId", "sizeId", "code", "optionName", "price", "stock", "position",
              "isActive", "createdAt", "updatedAt"
       FROM "productSkus" WHERE "productId" = $1 ORDER BY "position", "skuId"`,
      [FIXTURE.productId],
    );
    expect(afterProduct.rows).toEqual(beforeProduct.rows);
    expect(afterSkus.rows.map(({ price: _price, stock: _stock, updatedAt: _updatedAt, ...sku }) => sku)).toEqual(
      beforeSkus.rows,
    );
    expect(afterSkus.rows.map(({ skuId, price, stock }) => ({ skuId, price, stock }))).toEqual([
      { skuId: FIXTURE.skuId, price: 9000, stock: 2 },
      { skuId: publishedSkuId, price: 0, stock: 100 },
    ]);
    expect(new Set(afterSkus.rows.map(({ updatedAt }) => updatedAt.toISOString())).size).toBe(1);
    const notifications = await pool.query<{ userId: string; type: string }>(
      `SELECT "userId", "type" FROM "notifications" WHERE "entityId" = $1 ORDER BY "userId", "type"`,
      [FIXTURE.productId],
    );
    expect(notifications.rows).toEqual(
      wishUserIds.flatMap((userId) => [
        { userId, type: "WISH_PRICE_DROP" },
        { userId, type: "WISH_RESTOCK" },
      ]),
    );
  });

  it("does not notify for equal or increased minimum prices and other stock transitions", async () => {
    await seedWishers();
    const accessToken = await signin();
    const updates = [
      { skuId: FIXTURE.skuId, price: 15000, stock: 6 },
      { skuId: FIXTURE.skuId, price: 16000, stock: 0 },
      { skuId: FIXTURE.skuId, price: 16000, stock: 0 },
    ];
    for (const sku of updates) {
      const response = await updatePublishedProductSkus(accessToken, FIXTURE.productId, [sku]);
      expect(response.body.errors).toBeUndefined();
    }
    const notifications = await pool.query(`SELECT 1 FROM "notifications" WHERE "entityId" = $1`, [FIXTURE.productId]);
    expect(notifications.rowCount).toBe(0);
  });

  it("deduplicates concurrent and retried identical published SKU saves", async () => {
    await pool.query(`UPDATE "productSkus" SET "stock" = 0 WHERE "skuId" = $1`, [FIXTURE.skuId]);
    await seedWishers();
    const accessToken = await signin();
    const skus = [{ skuId: FIXTURE.skuId, price: 9000, stock: 2 }];

    const concurrent = await Promise.all([
      updatePublishedProductSkus(accessToken, FIXTURE.productId, skus),
      updatePublishedProductSkus(accessToken, FIXTURE.productId, skus),
    ]);
    for (const response of concurrent) expect(response.body.errors).toBeUndefined();
    const retried = await updatePublishedProductSkus(accessToken, FIXTURE.productId, skus);
    expect(retried.body.errors).toBeUndefined();

    const notifications = await pool.query<{ count: number; type: string; userId: string }>(
      `SELECT count(*)::int AS "count", "type", "userId"
       FROM "notifications" WHERE "entityId" = $1 GROUP BY "type", "userId" ORDER BY "userId", "type"`,
      [FIXTURE.productId],
    );
    expect(notifications.rows).toEqual(
      wishUserIds.flatMap((userId) => [
        { count: 1, type: "WISH_PRICE_DROP", userId },
        { count: 1, type: "WISH_RESTOCK", userId },
      ]),
    );
  });

  it("rolls SKU and notification writes back together", async () => {
    await pool.query(`UPDATE "productSkus" SET "stock" = 0 WHERE "skuId" = $1`, [FIXTURE.skuId]);
    await seedWishers();
    const beforeSku = await pool.query(`SELECT "price", "stock", "updatedAt" FROM "productSkus" WHERE "skuId" = $1`, [
      FIXTURE.skuId,
    ]);
    const beforeSnapshot = await pool.query(
      `SELECT "revision", "basePrice", "finalPrice", "recordedAt", "verifiedAt"
       FROM "productPriceEvidenceSnapshots" WHERE "productId" = $1`,
      [FIXTURE.productId],
    );
    const notificationService = app.get(NotificationService);
    const createWishPriceDrop = notificationService.createWishPriceDrop;
    jest.spyOn(notificationService, "createWishPriceDrop").mockImplementation(async (tx, input) => {
      await createWishPriceDrop(tx, input);
      throw new Error("forced notification failure");
    });
    const service = app.get(PartnerService) as unknown as {
      updatePublishedProductSkus: (
        ownerUserId: string,
        input: { productId: string; skus: { skuId: string; price: number; stock: number }[] },
      ) => Promise<unknown>;
    };

    await expect(
      service.updatePublishedProductSkus(FIXTURE.userId, {
        productId: FIXTURE.productId,
        skus: [{ skuId: FIXTURE.skuId, price: 9000, stock: 2 }],
      }),
    ).rejects.toThrow("forced notification failure");

    const afterSku = await pool.query(`SELECT "price", "stock", "updatedAt" FROM "productSkus" WHERE "skuId" = $1`, [
      FIXTURE.skuId,
    ]);
    const afterSnapshot = await pool.query(
      `SELECT "revision", "basePrice", "finalPrice", "recordedAt", "verifiedAt"
       FROM "productPriceEvidenceSnapshots" WHERE "productId" = $1`,
      [FIXTURE.productId],
    );
    const notifications = await pool.query(`SELECT 1 FROM "notifications" WHERE "entityId" = $1`, [FIXTURE.productId]);
    expect(afterSku.rows).toEqual(beforeSku.rows);
    expect(afterSnapshot.rows).toEqual(beforeSnapshot.rows);
    expect(notifications.rowCount).toBe(0);
  });

  it("rolls back the email proof when a partner application cannot be stored", async () => {
    const ownerUserId = "12000000-0000-4000-8000-000000000001";
    const verificationId = "b2000000-0000-4000-8000-000000000001";
    const businessEmail = "rollback-partner@example.test";
    const token = "rollback-partner-proof";
    await pool.query(
      `INSERT INTO "users" ("userId", "userid", "email", "password", "role")
       VALUES ($1, 'rollback-partner', 'rollback-owner@example.test', 'unused', 'USER')`,
      [ownerUserId],
    );
    await seedEmailProof(pool, verificationId, businessEmail, token);

    await expect(
      app.get(PartnerService).apply(ownerUserId, {
        businessEmail,
        businessEmailVerificationToken: token,
        businessRegistrationNumber: "3000000000",
        tradeName: " ",
      }),
    ).rejects.toThrow("Invalid partner application input");
    await expect(
      app.get(PartnerService).apply(ownerUserId, {
        businessEmail,
        businessEmailVerificationToken: token,
        businessRegistrationNumber: "1000000000",
        tradeName: "Rollback Partner",
      }),
    ).rejects.toThrow("Partner application already exists");

    const state = await pool.query<{ activities: number; partners: number; usedAt: Date | null }>(
      `SELECT
         (SELECT count(*)::int FROM "partners" WHERE "ownerUserId" = $1) AS partners,
         (SELECT "usedAt" FROM "emailVerificationToken" WHERE "tokenHash" = $2) AS "usedAt",
         (SELECT count(*)::int FROM "activityEvents" WHERE "actorUserId" = $1) AS activities`,
      [ownerUserId, hashToken(token)],
    );
    expect(state.rows[0]).toEqual({ activities: 0, partners: 0, usedAt: null });
  });

  it("stores one application and consumes one proof under concurrent owner requests", async () => {
    const ownerUserId = "12000000-0000-4000-8000-000000000002";
    const attempts = [
      {
        businessEmail: "concurrent-partner-a@example.test",
        businessRegistrationNumber: "3000000001",
        token: "concurrent-partner-proof-a",
        verificationId: "b2000000-0000-4000-8000-000000000002",
      },
      {
        businessEmail: "concurrent-partner-b@example.test",
        businessRegistrationNumber: "3000000002",
        token: "concurrent-partner-proof-b",
        verificationId: "b2000000-0000-4000-8000-000000000003",
      },
    ] as const;
    await pool.query(
      `INSERT INTO "users" ("userId", "userid", "email", "password", "role")
       VALUES ($1, 'concurrent-partner', 'concurrent-owner@example.test', 'unused', 'USER')`,
      [ownerUserId],
    );
    await Promise.all(
      attempts.map(({ businessEmail, token, verificationId }) =>
        seedEmailProof(pool, verificationId, businessEmail, token),
      ),
    );

    const results = await Promise.allSettled(
      attempts.map(({ businessEmail, businessRegistrationNumber, token }, index) =>
        app.get(PartnerService).apply(ownerUserId, {
          businessEmail,
          businessEmailVerificationToken: token,
          businessRegistrationNumber,
          tradeName: `Concurrent Partner ${index + 1}`,
        }),
      ),
    );
    expect(results.map(({ status }) => status).sort()).toEqual(["fulfilled", "rejected"]);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ reason: { message: "Partner application already exists" } });

    const state = await pool.query<{ activities: number; partners: number; usedProofs: number }>(
      `SELECT
         (SELECT count(*)::int FROM "partners" WHERE "ownerUserId" = $1) AS partners,
         (SELECT count(*)::int FROM "emailVerificationToken" WHERE "email" = ANY($2) AND "usedAt" IS NOT NULL) AS "usedProofs",
         (SELECT count(*)::int FROM "activityEvents" WHERE "actorUserId" = $1) AS activities`,
      [ownerUserId, attempts.map(({ businessEmail }) => businessEmail)],
    );
    expect(state.rows[0]).toEqual({ activities: 1, partners: 1, usedProofs: 1 });
  });

  it("searches titles and SKU codes and keeps cursor counts stable", async () => {
    const accessToken = await signin();
    const query = `query PartnerProducts($filter: PartnerProductFilterInput) {
      myPartnerProducts(filter: $filter) {
        nodes { productId title }
        nextCursor
        hasNextPage
        totalCount
      }
    }`;
    const title = await graphql(accessToken, query, { filter: { query: "Sale Tee" } });
    const sku = await graphql(accessToken, query, { filter: { query: "INTEGRATION-SHOES-M" } });
    const first = await graphql(accessToken, query, { filter: { first: 1 } });
    const second = await graphql(accessToken, query, {
      filter: { first: 1, after: first.body.data.myPartnerProducts.nextCursor },
    });

    expect(title.body.data.myPartnerProducts.nodes.map(({ productId }: { productId: string }) => productId)).toEqual([
      FIXTURE.productId,
    ]);
    expect(sku.body.data.myPartnerProducts.nodes.map(({ productId }: { productId: string }) => productId)).toEqual([
      FIXTURE.secondProductId,
    ]);
    expect(first.body.data.myPartnerProducts).toMatchObject({ hasNextPage: true, totalCount: 2 });
    expect(second.body.data.myPartnerProducts.totalCount).toBe(2);
    expect(second.body.data.myPartnerProducts.nodes[0].productId).not.toBe(
      first.body.data.myPartnerProducts.nodes[0].productId,
    );
  });

  it("stores only the promoted immutable product image key", async () => {
    const accessToken = await signin();
    const created = await graphql(
      accessToken,
      `
        mutation CreatePartnerProduct($input: PartnerProductInput!) {
          createPartnerProductDraft(input: $input) {
            productId
            imageKeys
          }
        }
      `,
      { input: { ...input(), imageKeys: [pendingImageKey] } },
    );

    expect(created.body.errors).toBeUndefined();
    const imageKeys = created.body.data.createPartnerProductDraft.imageKeys as string[];
    expect(imageKeys).toHaveLength(1);
    expect(imageKeys[0]).toMatch(/^products\/10000000-0000-4000-8000-000000000001\/[0-9a-f]{64}\.png$/);
    expect(imageKeys[0]).not.toBe(pendingImageKey);
    const stored = await pool.query<{ imageKeys: string[] }>(
      `SELECT "imageKeys" FROM "products" WHERE "productId" = $1`,
      [created.body.data.createPartnerProductDraft.productId],
    );
    expect(stored.rows[0]?.imageKeys).toEqual(imageKeys);
    const references = await pool.query<{ finalKey: string; status: string }>(
      `SELECT r."finalKey", p."status"
       FROM "mediaObjectReferences" r
       JOIN "mediaObjectPromotions" p ON p."finalKey" = r."finalKey"
       WHERE r."entityType" = 'PRODUCT' AND r."entityId" = $1`,
      [created.body.data.createPartnerProductDraft.productId],
    );
    expect(references.rows).toEqual([{ finalKey: imageKeys[0], status: "READY" }]);
  });

  it("preserves SKU order through the complete product lifecycle", async () => {
    const accessToken = await signin();
    const create = await graphql(
      accessToken,
      `
        mutation CreatePartnerProduct($input: PartnerProductInput!) {
          createPartnerProductDraft(input: $input) {
            productId
            status
            approvalStatus
            skus {
              code
            }
          }
        }
      `,
      { input: input() },
    );
    expect(create.body.errors).toBeUndefined();
    expect(create.body.data.createPartnerProductDraft.skus.map(({ code }: { code: string }) => code)).toEqual([
      "PARTNER-SKU-A",
      "PARTNER-SKU-B",
    ]);
    const productId = create.body.data.createPartnerProductDraft.productId as string;
    const draftSnapshot = await pool.query(`SELECT 1 FROM "productPriceEvidenceSnapshots" WHERE "productId" = $1`, [
      productId,
    ]);
    expect(draftSnapshot.rowCount).toBe(0);
    const reversed = input(["PARTNER-SKU-B", "PARTNER-SKU-A"]);
    const updateMutation = `mutation UpdatePartnerProduct($productId: String!, $input: PartnerProductInput!) {
      updatePartnerProductDraft(productId: $productId, input: $input) {
        productId
        approvalStatus
        rejectionReason
        skus { code }
      }
    }`;
    const updated = await graphql(accessToken, updateMutation, { productId, input: reversed });
    expect(updated.body.data.updatePartnerProductDraft.skus.map(({ code }: { code: string }) => code)).toEqual([
      "PARTNER-SKU-B",
      "PARTNER-SKU-A",
    ]);

    const submitMutation = `mutation SubmitPartnerProduct($productId: String!) {
      submitPartnerProductForReview(productId: $productId) { approvalStatus }
    }`;
    const publishMutation = `mutation PublishPartnerProduct($productId: String!) {
      publishPartnerProduct(productId: $productId) { status approvalStatus skus { code } }
    }`;
    const submitted = await graphql(accessToken, submitMutation, { productId });
    expect(submitted.body.data.submitPartnerProductForReview.approvalStatus).toBe("PENDING");
    const pendingUpdate = await graphql(accessToken, updateMutation, { productId, input: reversed });
    const pendingPublish = await graphql(accessToken, publishMutation, { productId });
    expect(pendingUpdate.body.errors[0].extensions.code).toBe("BAD_USER_INPUT");
    expect(pendingPublish.body.errors[0].extensions.code).toBe("BAD_USER_INPUT");

    await pool.query(
      `UPDATE "products" SET "approvalStatus" = 'REJECTED', "rejectionReason" = 'Add detail' WHERE "productId" = $1`,
      [productId],
    );
    const rejectedUpdate = await graphql(accessToken, updateMutation, { productId, input: reversed });
    expect(rejectedUpdate.body.data.updatePartnerProductDraft).toMatchObject({
      approvalStatus: "DRAFT",
      rejectionReason: null,
    });

    await pool.query(`UPDATE "products" SET "approvalStatus" = 'APPROVED' WHERE "productId" = $1`, [productId]);
    const approvedUpdate = await graphql(accessToken, updateMutation, { productId, input: reversed });
    const approvedSubmit = await graphql(accessToken, submitMutation, { productId });
    expect(approvedUpdate.body.errors[0].extensions.code).toBe("BAD_USER_INPUT");
    expect(approvedSubmit.body.errors[0].extensions.code).toBe("BAD_USER_INPUT");

    const published = await graphql(accessToken, publishMutation, { productId });
    expect(published.body.data.publishPartnerProduct).toMatchObject({
      status: "PUBLISHED",
      approvalStatus: "APPROVED",
    });
    const publishedSnapshot = await pool.query<{ basePrice: number; finalPrice: number; revision: string }>(
      `SELECT "basePrice", "finalPrice", "revision"
       FROM "productPriceEvidenceSnapshots"
       WHERE "productId" = $1`,
      [productId],
    );
    expect(publishedSnapshot.rows).toEqual([{ basePrice: 10001, finalPrice: 10000, revision: expect.any(String) }]);
    const publicProduct = await request(app.getHttpServer())
      .post("/graphql")
      .send({
        query: `query Product($productId: String!) {
          product(productId: $productId) { productId skus { code } }
        }`,
        variables: { productId },
      })
      .expect(200);
    expect(publicProduct.body.data.product.skus.map(({ code }: { code: string }) => code)).toEqual([
      "PARTNER-SKU-B",
      "PARTNER-SKU-A",
    ]);

    const publishedUpdate = await graphql(accessToken, updateMutation, { productId, input: reversed });
    const publishedSubmit = await graphql(accessToken, submitMutation, { productId });
    const repeatedPublish = await graphql(accessToken, publishMutation, { productId });
    expect(publishedUpdate.body.errors[0].extensions.code).toBe("BAD_USER_INPUT");
    expect(publishedSubmit.body.errors[0].extensions.code).toBe("BAD_USER_INPUT");
    expect(repeatedPublish.body.errors[0].extensions.code).toBe("BAD_USER_INPUT");
  });

  it("blocks partner publishing when no active SKU exists", async () => {
    const accessToken = await signin();
    const create = await graphql(
      accessToken,
      `
        mutation CreatePartnerProduct($input: PartnerProductInput!) {
          createPartnerProductDraft(input: $input) {
            productId
          }
        }
      `,
      { input: input(["PARTNER-INACTIVE-SKU"]) },
    );
    const productId = create.body.data.createPartnerProductDraft.productId as string;
    await pool.query(`UPDATE "products" SET "approvalStatus" = 'APPROVED' WHERE "productId" = $1`, [productId]);
    await pool.query(`UPDATE "productSkus" SET "isActive" = false WHERE "productId" = $1`, [productId]);

    const publish = await graphql(
      accessToken,
      `
        mutation PublishPartnerProduct($productId: String!) {
          publishPartnerProduct(productId: $productId) {
            status
          }
        }
      `,
      { productId },
    );
    expect(publish.body.errors[0].extensions.code).toBe("BAD_USER_INPUT");
    const product = await pool.query<{ status: string }>(`SELECT "status" FROM "products" WHERE "productId" = $1`, [
      productId,
    ]);
    expect(product.rows).toEqual([{ status: "DRAFT" }]);
  });

  it("prevents cross-partner reads, counts, and mutations", async () => {
    const otherUserId = "11000000-0000-4000-8000-000000000099";
    const otherBrandId = "41000000-0000-4000-8000-000000000099";
    const otherPartnerId = "21000000-0000-4000-8000-000000000099";
    const otherProductId = "71000000-0000-4000-8000-000000000099";
    const otherSkuId = "81000000-0000-4000-8000-000000000099";
    await pool.query(
      `INSERT INTO "users" ("userId", "userid", "email", "password", "role")
       VALUES ($1, 'other-partner', 'other-partner@example.test', 'unused', 'PARTNER')`,
      [otherUserId],
    );
    await pool.query(`INSERT INTO "brands" ("brandId", "name", "slug") VALUES ($1, 'Other Brand', 'other-brand')`, [
      otherBrandId,
    ]);
    await pool.query(
      `INSERT INTO "partners"
        ("partnerId", "ownerUserId", "businessEmail", "businessRegistrationNumber", "tradeName", "brandId", "status")
       VALUES ($1, $2, 'other-business@example.test', '9999999999', 'Other Partner', $3, 'APPROVED')`,
      [otherPartnerId, otherUserId, otherBrandId],
    );
    await pool.query(
      `INSERT INTO "products"
        ("productId", "partnerId", "brandId", "categoryId", "title", "description", "imageKeys", "imageUrls", "status", "approvalStatus")
       VALUES ($1, $2, $3, $4, 'Other product', 'Other description', '{}', '[]', 'PUBLISHED', 'APPROVED')`,
      [otherProductId, otherPartnerId, otherBrandId, FIXTURE.categoryId],
    );
    await pool.query(
      `INSERT INTO "productSkus" ("skuId", "productId", "code", "optionName", "price", "stock", "position")
       VALUES ($1, $2, 'OTHER-SKU', 'Other option', 1000, 1, 0)`,
      [otherSkuId, otherProductId],
    );

    const accessToken = await signin();
    const products = await graphql(
      accessToken,
      `
        query {
          myPartnerProducts {
            nodes {
              productId
            }
            totalCount
          }
        }
      `,
    );
    const dashboard = await graphql(
      accessToken,
      `
        query {
          myPartnerDashboard {
            draftCount
            pendingCount
            rejectedCount
            approvedCount
            publishedCount
          }
        }
      `,
    );
    expect(products.body.data.myPartnerProducts.totalCount).toBe(2);
    expect(products.body.data.myPartnerProducts.nodes).not.toContainEqual({ productId: otherProductId });
    expect(dashboard.body.data.myPartnerDashboard).toMatchObject({
      draftCount: 0,
      pendingCount: 0,
      rejectedCount: 0,
      approvedCount: 0,
      publishedCount: 2,
    });

    const detail = await graphql(
      accessToken,
      `
        query Product($productId: String!) {
          myPartnerProduct(productId: $productId) {
            productId
          }
        }
      `,
      { productId: otherProductId },
    );
    const update = await graphql(
      accessToken,
      `
        mutation Update($productId: String!, $input: PartnerProductInput!) {
          updatePartnerProductDraft(productId: $productId, input: $input) {
            productId
          }
        }
      `,
      { productId: otherProductId, input: input() },
    );
    const submit = await graphql(
      accessToken,
      `
        mutation Submit($productId: String!) {
          submitPartnerProductForReview(productId: $productId) {
            productId
          }
        }
      `,
      { productId: otherProductId },
    );
    const publish = await graphql(
      accessToken,
      `
        mutation Publish($productId: String!) {
          publishPartnerProduct(productId: $productId) {
            productId
          }
        }
      `,
      { productId: otherProductId },
    );
    const publishedSkuUpdate = await updatePublishedProductSkus(accessToken, otherProductId, [
      { skuId: otherSkuId, price: 900, stock: 2 },
    ]);
    expect(detail.body.errors[0].extensions.code).toBe("NOT_FOUND");
    expect(update.body.errors[0].extensions.code).toBe("BAD_USER_INPUT");
    expect(submit.body.errors[0].extensions.code).toBe("BAD_USER_INPUT");
    expect(publish.body.errors[0].extensions.code).toBe("BAD_USER_INPUT");
    expect(publishedSkuUpdate.body.errors[0].extensions.code).toBe("BAD_USER_INPUT");
  });

  it("keeps state unchanged when submitted image objects are missing", async () => {
    const submitProductId = "72000000-0000-4000-8000-000000000001";
    const publishProductId = "72000000-0000-4000-8000-000000000002";
    const submitKey = "products/10000000-0000-4000-8000-000000000001/92000000-0000-4000-8000-000000000001.png";
    const publishKey = "products/10000000-0000-4000-8000-000000000001/92000000-0000-4000-8000-000000000002.png";
    await pool.query(
      `INSERT INTO "products"
        ("productId", "partnerId", "brandId", "categoryId", "title", "description", "imageKeys", "imageUrls", "approvalStatus")
       VALUES
        ($1, $3, $4, $5, 'Missing submit image', 'Missing object', $6, '[]', 'DRAFT'),
        ($2, $3, $4, $5, 'Missing publish image', 'Missing object', $7, '[]', 'APPROVED')`,
      [
        submitProductId,
        publishProductId,
        FIXTURE.partnerId,
        FIXTURE.brandId,
        FIXTURE.categoryId,
        [submitKey],
        [publishKey],
      ],
    );
    await pool.query(
      `INSERT INTO "productSkus" ("productId", "code", "optionName", "price", "stock", "position")
       VALUES ($1, 'MISSING-SUBMIT', 'Submit', 1000, 1, 0), ($2, 'MISSING-PUBLISH', 'Publish', 1000, 1, 0)`,
      [submitProductId, publishProductId],
    );
    jest.restoreAllMocks();
    jest
      .spyOn(S3Client.prototype, "send")
      .mockRejectedValue(Object.assign(new Error("missing"), { $metadata: { httpStatusCode: 404 } }) as never);

    const accessToken = await signin();
    const submit = await graphql(
      accessToken,
      `
        mutation Submit($productId: String!) {
          submitPartnerProductForReview(productId: $productId) {
            approvalStatus
          }
        }
      `,
      { productId: submitProductId },
    );
    const publish = await graphql(
      accessToken,
      `
        mutation Publish($productId: String!) {
          publishPartnerProduct(productId: $productId) {
            status
          }
        }
      `,
      { productId: publishProductId },
    );
    expect(submit.body.errors[0].extensions.code).toBe("BAD_USER_INPUT");
    expect(publish.body.errors[0].extensions.code).toBe("BAD_USER_INPUT");
    const states = await pool.query<{ productId: string; status: string; approvalStatus: string }>(
      `SELECT "productId", "status", "approvalStatus" FROM "products"
       WHERE "productId" IN ($1, $2) ORDER BY "productId"`,
      [submitProductId, publishProductId],
    );
    expect(states.rows).toEqual([
      { productId: submitProductId, status: "DRAFT", approvalStatus: "DRAFT" },
      { productId: publishProductId, status: "DRAFT", approvalStatus: "APPROVED" },
    ]);
  });
});
