import { CustomBadRequestException } from "src/common/errors/custom-exceptions";
import { OrderErrorMessage } from "./order.error";
import { OrderService } from "./order.service";

describe("OrderService", () => {
  it("requires an idempotency key", async () => {
    const db = {
      transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({}),
    };
    const service = new OrderService(db as never);
    await expect(service.checkoutCart("user-1", {})).rejects.toThrow(OrderErrorMessage.IdempotencyKeyRequired);
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

  it("records a payment failure without decrementing stock", async () => {
    let selectCount = 0;
    const skuUpdate = jest.fn();
    const row = {
      cartItems: { quantity: 1 },
      productSkus: { skuId: "sku-1", code: "SKU-1", price: 1000, stock: 1, isActive: true },
      products: { productId: "product-1", title: "Product", status: "PUBLISHED" },
    };
    const db = {
      transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          select: () => ({
            from: () => ({
              innerJoin: () => ({ innerJoin: () => ({ where: async () => [row] }) }),
              where: () => ({
                limit: async () => {
                  selectCount += 1;
                  return selectCount === 1 ? [] : [{ cartId: "cart-1" }];
                },
              }),
            }),
          }),
          insert: () => ({
            values: () => ({
              returning: async () =>
                selectCount === 1
                  ? [{ checkoutIdempotencyKeyId: "key-1" }]
                  : [{ orderId: "order-1", status: "PAYMENT_PENDING" }],
            }),
          }),
          update: (table: unknown) => {
            if (String(table).includes("productSkus")) skuUpdate();
            return {
              set: () => ({
                where: () => ({
                  returning: async () => [
                    {
                      orderId: "order-1",
                      status: "FAILED",
                      paymentStatus: "FAILED",
                      paymentFailureReason: "Mock payment rejected",
                    },
                  ],
                }),
              }),
            };
          },
        }),
    };
    const service = new OrderService(db as never);
    await expect(
      service.checkoutCart("user-1", { idempotencyKey: "checkout-failure", forcePaymentFailure: true }),
    ).resolves.toMatchObject({ status: "FAILED", paymentStatus: "FAILED" });
    expect(skuUpdate).not.toHaveBeenCalled();
  });
});
