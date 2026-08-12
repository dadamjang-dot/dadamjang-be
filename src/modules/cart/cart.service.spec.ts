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
});
