import { FeedService } from "./feed.service";

const query = (rows: readonly unknown[]) => {
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

describe("FeedService", () => {
  it("hydrates a ranked page with one product batch while preserving rank order", async () => {
    const candidates = [
      { productId: "product-a", categoryId: "other", createdAt: new Date("2026-08-29T00:00:00Z") },
      { productId: "product-b", categoryId: "preferred", createdAt: new Date("2026-08-28T00:00:00Z") },
    ];
    const select = jest
      .fn()
      .mockReturnValueOnce(query([{ productId: "liked-product" }]))
      .mockReturnValueOnce(query([]))
      .mockReturnValueOnce(query([{ categoryId: "preferred" }]))
      .mockReturnValueOnce(query(candidates));
    const getProductsByIds = jest.fn().mockResolvedValue([
      { ...candidates[0], title: "A" },
      { ...candidates[1], title: "B" },
    ]);
    const service = new FeedService({ select } as never, { getProductsByIds } as never);

    const page = await service.personalizedFeed("user-1", 2);

    expect(page.nodes.map(({ productId }) => productId)).toEqual(["product-b", "product-a"]);
    expect(getProductsByIds).toHaveBeenCalledTimes(1);
    expect(getProductsByIds).toHaveBeenCalledWith(["product-b", "product-a"]);
  });

  it("limits wish history and the preference product query to 100 newest IDs", async () => {
    const wishQuery = query(Array.from({ length: 101 }, (_, index) => ({ productId: `wish-product-${index}` })));
    const viewedQuery = query([{ subjectId: "00000000-0000-4000-8000-000000000001" }]);
    const preferenceQuery = query([]);
    const candidateQuery = query([]);
    const select = jest
      .fn()
      .mockReturnValueOnce(wishQuery)
      .mockReturnValueOnce(viewedQuery)
      .mockReturnValueOnce(preferenceQuery)
      .mockReturnValueOnce(candidateQuery);
    const service = new FeedService(
      { select } as never,
      { getProductsByIds: jest.fn().mockResolvedValue([]) } as never,
    );

    await service.personalizedFeed("user-1");

    const preferenceCondition = preferenceQuery.where.mock.calls[0]?.[0] as { queryChunks?: unknown[] };
    const preferenceIds = preferenceCondition.queryChunks?.find(Array.isArray) as unknown[] | undefined;
    expect(wishQuery.orderBy).toHaveBeenCalledTimes(1);
    expect(wishQuery.limit).toHaveBeenCalledWith(100);
    expect(preferenceIds).toHaveLength(100);
  });
});
