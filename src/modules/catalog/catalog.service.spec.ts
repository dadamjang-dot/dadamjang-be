import { CatalogErrorMessage } from "./catalog.error";
import { CatalogService, decodeProductCursor, encodeProductCursor } from "./catalog.service";
import { CreateProductDraftInput, ProductSort } from "./catalog.types";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const rawCursor = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const createCatalogService = () => new CatalogService({} as never, { getProductImageUrl: jest.fn() } as never);
const CURSOR_CREATED_AT = "2026-07-11T00:00:00.000000Z";
const CURSOR_PRODUCT_ID = "70000000-0000-4000-8000-000000000001";

const catalogQuery = (rows: readonly unknown[]) => {
  const result = Promise.resolve(rows);
  const chain = {
    activeLowestPrice: sql<number>`0`,
    activeStockTotal: sql<number>`0`,
    from: jest.fn(),
    where: jest.fn(),
    as: jest.fn(),
    leftJoinLateral: jest.fn(),
    orderBy: jest.fn(),
    limit: jest.fn().mockResolvedValue(rows),
    then: result.then.bind(result),
  };
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.as.mockReturnValue(chain);
  chain.leftJoinLateral.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  return chain;
};

describe("catalog cursor", () => {
  it.each([
    {
      v: 1 as const,
      sort: ProductSort.RECOMMENDED,
      createdAt: CURSOR_CREATED_AT,
      productId: CURSOR_PRODUCT_ID,
    },
    {
      v: 1 as const,
      sort: ProductSort.LATEST,
      createdAt: CURSOR_CREATED_AT,
      productId: CURSOR_PRODUCT_ID,
    },
    {
      v: 1 as const,
      sort: ProductSort.LOW_PRICE,
      sortValue: 120,
      createdAt: CURSOR_CREATED_AT,
      productId: CURSOR_PRODUCT_ID,
    },
    {
      v: 1 as const,
      sort: ProductSort.HIGH_PRICE,
      sortValue: 120,
      createdAt: CURSOR_CREATED_AT,
      productId: CURSOR_PRODUCT_ID,
    },
    {
      v: 1 as const,
      sort: ProductSort.POPULAR,
      sortValue: 5,
      createdAt: CURSOR_CREATED_AT,
      productId: CURSOR_PRODUCT_ID,
    },
  ] as const)("round-trips a versioned $sort cursor", (cursor) => {
    expect(decodeProductCursor(encodeProductCursor(cursor), cursor.sort)).toEqual(cursor);
  });

  it("rejects malformed cursors", () => {
    expect(() => decodeProductCursor("not-a-cursor", ProductSort.RECOMMENDED)).toThrow(
      CatalogErrorMessage.InvalidCursor,
    );
  });

  it.each([
    ["an unversioned shape", { createdAt: CURSOR_CREATED_AT, productId: CURSOR_PRODUCT_ID }, ProductSort.RECOMMENDED],
    [
      "an unknown field",
      {
        v: 1,
        sort: ProductSort.RECOMMENDED,
        createdAt: CURSOR_CREATED_AT,
        productId: CURSOR_PRODUCT_ID,
        extra: true,
      },
      ProductSort.RECOMMENDED,
    ],
    [
      "a missing metric",
      { v: 1, sort: ProductSort.LOW_PRICE, createdAt: CURSOR_CREATED_AT, productId: CURSOR_PRODUCT_ID },
      ProductSort.LOW_PRICE,
    ],
    [
      "a metric on a date sort",
      {
        v: 1,
        sort: ProductSort.LATEST,
        sortValue: 1,
        createdAt: CURSOR_CREATED_AT,
        productId: CURSOR_PRODUCT_ID,
      },
      ProductSort.LATEST,
    ],
    [
      "an unsupported version",
      { v: 2, sort: ProductSort.RECOMMENDED, createdAt: CURSOR_CREATED_AT, productId: CURSOR_PRODUCT_ID },
      ProductSort.RECOMMENDED,
    ],
    [
      "an invalid timestamp",
      { v: 1, sort: ProductSort.RECOMMENDED, createdAt: "2026-07-11", productId: CURSOR_PRODUCT_ID },
      ProductSort.RECOMMENDED,
    ],
    [
      "an impossible timestamp",
      {
        v: 1,
        sort: ProductSort.RECOMMENDED,
        createdAt: "2026-02-31T00:00:00.000000Z",
        productId: CURSOR_PRODUCT_ID,
      },
      ProductSort.RECOMMENDED,
    ],
    [
      "an invalid product id",
      { v: 1, sort: ProductSort.RECOMMENDED, createdAt: CURSOR_CREATED_AT, productId: "product-1" },
      ProductSort.RECOMMENDED,
    ],
    [
      "a non-finite metric",
      {
        v: 1,
        sort: ProductSort.POPULAR,
        sortValue: null,
        createdAt: CURSOR_CREATED_AT,
        productId: CURSOR_PRODUCT_ID,
      },
      ProductSort.POPULAR,
    ],
    [
      "an unknown sort",
      { v: 1, sort: "UNKNOWN", createdAt: CURSOR_CREATED_AT, productId: CURSOR_PRODUCT_ID },
      ProductSort.RECOMMENDED,
    ],
    [
      "a missing product id",
      { v: 1, sort: ProductSort.RECOMMENDED, createdAt: CURSOR_CREATED_AT },
      ProductSort.RECOMMENDED,
    ],
    [
      "a string metric",
      {
        v: 1,
        sort: ProductSort.HIGH_PRICE,
        sortValue: "120",
        createdAt: CURSOR_CREATED_AT,
        productId: CURSOR_PRODUCT_ID,
      },
      ProductSort.HIGH_PRICE,
    ],
    ["a null payload", null, ProductSort.RECOMMENDED],
  ])("rejects %s", (_, value, sort) => {
    expect(() => decodeProductCursor(rawCursor(value), sort)).toThrow(CatalogErrorMessage.InvalidCursor);
  });

  it("rejects cursor reuse across sorts", () => {
    const cursor = rawCursor({
      v: 1,
      sort: ProductSort.LOW_PRICE,
      sortValue: 120,
      createdAt: CURSOR_CREATED_AT,
      productId: CURSOR_PRODUCT_ID,
    });

    expect(() => decodeProductCursor(cursor, ProductSort.HIGH_PRICE)).toThrow(CatalogErrorMessage.InvalidCursor);
  });
});

describe("catalog product batches", () => {
  it("returns price summaries in requested product order", async () => {
    const createdAt = new Date("2026-08-29T00:00:00Z");
    const service = createCatalogService();
    jest.spyOn(service, "getProductsByIds").mockResolvedValue([
      {
        productId: "product-b",
        title: "B",
        imageKeys: [],
        imageUrls: [],
        isOnSale: false,
        isExpressDelivery: true,
        skus: [{ price: 2000 }],
        createdAt,
      },
      {
        productId: "product-a",
        title: "A",
        imageKeys: [],
        imageUrls: ["https://images.test/a.png"],
        isOnSale: true,
        isExpressDelivery: false,
        skus: [{ price: 3000 }, { price: 1000 }],
        createdAt,
      },
    ] as never);

    await expect(
      (
        service as CatalogService & {
          getProductPriceSummariesByIds: (productIds: string[]) => Promise<unknown>;
        }
      ).getProductPriceSummariesByIds(["product-a", "product-b"]),
    ).resolves.toEqual([
      {
        productId: "product-a",
        name: "A",
        thumbnail: "https://images.test/a.png",
        isOnSale: true,
        isExpressDelivery: false,
        basePrice: 3000,
        finalPrice: 1000,
        priceRevision: "product-a:1787961600000:3000:1000",
        lowestPriceEvidenceSummary: "최저 옵션 기준 2,000원 차이",
      },
      {
        productId: "product-b",
        name: "B",
        thumbnail: null,
        isOnSale: false,
        isExpressDelivery: true,
        basePrice: 2000,
        finalPrice: 2000,
        priceRevision: "product-b:1787961600000:2000:2000",
        lowestPriceEvidenceSummary: "현재 옵션 최저가 기준",
      },
    ]);
  });
});

describe("catalog ranking budget", () => {
  it("sets a local statement timeout before catalog ranking queries", async () => {
    const execute = jest.fn().mockResolvedValue(undefined);
    const select = jest
      .fn()
      .mockReturnValueOnce(catalogQuery([]))
      .mockReturnValueOnce(catalogQuery([]))
      .mockReturnValueOnce(catalogQuery([{ count: 0 }]))
      .mockReturnValueOnce(catalogQuery([]));
    const transaction = jest.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback({ execute, select }));
    const service = new CatalogService({ transaction } as never, {} as never);

    await expect(service.listProducts({ sort: ProductSort.POPULAR })).resolves.toEqual({
      nodes: [],
      hasNextPage: false,
      nextCursor: null,
      totalCount: 0,
    });

    expect(execute).toHaveBeenCalledTimes(1);
    const statement = execute.mock.calls[0]?.[0];
    if (!statement) return;
    expect(new PgDialect().sqlToQuery(statement)).toMatchObject({
      sql: "select set_config('statement_timeout', $1, true)",
      params: ["5000ms"],
    });
    expect(execute.mock.invocationCallOrder[0]).toBeLessThan(select.mock.invocationCallOrder[0]!);
  });
});

describe("catalog SKU boundaries", () => {
  const inputWithSkuCount = (count: number): CreateProductDraftInput => ({
    categoryId: "category-1",
    title: "Product",
    description: "Description",
    imageUrls: [],
    skus: Array.from({ length: count }, (_, index) => ({
      code: `sku-${index}`,
      optionName: "Option",
      price: 0,
      stock: 0,
    })),
  });

  it.each([1, 100])("accepts %i SKUs", async (count) => {
    const transaction = jest.fn().mockResolvedValue({});
    const service = new CatalogService({ transaction } as never, {} as never);

    await expect(service.createDraft("partner-1", inputWithSkuCount(count))).resolves.toEqual({});
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  const invalidInputs: [string, CreateProductDraftInput][] = [
    ["zero SKUs", inputWithSkuCount(0)],
    ["101 SKUs", inputWithSkuCount(101)],
    [
      "an overlong code",
      { ...inputWithSkuCount(1), skus: [{ ...inputWithSkuCount(1).skus[0]!, code: "c".repeat(81) }] },
    ],
    [
      "an overlong option",
      { ...inputWithSkuCount(1), skus: [{ ...inputWithSkuCount(1).skus[0]!, optionName: "o".repeat(161) }] },
    ],
    ["a negative price", { ...inputWithSkuCount(1), skus: [{ ...inputWithSkuCount(1).skus[0]!, price: -1 }] }],
    [
      "an excessive price",
      { ...inputWithSkuCount(1), skus: [{ ...inputWithSkuCount(1).skus[0]!, price: 2_147_483_648 }] },
    ],
    ["negative stock", { ...inputWithSkuCount(1), skus: [{ ...inputWithSkuCount(1).skus[0]!, stock: -1 }] }],
    [
      "excessive stock",
      { ...inputWithSkuCount(1), skus: [{ ...inputWithSkuCount(1).skus[0]!, stock: 2_147_483_648 }] },
    ],
  ];

  it.each(invalidInputs)("rejects %s before database work", async (_case, input) => {
    const transaction = jest.fn();
    const service = new CatalogService({ transaction } as never, {} as never);

    await expect(service.createDraft("partner-1", input)).rejects.toThrow();
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe("catalog price evidence", () => {
  it("changes the revision when the evidence base price changes", async () => {
    const service = createCatalogService();
    const getProduct = jest.spyOn(service, "getProduct");
    const product = {
      productId: "product-a",
      title: "A",
      imageKeys: [],
      imageUrls: [],
      isOnSale: true,
      isExpressDelivery: false,
      createdAt: new Date("2026-08-29T00:00:00Z"),
    };
    getProduct
      .mockResolvedValueOnce({ ...product, skus: [{ price: 1000 }, { price: 2000 }] } as never)
      .mockResolvedValueOnce({ ...product, skus: [{ price: 1000 }, { price: 3000 }] } as never);

    const before = await service.getProductPriceSummary("product-a");
    const after = await service.getProductPriceSummary("product-a");

    expect(after.priceRevision).not.toBe(before.priceRevision);
  });

  it("rejects evidence for a stale price revision", async () => {
    const service = createCatalogService();
    jest.spyOn(service, "getProduct").mockResolvedValue({
      productId: "product-a",
      title: "A",
      imageKeys: [],
      imageUrls: [],
      isOnSale: true,
      isExpressDelivery: false,
      skus: [{ price: 1000 }],
      createdAt: new Date("2026-08-29T00:00:00Z"),
    } as never);

    await expect(service.getProductPriceEvidence("product-a", "stale-revision")).rejects.toThrow(
      "Product price has changed",
    );
  });
});
