import { CatalogErrorMessage } from "./catalog.error";
import { CatalogService, decodeProductCursor, encodeProductCursor } from "./catalog.service";
import { ProductSort } from "./catalog.types";
import type { Database } from "src/modules/database/database.module";
import type { Product, ProductSku } from "src/modules/database/schema";

const createQuery = (result: unknown) => {
  const query = {
    from: jest.fn(),
    where: jest.fn(),
    orderBy: jest.fn(),
    limit: jest.fn(),
    then: (onfulfilled?: ((value: unknown) => unknown) | null, onrejected?: ((reason: unknown) => unknown) | null) =>
      Promise.resolve(result).then(onfulfilled ?? undefined, onrejected ?? undefined),
  };
  query.from.mockReturnValue(query);
  query.where.mockReturnValue(query);
  query.orderBy.mockReturnValue(query);
  query.limit.mockReturnValue(query);
  return query;
};

const createDatabase = (productRows: Product[], skuRows: ProductSku[], count = productRows.length) => {
  let selectCount = 0;
  return {
    select: jest.fn((selection?: unknown) => {
      const result = selection ? [{ count }] : selectCount++ === 0 ? productRows : skuRows;
      return createQuery(result);
    }),
  } as unknown as Database;
};

const product = (productId: string, createdAt: string, brandId = "brand-1", isOnSale = true): Product => ({
  productId,
  partnerId: "partner-1",
  brandId,
  categoryId: "category-1",
  title: productId,
  description: productId,
  imageUrls: [],
  status: "PUBLISHED",
  approvalStatus: "APPROVED",
  rejectionReason: null,
  isOnSale,
  isExpressDelivery: true,
  publishedAt: new Date(createdAt),
  createdAt: new Date(createdAt),
  updatedAt: new Date(createdAt),
});

const sku = (productId: string, skuId: string, price: number, colorId = "color-1", sizeId = "size-1"): ProductSku => ({
  skuId,
  productId,
  code: `${productId}-${skuId}`,
  colorId,
  sizeId,
  optionName: skuId,
  price,
  stock: price,
  isActive: true,
  createdAt: new Date("2026-07-01T00:00:00.000Z"),
  updatedAt: new Date("2026-07-01T00:00:00.000Z"),
});

describe("catalog cursor", () => {
  it("round-trips a stable product cursor", () => {
    const cursor = { createdAt: "2026-07-11T00:00:00.000Z", productId: "product-1" };
    expect(decodeProductCursor(encodeProductCursor(cursor))).toEqual(cursor);
  });

  it("rejects malformed cursors", () => {
    expect(() => decodeProductCursor("not-a-cursor")).toThrow(CatalogErrorMessage.InvalidCursor);
  });

  it("filters, counts, sorts, and paginates the same catalog result set", async () => {
    const productRows = [
      product("product-1", "2026-07-11T00:00:00.000Z"),
      product("product-2", "2026-07-10T00:00:00.000Z"),
      product("product-3", "2026-07-09T00:00:00.000Z", "brand-2", false),
    ];
    const skuRows = [sku("product-1", "sku-1", 100), sku("product-2", "sku-2", 200), sku("product-3", "sku-3", 50)];
    const filter = {
      brandIds: ["brand-1"],
      colorIds: ["color-1"],
      sizeIds: ["size-1"],
      minPrice: 100,
      maxPrice: 200,
      saleOnly: true,
      expressOnly: true,
      sort: ProductSort.LOW_PRICE,
      first: 1,
    };
    const firstPage = await new CatalogService(createDatabase(productRows, skuRows, 2)).listProducts(filter);

    expect(firstPage.totalCount).toBe(2);
    expect(firstPage.nodes.map(({ productId }) => productId)).toEqual(["product-1"]);
    expect(firstPage.hasNextPage).toBe(true);
    expect(firstPage.nextCursor).toBeTruthy();

    const summaryPage = await new CatalogService(createDatabase(productRows, skuRows, 2)).listProductPriceSummaries(
      filter,
    );

    expect(summaryPage.totalCount).toBe(2);
    expect(summaryPage.nodes.map(({ productId }) => productId)).toEqual(["product-1"]);

    const secondPage = await new CatalogService(createDatabase(productRows, skuRows, 2)).listProducts({
      ...filter,
      after: firstPage.nextCursor ?? undefined,
    });

    expect(secondPage.totalCount).toBe(2);
    expect(secondPage.nodes.map(({ productId }) => productId)).toEqual(["product-2"]);
    expect(secondPage.hasNextPage).toBe(false);
    expect(secondPage.nextCursor).toBeNull();
  });
});
