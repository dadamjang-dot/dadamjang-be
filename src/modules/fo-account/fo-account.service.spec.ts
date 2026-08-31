import { hashToken } from "src/common/security/token-hash";
import { FoAccountService } from "./fo-account.service";

describe("FoAccountService", () => {
  it("stores a reactivation token in the supplied transaction", async () => {
    const store = {};
    const insertReactivationToken = jest.fn().mockResolvedValue(undefined);
    const service = new FoAccountService({ insertReactivationToken } as never, {} as never);
    const createReactivationToken = service.createReactivationToken as unknown as (
      userId: string,
      deviceId: string,
      transaction: object,
    ) => Promise<string>;

    const token = await createReactivationToken("user-id", "device-id", store);

    expect(insertReactivationToken).toHaveBeenCalledWith("user-id", hashToken(token), hashToken("device-id"), store);
  });
});
