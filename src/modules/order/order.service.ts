import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, inArray } from "drizzle-orm";
import { CustomBadRequestException, CustomNotFoundException } from "src/common/errors/custom-exceptions";
import { requireResult } from "src/common/invariants/require-result";
import { OrderErrorMessage, getInsufficientStockMessage } from "./order.error";
import { Database, DRIZZLE } from "src/modules/database/database.module";
import {
  activityEvents,
  cartItems,
  carts,
  checkoutIdempotencyKeys,
  orderItems,
  orders,
  productSkus,
  products,
} from "src/modules/database/schema";

type CheckoutInput = { idempotencyKey?: string };
const orderNumber = () =>
  `DJ-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

@Injectable()
export class OrderService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  checkoutCart = async (userId: string, input: CheckoutInput) =>
    this.db.transaction(async (tx) => {
      if (!input.idempotencyKey?.trim()) throw new CustomBadRequestException(OrderErrorMessage.IdempotencyKeyRequired);
      const checkoutKey = input.idempotencyKey.trim();
      const [idempotencyRecord] = await tx
        .insert(checkoutIdempotencyKeys)
        .values({ userId, idempotencyKey: checkoutKey })
        .onConflictDoNothing({ target: [checkoutIdempotencyKeys.userId, checkoutIdempotencyKeys.idempotencyKey] })
        .returning();
      if (!idempotencyRecord) {
        const [existingIdempotency] = await tx
          .select()
          .from(checkoutIdempotencyKeys)
          .where(
            and(eq(checkoutIdempotencyKeys.userId, userId), eq(checkoutIdempotencyKeys.idempotencyKey, checkoutKey)),
          )
          .limit(1);
        if (!existingIdempotency?.orderId) throw new CustomBadRequestException(OrderErrorMessage.CheckoutProcessing);
        await tx.insert(activityEvents).values({
          actorUserId: userId,
          eventType: "CHECKOUT_IDEMPOTENCY_REUSED",
          subjectType: "ORDER",
          subjectId: existingIdempotency.orderId,
          payload: { idempotencyKey: checkoutKey },
        });
        return this.getOrderInTransaction(tx, userId, existingIdempotency.orderId);
      }

      const [cart] = await tx.select().from(carts).where(eq(carts.userId, userId)).limit(1).for("update");
      if (!cart) throw new CustomBadRequestException(OrderErrorMessage.CartEmpty);
      const rows = await tx
        .select()
        .from(cartItems)
        .innerJoin(productSkus, eq(cartItems.skuId, productSkus.skuId))
        .innerJoin(products, eq(productSkus.productId, products.productId))
        .where(eq(cartItems.cartId, cart.cartId));
      if (rows.length === 0) throw new CustomBadRequestException(OrderErrorMessage.CartEmpty);
      if (rows.some(({ productSkus: sku, products: product }) => !sku.isActive || product.status !== "PUBLISHED"))
        throw new CustomBadRequestException(OrderErrorMessage.CartContainsUnavailableItem);
      const insufficientStock = rows.find(({ cartItems: item, productSkus: sku }) => sku.stock < item.quantity);
      if (insufficientStock)
        throw new CustomBadRequestException(getInsufficientStockMessage(insufficientStock.productSkus.code));
      const totalAmount = rows.reduce((sum, row) => sum + row.productSkus.price * row.cartItems.quantity, 0);
      const order = requireResult(
        (await tx.insert(orders).values({ orderNumber: orderNumber(), userId, totalAmount }).returning())[0],
      );
      await tx.insert(orderItems).values(
        rows.map(({ cartItems: item, productSkus: sku, products: product }) => ({
          orderId: order.orderId,
          productId: product.productId,
          skuId: sku.skuId,
          productTitle: product.title,
          skuOptionName: sku.optionName,
          unitPrice: sku.price,
          quantity: item.quantity,
        })),
      );
      await tx.delete(cartItems).where(eq(cartItems.cartId, cart.cartId));
      await tx.insert(activityEvents).values({
        actorUserId: userId,
        eventType: "ORDER_PAYMENT_PENDING",
        subjectType: "ORDER",
        subjectId: order.orderId,
        payload: { totalAmount },
      });
      await this.markIdempotencyCompleted(tx, idempotencyRecord.checkoutIdempotencyKeyId, order.orderId);
      return {
        ...order,
        items: await tx.select().from(orderItems).where(eq(orderItems.orderId, order.orderId)),
      };
    });

  listOrders = async (userId: string) => {
    const userOrders = await this.db
      .select()
      .from(orders)
      .where(eq(orders.userId, userId))
      .orderBy(desc(orders.createdAt));
    if (!userOrders.length) return [];
    const items = await this.db
      .select()
      .from(orderItems)
      .where(
        inArray(
          orderItems.orderId,
          userOrders.map(({ orderId }) => orderId),
        ),
      );
    const itemsByOrder = new Map<string, typeof items>();
    for (const item of items) {
      const orderItemRows = itemsByOrder.get(item.orderId) ?? [];
      orderItemRows.push(item);
      itemsByOrder.set(item.orderId, orderItemRows);
    }
    return userOrders.map((order) => ({ ...order, items: itemsByOrder.get(order.orderId) ?? [] }));
  };

  getOrder = async (userId: string, orderId: string) => {
    return this.getOrderInTransaction(this.db, userId, orderId);
  };

  private getOrderInTransaction = async (tx: Pick<Database, "select">, userId: string, orderId: string) => {
    const [order] = await tx
      .select()
      .from(orders)
      .where(and(eq(orders.orderId, orderId), eq(orders.userId, userId)))
      .limit(1);
    if (!order) throw new CustomNotFoundException(OrderErrorMessage.OrderNotFound);
    return {
      ...order,
      items: await tx.select().from(orderItems).where(eq(orderItems.orderId, orderId)),
    };
  };

  private markIdempotencyCompleted = async (
    tx: Pick<Database, "update">,
    checkoutIdempotencyKeyId: string,
    orderId: string,
  ) =>
    tx
      .update(checkoutIdempotencyKeys)
      .set({ orderId, status: "COMPLETED", updatedAt: new Date() })
      .where(eq(checkoutIdempotencyKeys.checkoutIdempotencyKeyId, checkoutIdempotencyKeyId));
}
