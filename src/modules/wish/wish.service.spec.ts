import { WishErrorMessage } from "./wish.error";
import { WishService } from "./wish.service";

const query = (result: readonly unknown[]) => {
  const promise = Promise.resolve(result);
  const chain = {
    from: jest.fn(),
    where: jest.fn(),
    orderBy: jest.fn(),
    limit: jest.fn().mockResolvedValue(result),
    then: promise.then.bind(promise),
  };
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  return chain;
};

describe("WishService", () => {
  it("limits the legacy wishlist and its product hydration to 100 newest rows", async () => {
    const wishRows = Array.from({ length: 101 }, (_, index) => ({
      wishId: `wish-${index}`,
      userId: "user-1",
      productId: `product-${index}`,
      createdAt: new Date(101 - index),
    }));
    const listQuery = query(wishRows);
    const getProductsByIds = jest.fn(async (productIds: string[]) => productIds.map((productId) => ({ productId })));
    const service = new WishService(
      { select: jest.fn().mockReturnValue(listQuery) } as never,
      { getProductsByIds } as never,
    );

    const result = await service.list("user-1");

    expect(result).toHaveLength(100);
    expect(listQuery.limit).toHaveBeenCalledWith(100);
    expect(getProductsByIds.mock.calls[0]?.[0]).toHaveLength(100);
  });

  it("returns the existing wish without recording duplicate activity", async () => {
    const existing = { wishId: "wish-1", userId: "user-1", productId: "product-1" };
    const insert = jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({
        onConflictDoNothing: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }),
      }),
    });
    const tx = { insert, select: () => query([existing]) };
    const transaction = jest.fn(async (callback: (value: typeof tx) => unknown) => callback(tx));
    const service = new WishService(
      {
        select: jest.fn().mockReturnValue(query([{ productId: "product-1", status: "PUBLISHED" }])),
        transaction,
      } as never,
      {} as never,
    );

    await expect(service.add("user-1", "product-1")).resolves.toEqual(existing);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it("deletes a wish and records its activity in one transaction", async () => {
    const returning = jest.fn().mockResolvedValue([{ productId: "product-1" }]);
    const where = jest.fn().mockReturnValue({ returning });
    const deleteWish = jest.fn().mockReturnValue({ where });
    const insert = jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue(undefined) });
    const tx = { delete: deleteWish, insert };
    const transaction = jest.fn(async (callback: (value: typeof tx) => unknown) => callback(tx));
    const service = new WishService({ transaction } as never, {} as never);

    await expect(service.remove("user-1", "product-1")).resolves.toBe(true);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it("rejects wishes for unpublished products", async () => {
    const service = new WishService(
      { select: jest.fn().mockReturnValue(query([{ status: "DRAFT" }])) } as never,
      {} as never,
    );
    await expect(service.add("user-1", "product-1")).rejects.toThrow(WishErrorMessage.ProductNotFound);
  });
});
