import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { CustomBadRequestException, CustomNotFoundException } from "src/common/errors/custom-exceptions";
import { Database, DRIZZLE } from "src/modules/database/database.module";
import {
  activityEvents,
  cartItems,
  carts,
  orderItems,
  orders,
  productSkus,
  products,
} from "src/modules/database/schema";

type CheckoutInput = { forcePaymentFailure?: boolean };
const orderNumber = () =>
  `DJ-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
const allowedTransitions: Record<string, string[]> = {
  PAYMENT_PENDING: ["PAID", "PAYMENT_FAILED"],
  PAID: ["PREPARING", "CANCELLED"],
  PREPARING: ["SHIPPED", "CANCELLED"],
  SHIPPED: ["DELIVERED"],
  DELIVERED: [],
  PAYMENT_FAILED: [],
};

@Injectable()
export class OrderService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  checkoutCart = async (userId: string, input: CheckoutInput) =>
    this.db.transaction(async (tx) => {
      const [cart] = await tx.select().from(carts).where(eq(carts.userId, userId)).limit(1);
      if (!cart) throw new CustomBadRequestException("Cart is empty");
      const rows = await tx
        .select()
        .from(cartItems)
        .innerJoin(productSkus, eq(cartItems.skuId, productSkus.skuId))
        .innerJoin(products, eq(productSkus.productId, products.productId))
        .where(eq(cartItems.cartId, cart.cartId));
      if (rows.length === 0) throw new CustomBadRequestException("Cart is empty");
      if (rows.some(({ productSkus: sku, products: product }) => !sku.isActive || product.status !== "PUBLISHED"))
        throw new CustomBadRequestException("Cart contains an unavailable item");
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
            status: "PAYMENT_FAILED",
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
        if (!updatedSku) throw new CustomBadRequestException(`Insufficient stock for ${row.productSkus.code}`);
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
    const [order] = await this.db
      .select()
      .from(orders)
      .where(and(eq(orders.orderId, orderId), eq(orders.userId, userId)))
      .limit(1);
    if (!order) throw new CustomNotFoundException("Order not found");
    return {
      ...order,
      items: await this.db.select().from(orderItems).where(eq(orderItems.orderId, orderId)),
    };
  };

  transitionOrder = async (orderId: string, nextStatus: string) => {
    const [order] = await this.db.select().from(orders).where(eq(orders.orderId, orderId)).limit(1);
    if (!order) throw new CustomNotFoundException("Order not found");
    if (!allowedTransitions[order.status]?.includes(nextStatus))
      throw new CustomBadRequestException(`Cannot transition ${order.status} to ${nextStatus}`);
    const [updated] = await this.db
      .update(orders)
      .set({ status: nextStatus, updatedAt: new Date() })
      .where(eq(orders.orderId, orderId))
      .returning();
    return updated;
  };
}
