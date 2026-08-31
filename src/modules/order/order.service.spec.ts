import { CustomBadRequestException } from "src/common/errors/custom-exceptions";
import { OrderErrorMessage } from "./order.error";
import { OrderService } from "./order.service";

const listQuery = (rows: readonly unknown[]) => {
  const result = Promise.resolve(rows);
  const chain = {
    from: jest.fn(),
    where: jest.fn(),
    orderBy: jest.fn(),
    limit: jest.fn().mockResolvedValue(rows),
    then: result.then.bind(result),
  };
  chain.from.mockReturnValue(chain);
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
    const idempotencyQuery = listQuery([{ orderId: "order-1" }]);
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
});
