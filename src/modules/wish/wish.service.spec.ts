import { WishErrorMessage } from "./wish.error";
import { WishService } from "./wish.service";

const query = (result: readonly unknown[]) => {
  const chain = { from: jest.fn(), where: jest.fn(), limit: jest.fn().mockResolvedValue(result) };
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  return chain;
};

describe("WishService", () => {
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
