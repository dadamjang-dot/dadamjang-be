import { WishErrorMessage } from "./wish.error";
import { WishService } from "./wish.service";

const query = (result: readonly unknown[]) => {
  const chain = { from: jest.fn(), where: jest.fn(), limit: jest.fn().mockResolvedValue(result) };
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  return chain;
};

describe("WishService", () => {
  it("returns the existing wish for duplicate additions", async () => {
    const existing = { wishId: "wish-1", userId: "user-1", productId: "product-1" };
    const select = jest
      .fn()
      .mockReturnValueOnce(query([{ productId: "product-1", status: "PUBLISHED" }]))
      .mockReturnValueOnce(query([existing]));
    const insert = jest
      .fn()
      .mockReturnValueOnce({
        values: jest.fn().mockReturnValue({
          onConflictDoNothing: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }),
        }),
      })
      .mockReturnValueOnce({ values: jest.fn().mockResolvedValue(undefined) });
    const service = new WishService({ select, insert } as never, {} as never);
    await expect(service.add("user-1", "product-1")).resolves.toEqual(existing);
  });

  it("rejects wishes for unpublished products", async () => {
    const service = new WishService(
      { select: jest.fn().mockReturnValue(query([{ status: "DRAFT" }])) } as never,
      {} as never,
    );
    await expect(service.add("user-1", "product-1")).rejects.toThrow(WishErrorMessage.ProductNotFound);
  });
});
