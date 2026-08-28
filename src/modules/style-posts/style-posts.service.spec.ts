import { StylePostsService } from "./style-posts.service";
import { PgDialect } from "drizzle-orm/pg-core";

const purchasedQuery = (rows: readonly unknown[]) => {
  const result = Promise.resolve(rows);
  const chain = {
    from: jest.fn(),
    innerJoin: jest.fn(),
    leftJoin: jest.fn(),
    where: jest.fn(),
    groupBy: jest.fn(),
    orderBy: jest.fn(),
    limit: jest.fn().mockResolvedValue(rows),
    then: result.then.bind(result),
  };
  chain.from.mockReturnValue(chain);
  chain.innerJoin.mockReturnValue(chain);
  chain.leftJoin.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.groupBy.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  return chain;
};

const createService = (rows: readonly unknown[]) => {
  const query = purchasedQuery(rows);
  const service = new StylePostsService(
    { select: jest.fn().mockReturnValue(query) } as never,
    {} as never,
    { getOrThrow: jest.fn().mockReturnValue("cursor-secret") } as never,
  );
  return { query, service };
};

describe("StylePostsService purchased products", () => {
  it("limits purchased product history to the 100 newest products", async () => {
    const rows = Array.from({ length: 101 }, (_, index) => ({
      productId: `product-${index}`,
      title: `Product ${index}`,
      imageUrls: [],
      brandId: null,
      brandName: null,
      categoryId: "category-1",
      lastPurchasedAt: new Date(101 - index),
    }));
    const { query, service } = createService(rows);

    const result = await service.purchasedStyleProducts("user-1");

    expect(result).toHaveLength(100);
    expect(query.limit).toHaveBeenCalledWith(100);
  });

  it("deduplicates purchased products at the database boundary", async () => {
    const rows = [
      {
        productId: "product-1",
        title: "Product",
        imageUrls: [],
        brandId: null,
        brandName: null,
        categoryId: "category-1",
        lastPurchasedAt: new Date("2026-08-29T00:00:00Z"),
      },
      {
        productId: "product-1",
        title: "Product",
        imageUrls: [],
        brandId: null,
        brandName: null,
        categoryId: "category-1",
        lastPurchasedAt: new Date("2026-08-28T00:00:00Z"),
      },
    ];
    const { query, service } = createService(rows);

    await service.purchasedStyleProducts("user-1");

    expect(query.groupBy).toHaveBeenCalledTimes(1);
  });
});

describe("StylePostsService ranking budget", () => {
  it("sets a local statement timeout around style ranking queries", async () => {
    const query = purchasedQuery([]);
    const execute = jest.fn().mockResolvedValue(undefined);
    const select = jest.fn().mockReturnValue(query);
    const transaction = jest.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback({ execute, select }));
    const service = new StylePostsService(
      { select, transaction } as never,
      {} as never,
      { getOrThrow: jest.fn().mockReturnValue("cursor-secret") } as never,
    );

    await expect(service.list()).resolves.toEqual({ nodes: [], hasNextPage: false, nextCursor: null });

    expect(transaction).toHaveBeenCalledTimes(1);
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
