import type { INestApplication } from "@nestjs/common";
import type { Pool } from "pg";
import request from "supertest";
import { createApp } from "src/app";
import { FIXTURE } from "src/database/fixtures";
import { decodeProductCursor } from "src/modules/catalog/catalog.service";
import { ProductSort } from "src/modules/catalog/catalog.types";
import { type Database, DRIZZLE } from "src/modules/database/database.module";
import { resetTestFixtures, testPool } from "./support/database";

const CURSOR_PRODUCTS = {
  first: "72000000-0000-4000-8000-000000000011",
  second: "72000000-0000-4000-8000-000000000012",
  third: "72000000-0000-4000-8000-000000000013",
  fourth: "72000000-0000-4000-8000-000000000014",
} as const;

const queryText = (query: unknown) => {
  if (typeof query === "string") return query;
  if (typeof query === "object" && query !== null && "text" in query && typeof query.text === "string")
    return query.text;
  return "";
};

describe("catalog PostgreSQL integration", () => {
  let app: INestApplication;
  let pool: Pool;

  const products = async (filter: Record<string, unknown>) =>
    request(app.getHttpServer())
      .post("/graphql")
      .send({
        query: `query Products($filter: ProductFilterInput) {
          products(filter: $filter) {
            nodes { productId skus { skuId price stock } }
            nextCursor
            hasNextPage
            totalCount
          }
        }`,
        variables: { filter },
      })
      .expect(200);

  const productPriceSummaries = async (filter: Record<string, unknown>) =>
    request(app.getHttpServer())
      .post("/graphql")
      .send({
        query: `query ProductPriceSummaries($filter: ProductFilterInput) {
          productPriceSummaries(filter: $filter) {
            nodes { productId basePrice finalPrice }
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

  it("rejects reuse of a cursor with a different sort", async () => {
    const firstPage = await products({ sort: ProductSort.LOW_PRICE, first: 1 });
    const cursor = firstPage.body.data.products.nextCursor;

    const response = await products({ sort: ProductSort.HIGH_PRICE, first: 1, after: cursor });

    expect(response.body.data).toBeNull();
    expect(response.body.errors).toEqual([expect.objectContaining({ message: "Invalid product cursor" })]);
  });

  it("uses the candidate SQL metric for the cursor even when hydration sees a changed SKU", async () => {
    const firstProductId = "72100000-0000-4000-8000-000000000001";
    const secondProductId = "72100000-0000-4000-8000-000000000002";
    const firstSkuId = "82100000-0000-4000-8000-000000000001";
    await pool.query(
      `INSERT INTO "products"
        ("productId", "partnerId", "brandId", "categoryId", "title", "description", "status", "approvalStatus", "createdAt")
       VALUES
        ($1, $3, $4, $5, 'Frozen Cursor Metric A', 'Cursor metric fixture', 'PUBLISHED', 'APPROVED', '2026-08-11T00:00:00Z'),
        ($2, $3, $4, $5, 'Frozen Cursor Metric B', 'Cursor metric fixture', 'PUBLISHED', 'APPROVED', '2026-08-10T00:00:00Z')`,
      [firstProductId, secondProductId, FIXTURE.partnerId, FIXTURE.brandId, FIXTURE.categoryId],
    );
    await pool.query(
      `INSERT INTO "productSkus"
        ("skuId", "productId", "code", "optionName", "price", "stock", "position")
       VALUES
        ($1, $2, 'FROZEN-CURSOR-A', 'A', 100, 2, 0),
        ('82100000-0000-4000-8000-000000000002', $3, 'FROZEN-CURSOR-B', 'B', 200, 1, 0)`,
      [firstSkuId, firstProductId, secondProductId],
    );

    const appPool = app.get<Database>(DRIZZLE).$client;
    const originalQuery = appPool.query.bind(appPool) as unknown as (
      query: unknown,
      values?: unknown[],
    ) => Promise<unknown>;
    let changedAfterCandidate = false;
    const querySpy = jest.spyOn(appPool, "query");
    querySpy.mockImplementation(((query: unknown, values?: unknown[]) => {
      const result = originalQuery(query, values);
      const text = queryText(query);
      if (changedAfterCandidate || !text.includes("to_char(") || !text.includes(" limit ")) return result;
      changedAfterCandidate = true;
      return result.then(async (value) => {
        await pool.query(`UPDATE "productSkus" SET "price" = 900 WHERE "skuId" = $1`, [firstSkuId]);
        return value;
      });
    }) as never);

    try {
      const response = await products({ query: "Frozen Cursor Metric", sort: ProductSort.LOW_PRICE, first: 1 });
      const connection = response.body.data.products;
      const cursor = decodeProductCursor(connection.nextCursor, ProductSort.LOW_PRICE);

      expect(response.body.errors).toBeUndefined();
      expect(changedAfterCandidate).toBe(true);
      expect(connection.nodes).toEqual([
        expect.objectContaining({ productId: firstProductId, skus: [expect.objectContaining({ price: 900 })] }),
      ]);
      expect(cursor).toMatchObject({ sort: ProductSort.LOW_PRICE, sortValue: 100 });
    } finally {
      querySpy.mockRestore();
    }
  });

  it("hydrates SKUs and brands only for page product IDs", async () => {
    const appPool = app.get<Database>(DRIZZLE).$client;
    const querySpy = jest.spyOn(appPool, "query");

    try {
      const response = await products({ first: 1 });
      const returnedProductId = response.body.data.products.nodes[0].productId;
      const calls = querySpy.mock.calls as unknown as [unknown, unknown[]?][];
      const candidate = calls.find(([query]) => {
        const text = queryText(query);
        return text.includes("to_char(") && text.includes(" limit ");
      });
      const skuHydration = calls.find(([query]) => queryText(query).includes('order by "productSkus"."position" asc'));
      const brandHydration = calls.find(([query]) =>
        queryText(query).includes('from "brands" where "brands"."brandId" in'),
      );
      const candidateText = queryText(candidate?.[0]);
      const candidateParams = candidate?.[1] ?? [];

      expect(returnedProductId).toBe(FIXTURE.productId);
      expect(candidateText).toContain("left join lateral");
      expect(candidateText).toContain('as "cursorSortValue"');
      expect(candidateText.match(/min\(/g)).toHaveLength(1);
      expect(candidateText.match(/sum\(/g)).toHaveLength(1);
      expect(candidateParams[candidateParams.length - 1]).toBe(2);
      expect(skuHydration?.[1]).toEqual([returnedProductId, true]);
      expect(brandHydration?.[1]).toEqual([FIXTURE.brandId]);
    } finally {
      querySpy.mockRestore();
    }
  });

  it("uses productId-complete indexes for default and category keyset plans", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL enable_seqscan = off");
      await client.query("SET LOCAL enable_bitmapscan = off");
      const defaultPlan = await client.query(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
         SELECT product."productId", sku_metrics.active_lowest_price, sku_metrics.active_stock_total
         FROM "products" product
         LEFT JOIN LATERAL (
           SELECT
             coalesce(min(sku."price"), 0)::double precision AS active_lowest_price,
             coalesce(sum(sku."stock"), 0)::double precision AS active_stock_total
           FROM "productSkus" sku
           WHERE sku."productId" = product."productId" AND sku."isActive" = true
         ) sku_metrics ON true
         WHERE product."status" = 'PUBLISHED'
           AND (product."createdAt" < '2027-01-01T00:00:00Z'::timestamp
             OR (product."createdAt" = '2027-01-01T00:00:00Z'::timestamp
               AND product."productId" < 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid))
         ORDER BY product."createdAt" DESC, product."productId" DESC
         LIMIT 21`,
      );
      const categoryPlan = await client.query(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
         SELECT product."productId", sku_metrics.active_lowest_price, sku_metrics.active_stock_total
         FROM "products" product
         LEFT JOIN LATERAL (
           SELECT
             coalesce(min(sku."price"), 0)::double precision AS active_lowest_price,
             coalesce(sum(sku."stock"), 0)::double precision AS active_stock_total
           FROM "productSkus" sku
           WHERE sku."productId" = product."productId" AND sku."isActive" = true
         ) sku_metrics ON true
         WHERE product."status" = 'PUBLISHED' AND product."categoryId" = $1
           AND (product."createdAt" < '2027-01-01T00:00:00Z'::timestamp
             OR (product."createdAt" = '2027-01-01T00:00:00Z'::timestamp
               AND product."productId" < 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid))
         ORDER BY product."createdAt" DESC, product."productId" DESC
         LIMIT 21`,
        [FIXTURE.categoryId],
      );

      expect(JSON.stringify(defaultPlan.rows)).toContain("products_catalog_default_keyset_idx");
      expect(JSON.stringify(categoryPlan.rows)).toContain("products_catalog_category_keyset_idx");
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("orders active SKU aggregate edge cases with null metrics represented as zero", async () => {
    const aggregateProducts = {
      multi: "72200000-0000-4000-8000-000000000001",
      single: "72200000-0000-4000-8000-000000000002",
      activeZero: "72200000-0000-4000-8000-000000000003",
      inactiveOnly: "72200000-0000-4000-8000-000000000004",
      noSku: "72200000-0000-4000-8000-000000000005",
    } as const;
    await pool.query(
      `INSERT INTO "products"
        ("productId", "partnerId", "brandId", "categoryId", "title", "description", "status", "approvalStatus", "createdAt")
       VALUES
        ($1, $6, $7, $8, 'Aggregate Edge Multi', 'Aggregate fixture', 'PUBLISHED', 'APPROVED', '2026-08-02T00:00:00Z'),
        ($2, $6, $7, $8, 'Aggregate Edge Single', 'Aggregate fixture', 'PUBLISHED', 'APPROVED', '2026-08-01T00:00:00Z'),
        ($3, $6, $7, $8, 'Aggregate Edge Active Zero', 'Aggregate fixture', 'PUBLISHED', 'APPROVED', '2026-08-05T00:00:00Z'),
        ($4, $6, $7, $8, 'Aggregate Edge Inactive Only', 'Aggregate fixture', 'PUBLISHED', 'APPROVED', '2026-08-04T00:00:00Z'),
        ($5, $6, $7, $8, 'Aggregate Edge No SKU', 'Aggregate fixture', 'PUBLISHED', 'APPROVED', '2026-08-03T00:00:00Z')`,
      [
        aggregateProducts.multi,
        aggregateProducts.single,
        aggregateProducts.activeZero,
        aggregateProducts.inactiveOnly,
        aggregateProducts.noSku,
        FIXTURE.partnerId,
        FIXTURE.brandId,
        FIXTURE.categoryId,
      ],
    );
    await pool.query(
      `INSERT INTO "productSkus"
        ("skuId", "productId", "code", "optionName", "price", "stock", "position", "isActive")
       VALUES
        ('82200000-0000-4000-8000-000000000001', $1, 'AGG-MULTI-LOW', 'Low', 100, 4, 0, true),
        ('82200000-0000-4000-8000-000000000002', $1, 'AGG-MULTI-HIGH', 'High', 400, 5, 1, true),
        ('82200000-0000-4000-8000-000000000003', $1, 'AGG-MULTI-INACTIVE', 'Inactive', 1, 100, 2, false),
        ('82200000-0000-4000-8000-000000000004', $2, 'AGG-SINGLE', 'Single', 200, 3, 0, true),
        ('82200000-0000-4000-8000-000000000005', $3, 'AGG-ZERO', 'Zero', 0, 0, 0, true),
        ('82200000-0000-4000-8000-000000000006', $4, 'AGG-INACTIVE', 'Inactive', 900, 500, 0, false)`,
      [aggregateProducts.multi, aggregateProducts.single, aggregateProducts.activeZero, aggregateProducts.inactiveOnly],
    );

    const lowPrice = await products({ query: "Aggregate Edge", sort: ProductSort.LOW_PRICE, first: 10 });
    const highPrice = await productPriceSummaries({
      query: "Aggregate Edge",
      sort: ProductSort.HIGH_PRICE,
      first: 10,
    });
    const popular = await products({ query: "Aggregate Edge", sort: ProductSort.POPULAR, first: 10 });
    const zeroPrice = await products({ query: "Aggregate Edge", maxPrice: 0, first: 10 });

    expect(lowPrice.body.data.products.nodes.map(({ productId }: { productId: string }) => productId)).toEqual([
      aggregateProducts.activeZero,
      aggregateProducts.inactiveOnly,
      aggregateProducts.noSku,
      aggregateProducts.multi,
      aggregateProducts.single,
    ]);
    expect(highPrice.body.data.productPriceSummaries.nodes).toEqual([
      { productId: aggregateProducts.single, basePrice: 200, finalPrice: 200 },
      { productId: aggregateProducts.multi, basePrice: 400, finalPrice: 100 },
      { productId: aggregateProducts.activeZero, basePrice: 0, finalPrice: 0 },
      { productId: aggregateProducts.inactiveOnly, basePrice: 0, finalPrice: 0 },
      { productId: aggregateProducts.noSku, basePrice: 0, finalPrice: 0 },
    ]);
    expect(popular.body.data.products.nodes.map(({ productId }: { productId: string }) => productId)).toEqual([
      aggregateProducts.multi,
      aggregateProducts.single,
      aggregateProducts.activeZero,
      aggregateProducts.inactiveOnly,
      aggregateProducts.noSku,
    ]);
    expect(zeroPrice.body.data.products).toMatchObject({
      totalCount: 3,
      nodes: [
        { productId: aggregateProducts.activeZero, skus: [{ price: 0, stock: 0 }] },
        { productId: aggregateProducts.inactiveOnly, skus: [] },
        { productId: aggregateProducts.noSku, skus: [] },
      ],
    });
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
