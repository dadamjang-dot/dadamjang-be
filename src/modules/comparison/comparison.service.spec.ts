import { ComparisonService } from "./comparison.service";

const comparisonRows = [
  {
    comparisonItemId: "comparison-1",
    userId: "user-1",
    productId: "product-a",
    createdAt: new Date("2026-08-29T00:00:00Z"),
  },
  {
    comparisonItemId: "comparison-2",
    userId: "user-1",
    productId: "product-b",
    createdAt: new Date("2026-08-28T00:00:00Z"),
  },
];

const listQuery = (rows: readonly unknown[]) => {
  const result = Promise.resolve(rows);
  const chain = {
    from: jest.fn(),
    where: jest.fn(),
    orderBy: jest.fn(),
    limit: jest.fn().mockResolvedValue(rows),
    then: result.then.bind(result),
  };
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  return chain;
};

const listDatabase = (rows: readonly unknown[] = comparisonRows) => {
  const query = listQuery(rows);
  return { db: { select: jest.fn().mockReturnValue(query) }, query };
};

const query = (result: readonly unknown[]) => {
  const chain = { from: jest.fn(), where: jest.fn(), limit: jest.fn().mockResolvedValue(result) };
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  return chain;
};

describe("ComparisonService", () => {
  it("hydrates comparison products with one batch while preserving item order", async () => {
    const getProductsByIds = jest.fn().mockResolvedValue([
      { productId: "product-b", title: "B" },
      { productId: "product-a", title: "A" },
    ]);
    const { db } = listDatabase();
    const service = new ComparisonService(db as never, { getProductsByIds } as never);

    const items = await service.list("user-1");

    expect(items.map(({ product }) => product.productId)).toEqual(["product-a", "product-b"]);
    expect(getProductsByIds).toHaveBeenCalledTimes(1);
    expect(getProductsByIds).toHaveBeenCalledWith(["product-a", "product-b"]);
  });

  it("loads every comparison price summary in one batch", async () => {
    const summaries = [{ productId: "product-a" }, { productId: "product-b" }];
    const getProductPriceSummariesByIds = jest.fn().mockResolvedValue(summaries);
    const { db } = listDatabase();
    const service = new ComparisonService(db as never, { getProductPriceSummariesByIds } as never);

    await expect(service.listPriceSummaries("user-1")).resolves.toEqual(summaries);
    expect(getProductPriceSummariesByIds).toHaveBeenCalledTimes(1);
    expect(getProductPriceSummariesByIds).toHaveBeenCalledWith(["product-a", "product-b"]);
  });

  it("limits legacy comparison hydration to 100 newest products", async () => {
    const rows = Array.from({ length: 101 }, (_, index) => ({
      comparisonItemId: `comparison-${index}`,
      userId: "user-1",
      productId: `product-${index}`,
      createdAt: new Date(101 - index),
    }));
    const { db, query } = listDatabase(rows);
    const getProductsByIds = jest.fn(async (productIds: string[]) => productIds.map((productId) => ({ productId })));
    const service = new ComparisonService(db as never, { getProductsByIds } as never);

    const result = await service.list("user-1");

    expect(result).toHaveLength(100);
    expect(query.limit).toHaveBeenCalledWith(100);
    expect(getProductsByIds.mock.calls[0]?.[0]).toHaveLength(100);
  });

  it("limits legacy comparison price summaries to 100 newest products", async () => {
    const rows = Array.from({ length: 101 }, (_, index) => ({
      comparisonItemId: `comparison-${index}`,
      userId: "user-1",
      productId: `product-${index}`,
      createdAt: new Date(101 - index),
    }));
    const { db, query } = listDatabase(rows);
    const getProductPriceSummariesByIds = jest.fn(async (productIds: string[]) =>
      productIds.map((productId) => ({ productId })),
    );
    const service = new ComparisonService(db as never, { getProductPriceSummariesByIds } as never);

    const result = await service.listPriceSummaries("user-1");

    expect(result).toHaveLength(100);
    expect(query.limit).toHaveBeenCalledWith(100);
    expect(getProductPriceSummariesByIds.mock.calls[0]?.[0]).toHaveLength(100);
  });

  it("returns an existing item without recording duplicate activity", async () => {
    const existing = comparisonRows[0];
    const insert = jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({
        onConflictDoNothing: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }),
      }),
    });
    const tx = { insert, select: () => query([existing]) };
    const transaction = jest.fn(async (callback: (value: typeof tx) => unknown) => callback(tx));
    const product = { productId: "product-a", status: "PUBLISHED" };
    const service = new ComparisonService(
      { transaction } as never,
      {
        getProduct: jest.fn().mockResolvedValue(product),
      } as never,
    );

    await expect(service.add("user-1", "product-a")).resolves.toEqual({ ...existing, product });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it("deletes an item and records its activity in one transaction", async () => {
    const returning = jest.fn().mockResolvedValue([{ productId: "product-a" }]);
    const deleteItem = jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ returning }) });
    const insert = jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue(undefined) });
    const tx = { delete: deleteItem, insert };
    const transaction = jest.fn(async (callback: (value: typeof tx) => unknown) => callback(tx));
    const service = new ComparisonService({ transaction } as never, {} as never);

    await expect(service.remove("user-1", "product-a")).resolves.toBe(true);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledTimes(1);
  });
});
