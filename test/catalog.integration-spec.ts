import type { INestApplication } from "@nestjs/common";
import type { Pool } from "pg";
import request from "supertest";
import { createApp } from "src/app";
import { FIXTURE } from "src/database/fixtures";
import { resetTestFixtures, testPool } from "./support/database";

const CURSOR_PRODUCTS = {
  first: "72000000-0000-4000-8000-000000000011",
  second: "72000000-0000-4000-8000-000000000012",
  third: "72000000-0000-4000-8000-000000000013",
  fourth: "72000000-0000-4000-8000-000000000014",
} as const;

describe("catalog PostgreSQL integration", () => {
  let app: INestApplication;
  let pool: Pool;

  const products = async (filter: Record<string, unknown>) =>
    request(app.getHttpServer())
      .post("/graphql")
      .send({
        query: `query Products($filter: ProductFilterInput) {
          products(filter: $filter) {
            nodes { productId skus { skuId price } }
            nextCursor
            hasNextPage
            totalCount
          }
        }`,
        variables: { filter },
      })
      .expect(200);

  beforeAll(async () => {
    pool = testPool();
    app = await createApp();
    await app.init();
  });

  beforeEach(async () => {
    await resetTestFixtures(pool);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it.each([
    ["RECOMMENDED", [CURSOR_PRODUCTS.second, CURSOR_PRODUCTS.first, CURSOR_PRODUCTS.third, CURSOR_PRODUCTS.fourth]],
    ["LATEST", [CURSOR_PRODUCTS.second, CURSOR_PRODUCTS.first, CURSOR_PRODUCTS.third, CURSOR_PRODUCTS.fourth]],
    ["LOW_PRICE", [CURSOR_PRODUCTS.fourth, CURSOR_PRODUCTS.second, CURSOR_PRODUCTS.first, CURSOR_PRODUCTS.third]],
    ["HIGH_PRICE", [CURSOR_PRODUCTS.third, CURSOR_PRODUCTS.second, CURSOR_PRODUCTS.first, CURSOR_PRODUCTS.fourth]],
    ["POPULAR", [CURSOR_PRODUCTS.third, CURSOR_PRODUCTS.second, CURSOR_PRODUCTS.first, CURSOR_PRODUCTS.fourth]],
  ])("keeps %s stable across cursor boundaries", async (sort, expected) => {
    await pool.query(
      `INSERT INTO "products"
        ("productId", "partnerId", "brandId", "categoryId", "title", "description", "status", "approvalStatus", "createdAt")
       VALUES
        ($1, $5, $6, $7, 'Catalog Cursor A', 'Cursor fixture', 'PUBLISHED', 'APPROVED', '2026-08-10T00:00:00Z'),
        ($2, $5, $6, $7, 'Catalog Cursor B', 'Cursor fixture', 'PUBLISHED', 'APPROVED', '2026-08-10T00:00:00Z'),
        ($3, $5, $6, $7, 'Catalog Cursor C', 'Cursor fixture', 'PUBLISHED', 'APPROVED', '2026-08-09T00:00:00.000900Z'),
        ($4, $5, $6, $7, 'Catalog Cursor D', 'Cursor fixture', 'PUBLISHED', 'APPROVED', '2026-08-09T00:00:00.000100Z')`,
      [
        CURSOR_PRODUCTS.first,
        CURSOR_PRODUCTS.second,
        CURSOR_PRODUCTS.third,
        CURSOR_PRODUCTS.fourth,
        FIXTURE.partnerId,
        FIXTURE.brandId,
        FIXTURE.categoryId,
      ],
    );
    await pool.query(
      `INSERT INTO "productSkus"
        ("skuId", "productId", "code", "optionName", "price", "stock", "position")
       VALUES
        ('82000000-0000-4000-8000-000000000011', $1, 'CURSOR-A', 'A', 100, 10, 0),
        ('82000000-0000-4000-8000-000000000012', $2, 'CURSOR-B', 'B', 100, 10, 0),
        ('82000000-0000-4000-8000-000000000013', $3, 'CURSOR-C', 'C', 200, 30, 0),
        ('82000000-0000-4000-8000-000000000014', $4, 'CURSOR-D', 'D', 50, 5, 0)`,
      [CURSOR_PRODUCTS.first, CURSOR_PRODUCTS.second, CURSOR_PRODUCTS.third, CURSOR_PRODUCTS.fourth],
    );

    const productIds: string[] = [];
    let after: string | undefined;
    for (let page = 0; page < expected.length; page += 1) {
      const response = await products({ query: "Catalog Cursor", sort, first: 1, after });
      const connection = response.body.data.products;
      expect(response.body.errors).toBeUndefined();
      expect(connection.totalCount).toBe(4);
      expect(connection.nodes).toHaveLength(1);
      expect(connection.hasNextPage).toBe(page < expected.length - 1);
      productIds.push(connection.nodes[0].productId);
      after = connection.nextCursor ?? undefined;
    }

    expect(productIds).toEqual(expected);
  });

  it("applies category, brand, sale, express, and title filters", async () => {
    const category = await products({ categoryId: FIXTURE.secondCategoryId, first: 10 });
    const categories = await products({
      categoryIds: [FIXTURE.categoryId, FIXTURE.secondCategoryId],
      first: 10,
    });
    const flags = await products({
      query: "Integration",
      categoryIds: [FIXTURE.categoryId, FIXTURE.secondCategoryId],
      brandIds: [FIXTURE.brandId],
      saleOnly: true,
      expressOnly: true,
      first: 10,
    });

    expect(category.body.data.products).toMatchObject({
      totalCount: 1,
      nodes: [{ productId: FIXTURE.secondProductId }],
    });
    expect(categories.body.data.products).toMatchObject({
      totalCount: 2,
      nodes: [{ productId: FIXTURE.productId }, { productId: FIXTURE.secondProductId }],
    });
    expect(flags.body.data.products).toMatchObject({
      totalCount: 1,
      nodes: [{ productId: FIXTURE.productId }],
    });
  });

  it("requires selected color and size on the same active SKU and filters the active minimum price", async () => {
    const secondColorId = "50000000-0000-4000-8000-000000000002";
    const secondSizeId = "60000000-0000-4000-8000-000000000002";
    const matchingProductId = "73000000-0000-4000-8000-000000000001";
    await pool.query(`INSERT INTO "colors" ("colorId", "name", "slug") VALUES ($1, 'White', 'catalog-filter-white')`, [
      secondColorId,
    ]);
    await pool.query(`INSERT INTO "sizes" ("sizeId", "name", "slug") VALUES ($1, 'Large', 'catalog-filter-large')`, [
      secondSizeId,
    ]);
    await pool.query(
      `INSERT INTO "products"
        ("productId", "partnerId", "brandId", "categoryId", "title", "description", "status", "approvalStatus", "createdAt")
       VALUES
        ($1, $5, $6, $7, 'Catalog SKU Match', 'SKU fixture', 'PUBLISHED', 'APPROVED', '2026-08-10T00:00:00Z'),
        ($2, $5, $6, $7, 'Catalog SKU Split', 'SKU fixture', 'PUBLISHED', 'APPROVED', '2026-08-09T00:00:00Z'),
        ($3, $5, $6, $7, 'Catalog SKU Inactive', 'SKU fixture', 'PUBLISHED', 'APPROVED', '2026-08-08T00:00:00Z'),
        ($4, $5, $6, $7, 'Catalog SKU Low', 'SKU fixture', 'PUBLISHED', 'APPROVED', '2026-08-07T00:00:00Z')`,
      [
        matchingProductId,
        "73000000-0000-4000-8000-000000000002",
        "73000000-0000-4000-8000-000000000003",
        "73000000-0000-4000-8000-000000000004",
        FIXTURE.partnerId,
        FIXTURE.brandId,
        FIXTURE.categoryId,
      ],
    );
    await pool.query(
      `INSERT INTO "productSkus"
        ("skuId", "productId", "code", "colorId", "sizeId", "optionName", "price", "stock", "position", "isActive")
       VALUES
        ('83000000-0000-4000-8000-000000000001', $1, 'FILTER-MATCH', $5, $6, 'Match', 100, 1, 0, true),
        ('83000000-0000-4000-8000-000000000002', $1, 'FILTER-INACTIVE-CHEAP', $7, $8, 'Inactive cheap', 10, 1, 1, false),
        ('83000000-0000-4000-8000-000000000003', $2, 'FILTER-SPLIT-COLOR', $5, $8, 'Split color', 100, 1, 0, true),
        ('83000000-0000-4000-8000-000000000004', $2, 'FILTER-SPLIT-SIZE', $7, $6, 'Split size', 100, 1, 1, true),
        ('83000000-0000-4000-8000-000000000005', $3, 'FILTER-INACTIVE-MATCH', $5, $6, 'Inactive match', 100, 1, 0, false),
        ('83000000-0000-4000-8000-000000000006', $3, 'FILTER-INACTIVE-ACTIVE', $7, $8, 'Active mismatch', 100, 1, 1, true),
        ('83000000-0000-4000-8000-000000000007', $4, 'FILTER-LOW', $5, $6, 'Low', 50, 1, 0, true)`,
      [
        matchingProductId,
        "73000000-0000-4000-8000-000000000002",
        "73000000-0000-4000-8000-000000000003",
        "73000000-0000-4000-8000-000000000004",
        FIXTURE.colorId,
        FIXTURE.sizeId,
        secondColorId,
        secondSizeId,
      ],
    );

    const response = await products({
      query: "Catalog SKU",
      colorIds: [FIXTURE.colorId],
      sizeIds: [FIXTURE.sizeId],
      minPrice: 100,
      maxPrice: 100,
      sort: "LOW_PRICE",
      first: 10,
    });

    expect(response.body.errors).toBeUndefined();
    expect(response.body.data.products).toMatchObject({
      totalCount: 1,
      hasNextPage: false,
      nodes: [{ productId: matchingProductId, skus: [{ price: 100 }] }],
    });
  });
});
