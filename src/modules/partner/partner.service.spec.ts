import { PartnerErrorMessage } from "./partner.error";
import { PartnerService } from "./partner.service";
import { PartnerProductInput } from "./partner.types";

const partnerQuery = (status: string) => {
  const chain = { from: jest.fn(), where: jest.fn(), limit: jest.fn().mockResolvedValue([{ status }]) };
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  return chain;
};

const validProductInput: PartnerProductInput = {
  categoryId: "category-1",
  title: "Product",
  description: "Description",
  imageKeys: ["image-1"],
  skus: [{ code: "sku-1", optionName: "Option", price: 0, stock: 0 }],
};

describe("PartnerService", () => {
  it("blocks product creation for an unapproved partner", async () => {
    const service = new PartnerService(
      { select: jest.fn().mockReturnValue(partnerQuery("PENDING")) } as never,
      { createDraft: jest.fn() } as never,
      {} as never,
      {} as never,
    );
    await expect(service.createDraft("user-1", validProductInput)).rejects.toThrow(
      PartnerErrorMessage.ApprovalRequiredForProduct,
    );
  });

  it("blocks publishing for an unapproved partner", async () => {
    const service = new PartnerService(
      { select: jest.fn().mockReturnValue(partnerQuery("REJECTED")) } as never,
      { publishProduct: jest.fn() } as never,
      {} as never,
      {} as never,
    );
    await expect(service.publishProduct("user-1", "product-1")).rejects.toThrow(
      PartnerErrorMessage.ApprovalRequiredForPublishing,
    );
  });

  it("rejects 101 SKUs before partner or catalog lookup", async () => {
    const select = jest.fn().mockReturnValue(partnerQuery("PENDING"));
    const service = new PartnerService({ select } as never, {} as never, {} as never, {} as never);
    const input: PartnerProductInput = {
      categoryId: "category-1",
      title: "Product",
      description: "Description",
      imageKeys: ["image-1"],
      skus: Array.from({ length: 101 }, (_, index) => ({
        code: `sku-${index}`,
        optionName: "Option",
        price: 0,
        stock: 0,
      })),
    };

    await expect(service.createDraft("user-1", input)).rejects.toThrow(PartnerErrorMessage.InvalidProductInput);
    expect(select).not.toHaveBeenCalled();
  });
});
