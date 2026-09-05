import { CustomBadRequestException } from "src/common/errors/custom-exceptions";
import { MAX_GRAPHQL_MONEY } from "src/modules/cart/cart-invariants";
import { OrderErrorMessage } from "./order.error";
import { OrderService } from "./order.service";

type CheckoutAttemptService = {
  checkoutAttempt(userId: string, idempotencyKey: string): Promise<{ status: string; orderId: string | null }>;
};

const checkoutAttempt = (service: OrderService, userId: string, idempotencyKey: string) =>
  Promise.resolve().then(() => (service as unknown as CheckoutAttemptService).checkoutAttempt(userId, idempotencyKey));

const checkoutCart = (service: OrderService, input: unknown) => service.checkoutCart("user-1", input as never);

const snapshotItem = (index = 1) => ({
  cartItemId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  skuId: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  quantity: 1,
  unitPrice: 15000,
});

const listQuery = (rows: readonly unknown[]) => {
  const result = Promise.resolve(rows);
  const chain = {
    from: jest.fn(),
    leftJoin: jest.fn(),
    where: jest.fn(),
    orderBy: jest.fn(),
    limit: jest.fn().mockResolvedValue(rows),
    then: result.then.bind(result),
  };
  chain.from.mockReturnValue(chain);
  chain.leftJoin.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  return chain;
};

const lockedQuery = (rows: readonly unknown[]) => {
  const chain = {
    from: jest.fn(),
    where: jest.fn(),
    limit: jest.fn(),
    for: jest.fn().mockResolvedValue(rows),
  };
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.limit.mockReturnValue(chain);
  return chain;
};

describe("OrderService", () => {
  it.each([[], [{ status: "PROCESSING", idempotencyOrderId: null, orderId: null }]])(
    "returns NOT_OBSERVED when a checkout attempt is not committed",
    async (...rows) => {
      const service = new OrderService({ select: () => listQuery(rows) } as never);

      await expect(checkoutAttempt(service, "user-1", "checkout-1")).resolves.toEqual({
        status: "NOT_OBSERVED",
        orderId: null,
      });
    },
  );

  it("returns the owned completed checkout attempt", async () => {
    const service = new OrderService({
      select: () => listQuery([{ status: "COMPLETED", idempotencyOrderId: "order-1", orderId: "order-1" }]),
    } as never);

    await expect(checkoutAttempt(service, "user-1", " checkout-1 ")).resolves.toEqual({
      status: "CONFIRMED",
      orderId: "order-1",
    });
  });

  it("rejects a completed checkout attempt without an owned order", async () => {
    const service = new OrderService({
      select: () => listQuery([{ status: "COMPLETED", idempotencyOrderId: null, orderId: null }]),
    } as never);

    await expect(checkoutAttempt(service, "user-1", "checkout-1")).rejects.toThrow(
      "Completed checkout attempt is missing its order",
    );
  });

  it.each(["", "   ", "x".repeat(121)])("rejects an invalid checkout attempt key", async (idempotencyKey) => {
    const service = new OrderService({ select: jest.fn() } as never);

    await expect(checkoutAttempt(service, "user-1", idempotencyKey)).rejects.toBeInstanceOf(CustomBadRequestException);
  });

  it("accepts a 120-character checkout attempt key", async () => {
    const service = new OrderService({ select: () => listQuery([]) } as never);

    await expect(checkoutAttempt(service, "user-1", "😀".repeat(120))).resolves.toEqual({
      status: "NOT_OBSERVED",
      orderId: null,
    });
  });

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
    const select = jest.fn().mockReturnValueOnce(listQuery(orderRows)).mockReturnValueOnce(listQuery(itemRows));
    const service = new OrderService({ select } as never);

    await expect(service.listOrders("user-1")).resolves.toEqual([
      { ...orderRows[0], items: [itemRows[1]] },
      { ...orderRows[1], items: [itemRows[0]] },
    ]);
    expect(select).toHaveBeenCalledTimes(2);
  });

  it("limits legacy order hydration to the 100 newest order IDs", async () => {
    const orderRows = Array.from({ length: 101 }, (_, index) => ({
      orderId: `order-${index}`,
      createdAt: new Date(101 - index),
    }));
    const orderQuery = listQuery(orderRows);
    const itemQuery = listQuery([]);
    const select = jest.fn().mockReturnValueOnce(orderQuery).mockReturnValueOnce(itemQuery);
    const service = new OrderService({ select } as never);

    const result = await service.listOrders("user-1");

    const itemCondition = itemQuery.where.mock.calls[0]?.[0] as { queryChunks?: unknown[] };
    const orderIdParameters = itemCondition.queryChunks?.find(Array.isArray) as unknown[] | undefined;
    expect(result).toHaveLength(100);
    expect(orderQuery.limit).toHaveBeenCalledWith(100);
    expect(orderIdParameters).toHaveLength(100);
  });

  it("requires an idempotency key", async () => {
    const db = {
      transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({}),
    };
    const service = new OrderService(db as never);
    await expect(service.checkoutCart("user-1", {})).rejects.toThrow(OrderErrorMessage.IdempotencyKeyRequired);
  });

  it("rejects an idempotency key longer than the database contract", async () => {
    const service = new OrderService({
      transaction: async () => Promise.reject(new Error("transaction called")),
    } as never);

    await expect(checkoutCart(service, { idempotencyKey: "x".repeat(121) })).rejects.toThrow(
      OrderErrorMessage.IdempotencyKeyTooLong,
    );
  });

  it.each([
    ["not an array", {}],
    ["empty", []],
    ["missing item", [null]],
    ["too many", Array.from({ length: 101 }, (_, index) => snapshotItem(index + 1))],
    ["invalid cart item ID", [{ ...snapshotItem(), cartItemId: "not-a-uuid" }]],
    ["invalid SKU ID", [{ ...snapshotItem(), skuId: "not-a-uuid" }]],
    ["zero quantity", [{ ...snapshotItem(), quantity: 0 }]],
    ["fractional quantity", [{ ...snapshotItem(), quantity: 1.5 }]],
    ["oversized quantity", [{ ...snapshotItem(), quantity: MAX_GRAPHQL_MONEY + 1 }]],
    ["negative price", [{ ...snapshotItem(), unitPrice: -1 }]],
    ["fractional price", [{ ...snapshotItem(), unitPrice: 1.5 }]],
    ["oversized price", [{ ...snapshotItem(), unitPrice: MAX_GRAPHQL_MONEY + 1 }]],
    ["duplicate cart item ID", [snapshotItem(), { ...snapshotItem(2), cartItemId: snapshotItem().cartItemId }]],
    ["duplicate SKU ID", [snapshotItem(), { ...snapshotItem(2), skuId: snapshotItem().skuId }]],
    [
      "duplicate cart item ID casing",
      [
        { ...snapshotItem(), cartItemId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
        { ...snapshotItem(2), cartItemId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" },
      ],
    ],
    [
      "duplicate SKU ID casing",
      [
        { ...snapshotItem(), skuId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
        { ...snapshotItem(2), skuId: "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB" },
      ],
    ],
  ])("rejects an invalid expected cart snapshot: %s", async (_caseName, expectedCart) => {
    const service = new OrderService({
      transaction: async () => Promise.reject(new Error("transaction called")),
    } as never);

    await expect(checkoutCart(service, { idempotencyKey: "checkout-1", expectedCart })).rejects.toThrow(
      "expectedCart is invalid",
    );
  });

  it("rejects an empty cart after claiming an idempotency key", async () => {
    const userQuery = lockedQuery([{ userId: "user-1", deactivatedAt: null, anonymizedAt: null }]);
    const cartQuery = lockedQuery([]);
    const db = {
      transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          select: jest.fn().mockReturnValueOnce(userQuery).mockReturnValueOnce(cartQuery),
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
    const userQuery = lockedQuery([{ userId: "user-1", deactivatedAt: null, anonymizedAt: null }]);
    const idempotencyQuery = listQuery([{ status: "COMPLETED", orderId: "order-1" }]);
    const orderQuery = listQuery([order]);
    const itemQuery = listQuery([]);
    const db = {
      transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          select: jest
            .fn()
            .mockReturnValueOnce(userQuery)
            .mockReturnValueOnce(idempotencyQuery)
            .mockReturnValueOnce(orderQuery)
            .mockReturnValueOnce(itemQuery),
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

  it.each([
    [{ status: "PROCESSING", orderId: "order-1" }, OrderErrorMessage.CheckoutProcessing],
    [{ status: "COMPLETED", orderId: null }, OrderErrorMessage.CheckoutAttemptMalformed],
  ])("does not replay a malformed idempotency record %#", async (idempotencyRecord, expectedMessage) => {
    const userQuery = lockedQuery([{ userId: "user-1", deactivatedAt: null, anonymizedAt: null }]);
    const idempotencyQuery = listQuery([idempotencyRecord]);
    const db = {
      transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          select: jest.fn().mockReturnValueOnce(userQuery).mockReturnValueOnce(idempotencyQuery),
          insert: () => ({
            values: () => ({ onConflictDoNothing: () => ({ returning: async () => [] }) }),
          }),
        }),
    };
    const service = new OrderService(db as never);

    await expect(service.checkoutCart("user-1", { idempotencyKey: "checkout-1" })).rejects.toThrow(expectedMessage);
  });
});
