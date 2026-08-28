import { CartErrorMessage, getInsufficientStockMessage } from "./cart.error";
import { CartService } from "./cart.service";

const selectDatabase = (rows: readonly unknown[]) => {
  const query = {
    from: jest.fn(),
    innerJoin: jest.fn(),
    where: jest.fn(),
    limit: jest.fn().mockResolvedValue(rows),
  };
  query.from.mockReturnValue(query);
  query.innerJoin.mockReturnValue(query);
  query.where.mockReturnValue(query);
  return { select: jest.fn().mockReturnValue(query) };
};

describe("CartService", () => {
  it("rejects non-positive quantities before database access", async () => {
    const select = jest.fn();
    const service = new CartService({ select } as never);
    await expect(service.upsertItem("user-1", { skuId: "sku-1", quantity: 0 })).rejects.toThrow(
      CartErrorMessage.QuantityMustBePositive,
    );
    expect(select).not.toHaveBeenCalled();
  });

  it("rejects quantities above current stock", async () => {
    const service = new CartService(
      selectDatabase([
        {
          productSkus: { code: "SKU-1", stock: 1 },
          products: { status: "PUBLISHED" },
        },
      ]) as never,
    );
    await expect(service.upsertItem("user-1", { skuId: "sku-1", quantity: 2 })).rejects.toThrow(
      getInsufficientStockMessage("SKU-1"),
    );
  });

  it("does not record removal activity when the cart item does not exist", async () => {
    const insert = jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({ onConflictDoNothing: jest.fn().mockResolvedValue(undefined) }),
    });
    const select = jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockReturnValue({ for: jest.fn().mockResolvedValue([{ cartId: "cart-1" }]) }),
        }),
      }),
    });
    const returning = jest.fn().mockResolvedValue([]);
    const remove = jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({ returning }),
    });
    const tx = { insert, select, delete: remove };
    const transaction = jest.fn(async (callback: (value: typeof tx) => unknown) => callback(tx));
    const service = new CartService({ transaction } as never);
    jest.spyOn(service, "getCart").mockResolvedValue({ cartId: "cart-1", items: [], totalAmount: 0 });

    await service.removeItem("user-1", "missing-sku");

    expect(insert).toHaveBeenCalledTimes(1);
  });
});
