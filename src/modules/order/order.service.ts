import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { CustomBadRequestException, CustomNotFoundException } from "src/common/errors/custom-exceptions";
import { ALLOWED_TRANSITIONS } from "./order.constant";
import { OrderErrorMessage, getInsufficientStockMessage, getCannotTransitionMessage } from "./order.error";
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

type CheckoutInput = { forcePaymentFailure?: boolean; idempotencyKey?: string };
const orderNumber = () =>
  `DJ-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

@Injectable()
export class OrderService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  checkoutCart = async (userId: string, input: CheckoutInput) =>
    this.db.transaction(async (tx) => {
      if (!input.idempotencyKey?.trim()) throw new CustomBadRequestException(OrderErrorMessage.IdempotencyKeyRequired);
      const checkoutKey = input.idempotencyKey.trim();
      const [existingIdempotency] = await tx
        .select()
        .from(checkoutIdempotencyKeys)
        .where(and(eq(checkoutIdempotencyKeys.userId, userId), eq(checkoutIdempotencyKeys.idempotencyKey, checkoutKey)))
        .limit(1);
      if (existingIdempotency?.orderId) {
        await tx.insert(activityEvents).values({
          actorUserId: userId,
          eventType: "CHECKOUT_IDEMPOTENCY_REUSED",
          subjectType: "ORDER",
          subjectId: existingIdempotency.orderId,
          payload: { idempotencyKey: checkoutKey },
        });
        return this.getOrderInTransaction(tx, userId, existingIdempotency.orderId);
      }
      if (existingIdempotency) throw new CustomBadRequestException(OrderErrorMessage.CheckoutProcessing);
      const [idempotencyRecord] = await tx
        .insert(checkoutIdempotencyKeys)
        .values({ userId, idempotencyKey: checkoutKey })
        .returning();

      const [cart] = await tx.select().from(carts).where(eq(carts.userId, userId)).limit(1);
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
      const totalAmount = rows.reduce((sum, row) => sum + row.productSkus.price * row.cartItems.quantity, 0);
      const [order] = await tx.insert(orders).values({ orderNumber: orderNumber(), userId, totalAmount }).returning();
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
      if (input.forcePaymentFailure) {
        const [failedOrder] = await tx
          .update(orders)
          .set({
            status: "FAILED",
            paymentStatus: "FAILED",
            paymentFailureReason: "Mock payment rejected",
            updatedAt: new Date(),
          })
          .where(eq(orders.orderId, order.orderId))
          .returning();
        await tx.insert(activityEvents).values({
          actorUserId: userId,
          eventType: "ORDER_PAYMENT_FAILED",
          subjectType: "ORDER",
          subjectId: order.orderId,
          payload: { totalAmount },
        });
        await this.markIdempotencyCompleted(
          tx,
          idempotencyRecord.checkoutIdempotencyKeyId,
          failedOrder.orderId,
          "FAILED",
        );
        return {
          ...failedOrder,
          items: await tx.select().from(orderItems).where(eq(orderItems.orderId, order.orderId)),
        };
      }
      for (const row of rows) {
        const [updatedSku] = await tx
          .update(productSkus)
          .set({
            stock: sql`${productSkus.stock} - ${row.cartItems.quantity}`,
            updatedAt: new Date(),
          })
          .where(and(eq(productSkus.skuId, row.productSkus.skuId), gte(productSkus.stock, row.cartItems.quantity)))
          .returning();
        if (!updatedSku) throw new CustomBadRequestException(getInsufficientStockMessage(row.productSkus.code));
      }
      const [paidOrder] = await tx
        .update(orders)
        .set({ status: "PAID", paymentStatus: "APPROVED", updatedAt: new Date() })
        .where(eq(orders.orderId, order.orderId))
        .returning();
      await tx.delete(cartItems).where(eq(cartItems.cartId, cart.cartId));
      await tx.insert(activityEvents).values({
        actorUserId: userId,
        eventType: "ORDER_PAID",
        subjectType: "ORDER",
        subjectId: order.orderId,
        payload: { totalAmount },
      });
      await this.markIdempotencyCompleted(
        tx,
        idempotencyRecord.checkoutIdempotencyKeyId,
        paidOrder.orderId,
        "COMPLETED",
      );
      return {
        ...paidOrder,
        items: await tx.select().from(orderItems).where(eq(orderItems.orderId, order.orderId)),
      };
    });

  listOrders = async (userId: string) => {
    const userOrders = await this.db
      .select()
      .from(orders)
      .where(eq(orders.userId, userId))
      .orderBy(desc(orders.createdAt));
    return Promise.all(userOrders.map((order) => this.getOrder(userId, order.orderId)));
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
    status: "COMPLETED" | "FAILED",
  ) =>
    tx
      .update(checkoutIdempotencyKeys)
      .set({ orderId, status, updatedAt: new Date() })
      .where(eq(checkoutIdempotencyKeys.checkoutIdempotencyKeyId, checkoutIdempotencyKeyId));

  transitionOrder = async (orderId: string, nextStatus: string) => {
    const [order] = await this.db.select().from(orders).where(eq(orders.orderId, orderId)).limit(1);
    if (!order) throw new CustomNotFoundException(OrderErrorMessage.OrderNotFound);
    if (!ALLOWED_TRANSITIONS[order.status]?.includes(nextStatus))
      throw new CustomBadRequestException(getCannotTransitionMessage(order.status, nextStatus));
    const [updated] = await this.db
      .update(orders)
      .set({ status: nextStatus, updatedAt: new Date() })
      .where(eq(orders.orderId, orderId))
      .returning();
    return updated;
  };
}
