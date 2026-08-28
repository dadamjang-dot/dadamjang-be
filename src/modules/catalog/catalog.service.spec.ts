import { CatalogErrorMessage } from "./catalog.error";
import { CatalogService, decodeProductCursor, encodeProductCursor } from "./catalog.service";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
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
    select: jest.fn(() => {
      const call = selectCount++;
      const result =
        call === 0
          ? productRows.map((row) => ({ ...row, cursorCreatedAt: row.createdAt.toISOString() }))
          : call === 1
            ? [{ count }]
            : call === 2
              ? skuRows
              : [];
      return createQuery(result);
    }),
  } as unknown as Database;
};

const product = (
  productId: string,
  createdAt: string,
  brandId = "brand-1",
  isOnSale = true,
  categoryId = "category-1",
): Product => ({
  productId,
  partnerId: "partner-1",
  brandId,
  categoryId,
  title: productId,
  description: productId,
  imageUrls: [],
  imageKeys: [],
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
  position: 0,
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

  it("limits catalog candidates before SKU hydration", async () => {
    const database = createDatabase(
      [
        product("product-1", "2026-07-11T00:00:00.000Z"),
        product("product-2", "2026-07-10T00:00:00.000Z"),
        product("product-3", "2026-07-09T00:00:00.000Z"),
      ],
      [sku("product-1", "sku-1", 100), sku("product-2", "sku-2", 200), sku("product-3", "sku-3", 300)],
    );

    await new CatalogService(database).listProducts({ first: 1 });

    const productQuery = (database.select as jest.Mock).mock.results[0]?.value as ReturnType<typeof createQuery>;
    const skuQuery = (database.select as jest.Mock).mock.results[2]?.value as ReturnType<typeof createQuery>;
    const skuCondition = skuQuery.where.mock.calls[0]?.[0] as SQL;
    expect(productQuery.limit).toHaveBeenCalledWith(2);
    expect(new PgDialect().sqlToQuery(skuCondition).params).toEqual(["product-1", true]);
  });
});
