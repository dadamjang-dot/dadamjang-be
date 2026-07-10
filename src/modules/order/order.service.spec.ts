import { CustomBadRequestException } from "src/common/errors/custom-exceptions";
import { OrderService } from "./order.service";

describe("OrderService", () => {
  it("rejects an empty cart before calling payment", async () => {
    const db = {
      transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
        }),
    };
    const service = new OrderService(db as never);
    await expect(service.checkoutCart("user-1", {})).rejects.toBeInstanceOf(CustomBadRequestException);
  });
});
