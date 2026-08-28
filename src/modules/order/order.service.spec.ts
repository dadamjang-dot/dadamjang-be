import { CustomBadRequestException } from "src/common/errors/custom-exceptions";
import { OrderErrorMessage } from "./order.error";
import { OrderService } from "./order.service";

describe("OrderService", () => {
  it("loads an order list and all items in two queries", async () => {
    const createdAt = new Date("2026-08-29T00:00:00Z");
    const orderRows = [
      {
        orderId: "order-2",
        orderNumber: "DJ-2",
        userId: "user-1",
        status: "PAID",
        paymentStatus: "APPROVED",
        totalAmount: 2000,
        paymentFailureReason: null,
        createdAt,
        updatedAt: createdAt,
      },
      {
        orderId: "order-1",
        orderNumber: "DJ-1",
        userId: "user-1",
        status: "PAID",
        paymentStatus: "APPROVED",
        totalAmount: 1000,
        paymentFailureReason: null,
        createdAt,
        updatedAt: createdAt,
      },
    ];
    const itemRows = [
      { orderItemId: "item-1", orderId: "order-1" },
      { orderItemId: "item-2", orderId: "order-2" },
    ];
    const select = jest
      .fn()
      .mockReturnValueOnce({
        from: () => ({ where: () => ({ orderBy: async () => orderRows }) }),
      })
      .mockReturnValueOnce({
        from: () => ({ where: async () => itemRows }),
      });
    const service = new OrderService({ select } as never);

    await expect(service.listOrders("user-1")).resolves.toEqual([
      { ...orderRows[0], items: [itemRows[1]] },
      { ...orderRows[1], items: [itemRows[0]] },
    ]);
    expect(select).toHaveBeenCalledTimes(2);
  });

  it("requires an idempotency key", async () => {
    const db = {
      transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({}),
    };
    const service = new OrderService(db as never);
    await expect(service.checkoutCart("user-1", {})).rejects.toThrow(OrderErrorMessage.IdempotencyKeyRequired);
  });

  it("rejects an empty cart after claiming an idempotency key", async () => {
    const db = {
      transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          select: () => ({ from: () => ({ where: () => ({ limit: () => ({ for: async () => [] }) }) }) }),
          insert: () => ({
            values: () => ({
              onConflictDoNothing: () => ({ returning: async () => [{ checkoutIdempotencyKeyId: "key-1" }] }),
            }),
          }),
        }),
    };
    const service = new OrderService(db as never);
    await expect(service.checkoutCart("user-1", { idempotencyKey: "checkout-1" })).rejects.toBeInstanceOf(
      CustomBadRequestException,
    );
  });

  it("returns the existing order for a reused idempotency key", async () => {
    let insertCount = 0;
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
          insert: () => ({
            values: () => {
              insertCount += 1;
              if (insertCount === 1) return { onConflictDoNothing: () => ({ returning: async () => [] }) };
              return Promise.resolve();
            },
          }),
        }),
    };
    const service = new OrderService(db as never);
    await expect(service.checkoutCart("user-1", { idempotencyKey: "checkout-1" })).resolves.toMatchObject({
      orderId: "order-1",
      items: [],
    });
  });
});
