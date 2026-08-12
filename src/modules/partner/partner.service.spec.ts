import { PartnerErrorMessage } from "./partner.error";
import { PartnerService } from "./partner.service";

const partnerQuery = (status: string) => {
  const chain = { from: jest.fn(), where: jest.fn(), limit: jest.fn().mockResolvedValue([{ status }]) };
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  return chain;
};

describe("PartnerService", () => {
  it("blocks product creation for an unapproved partner", async () => {
    const service = new PartnerService(
      { select: jest.fn().mockReturnValue(partnerQuery("PENDING")) } as never,
      { createDraft: jest.fn() } as never,
      {} as never,
    );
    await expect(service.createDraft("user-1", {} as never)).rejects.toThrow(
      PartnerErrorMessage.ApprovalRequiredForProduct,
    );
  });

  it("blocks publishing for an unapproved partner", async () => {
    const service = new PartnerService(
      { select: jest.fn().mockReturnValue(partnerQuery("REJECTED")) } as never,
      { publishProduct: jest.fn() } as never,
      {} as never,
    );
    await expect(service.publishProduct("user-1", "product-1")).rejects.toThrow(
      PartnerErrorMessage.ApprovalRequiredForPublishing,
    );
  });
});
