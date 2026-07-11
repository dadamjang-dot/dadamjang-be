import { CustomBadRequestException } from "src/common/errors/custom-exceptions";
import { OrderService } from "./order.service";

describe("OrderService", () => {
  it("requires an idempotency key", async () => {
    const db = {
      transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({}),
    };
    const service = new OrderService(db as never);
    await expect(service.checkoutCart("user-1", {})).rejects.toThrow("idempotencyKey is required");
  });

  it("rejects an empty cart before calling payment", async () => {
    const db = {
      transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
          insert: () => ({ values: () => ({ returning: async () => [{ checkoutIdempotencyKeyId: "key-1" }] }) }),
        }),
    };
    const service = new OrderService(db as never);
    await expect(service.checkoutCart("user-1", { idempotencyKey: "checkout-1" })).rejects.toBeInstanceOf(
      CustomBadRequestException,
    );
  });

  it("returns the existing order for a reused idempotency key", async () => {
    let selectCount = 0;
    const order = {
      orderId: "order-1",
      orderNumber: "DJ-1",
      userId: "user-1",
      status: "PAID",
      paymentStatus: "APPROVED",
      totalAmount: 1000,
      paymentFailureReason: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const db = {
      transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          select: () => ({
            from: () => ({
              where: () => {
                selectCount += 1;
                if (selectCount === 3) return Promise.resolve([]);
                return {
                  limit: async () => {
                    if (selectCount === 1) return [{ orderId: "order-1" }];
                    if (selectCount === 2) return [order];
                    return [];
                  },
                };
              },
            }),
          }),
          insert: () => ({ values: async () => undefined }),
        }),
    };
    const service = new OrderService(db as never);
    await expect(service.checkoutCart("user-1", { idempotencyKey: "checkout-1" })).resolves.toMatchObject({
      orderId: "order-1",
      items: [],
    });
  });
});
