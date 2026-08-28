import { FeedService } from "./feed.service";

const query = (rows: readonly unknown[]) => {
  const result = Promise.resolve(rows);
  const chain = {
    from: jest.fn(),
    where: jest.fn(),
    orderBy: jest.fn(),
    limit: jest.fn().mockReturnValue(result),
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
});
