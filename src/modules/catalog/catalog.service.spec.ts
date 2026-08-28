import { CatalogErrorMessage } from "./catalog.error";
import { CatalogService, decodeProductCursor, encodeProductCursor } from "./catalog.service";
import { ProductSort } from "./catalog.types";

const rawCursor = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const CURSOR_CREATED_AT = "2026-07-11T00:00:00.000000Z";
const CURSOR_PRODUCT_ID = "70000000-0000-4000-8000-000000000001";

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
    const service = new CatalogService({} as never);
    jest.spyOn(service, "getProductsByIds").mockResolvedValue([
      {
        productId: "product-b",
        title: "B",
        imageUrls: [],
        isOnSale: false,
        isExpressDelivery: true,
        skus: [{ price: 2000 }],
        createdAt,
      },
      {
        productId: "product-a",
        title: "A",
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
        priceRevision: "product-a:1787961600000:1000",
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
        priceRevision: "product-b:1787961600000:2000",
        lowestPriceEvidenceSummary: "현재 옵션 최저가 기준",
      },
    ]);
  });
});

describe("catalog price evidence", () => {
  it("rejects evidence for a stale price revision", async () => {
    const service = new CatalogService({} as never);
    jest.spyOn(service, "getProduct").mockResolvedValue({
      productId: "product-a",
      title: "A",
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
