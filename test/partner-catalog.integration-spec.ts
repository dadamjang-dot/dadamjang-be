import { S3Client } from "@aws-sdk/client-s3";
import type { INestApplication } from "@nestjs/common";
import type { Pool } from "pg";
import request from "supertest";
import { createApp } from "src/app";
import { FIXTURE } from "src/database/fixtures";
import { resetTestFixtures, testPool } from "./support/database";

const validImageKey = "products/10000000-0000-4000-8000-000000000001/90000000-0000-4000-8000-000000000001.png";

describe("partner catalog GraphQL integration", () => {
  let app: INestApplication;
  let pool: Pool;

  const graphql = async (accessToken: string, query: string, variables: Record<string, unknown> = {}) =>
    request(app.getHttpServer())
      .post("/graphql")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ query, variables })
      .expect(200);

  const signin = async () => {
    const response = await request(app.getHttpServer())
      .post("/graphql")
      .set("x-device-id", "partner-integration-device")
      .send({
        query: `mutation Signin($input: SigninAuthInput!) {
          signin(input: $input) { accessToken }
        }`,
        variables: {
          input: { userid: FIXTURE.userid, password: FIXTURE.password, portal: "Partner" },
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

  beforeAll(async () => {
    pool = testPool();
    app = await createApp();
    await app.init();
  });

  beforeEach(async () => {
    await resetTestFixtures(pool);
    await pool.query(`UPDATE "users" SET "role" = 'PARTNER' WHERE "userId" = $1`, [FIXTURE.userId]);
    jest
      .spyOn(S3Client.prototype, "send")
      .mockResolvedValue({ ContentType: "image/png", ContentLength: 1024 } as never);
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await app.close();
    await pool.end();
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
        ("productId", "partnerId", "brandId", "categoryId", "title", "description", "imageKeys", "imageUrls")
       VALUES ($1, $2, $3, $4, 'Other product', 'Other description', '{}', '[]')`,
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
    expect(detail.body.errors[0].extensions.code).toBe("NOT_FOUND");
    expect(update.body.errors[0].extensions.code).toBe("BAD_USER_INPUT");
    expect(submit.body.errors[0].extensions.code).toBe("BAD_USER_INPUT");
    expect(publish.body.errors[0].extensions.code).toBe("BAD_USER_INPUT");
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
