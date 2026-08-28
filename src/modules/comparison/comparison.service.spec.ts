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

const listDatabase = () => ({
  select: jest.fn().mockReturnValue({
    from: () => ({
      where: () => ({ orderBy: async () => comparisonRows }),
    }),
  }),
});

describe("ComparisonService", () => {
  it("hydrates comparison products with one batch while preserving item order", async () => {
    const getProductsByIds = jest.fn().mockResolvedValue([
      { productId: "product-b", title: "B" },
      { productId: "product-a", title: "A" },
    ]);
    const service = new ComparisonService(listDatabase() as never, { getProductsByIds } as never);

    const items = await service.list("user-1");

    expect(items.map(({ product }) => product.productId)).toEqual(["product-a", "product-b"]);
    expect(getProductsByIds).toHaveBeenCalledTimes(1);
    expect(getProductsByIds).toHaveBeenCalledWith(["product-a", "product-b"]);
  });

  it("loads every comparison price summary in one batch", async () => {
    const summaries = [{ productId: "product-a" }, { productId: "product-b" }];
    const getProductPriceSummariesByIds = jest.fn().mockResolvedValue(summaries);
    const service = new ComparisonService(listDatabase() as never, { getProductPriceSummariesByIds } as never);

    await expect(service.listPriceSummaries("user-1")).resolves.toEqual(summaries);
    expect(getProductPriceSummariesByIds).toHaveBeenCalledTimes(1);
    expect(getProductPriceSummariesByIds).toHaveBeenCalledWith(["product-a", "product-b"]);
  });
});
