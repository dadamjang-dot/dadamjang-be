import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  CustomBadRequestException,
  CustomConflictException,
  CustomNotFoundException,
  CustomUnauthorizedException,
} from "src/common/errors/custom-exceptions";
import { requireResult } from "src/common/invariants/require-result";
import {
  assertCartItemCount,
  calculateCartTotal,
  MAX_CART_ITEMS,
  MAX_GRAPHQL_MONEY,
} from "src/modules/cart/cart-invariants";
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
  users,
} from "src/modules/database/schema";

type CheckoutInput = { idempotencyKey?: string; expectedCart?: unknown };
type ExpectedCartItem = {
  cartItemId: string;
  skuId: string;
  quantity: number;
  unitPrice: number;
};
const MAX_IDEMPOTENCY_KEY_LENGTH = 120;
const MAX_LEGACY_COLLECTION_SIZE = 100;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const orderNumber = () =>
  `DJ-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

const normalizeIdempotencyKey = (idempotencyKey: string | undefined) => {
  const checkoutKey = idempotencyKey?.trim();
  if (!checkoutKey) throw new CustomBadRequestException(OrderErrorMessage.IdempotencyKeyRequired);
  if ([...checkoutKey].length > MAX_IDEMPOTENCY_KEY_LENGTH)
    throw new CustomBadRequestException(OrderErrorMessage.IdempotencyKeyTooLong);
  return checkoutKey;
};

const invalidExpectedCart = () => new CustomBadRequestException(OrderErrorMessage.ExpectedCartInvalid);
const cartSnapshotChanged = () =>
  new CustomConflictException(OrderErrorMessage.CartSnapshotChanged, "CART_SNAPSHOT_CHANGED");

const validateExpectedCart = (expectedCart: unknown): ExpectedCartItem[] | undefined => {
  if (expectedCart === undefined || expectedCart === null) return undefined;
  if (!Array.isArray(expectedCart) || expectedCart.length < 1 || expectedCart.length > MAX_CART_ITEMS)
    throw invalidExpectedCart();
  const cartItemIds = new Set<string>();
  const skuIds = new Set<string>();
  const items: ExpectedCartItem[] = [];
  for (const value of expectedCart) {
    if (!value || typeof value !== "object") throw invalidExpectedCart();
    const item = value as Record<string, unknown>;
    const { cartItemId, skuId, quantity, unitPrice } = item;
    if (
      typeof cartItemId !== "string" ||
      !UUID_PATTERN.test(cartItemId) ||
      typeof skuId !== "string" ||
      !UUID_PATTERN.test(skuId) ||
      typeof quantity !== "number" ||
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      quantity > MAX_GRAPHQL_MONEY ||
      typeof unitPrice !== "number" ||
      !Number.isInteger(unitPrice) ||
      unitPrice < 0 ||
      unitPrice > MAX_GRAPHQL_MONEY
    )
      throw invalidExpectedCart();
    const normalizedCartItemId = cartItemId.toLowerCase();
    const normalizedSkuId = skuId.toLowerCase();
    if (cartItemIds.has(normalizedCartItemId) || skuIds.has(normalizedSkuId)) throw invalidExpectedCart();
    cartItemIds.add(normalizedCartItemId);
    skuIds.add(normalizedSkuId);
    items.push({ cartItemId: normalizedCartItemId, skuId: normalizedSkuId, quantity, unitPrice });
  }
  return items.sort((left, right) => left.cartItemId.localeCompare(right.cartItemId));
};

@Injectable()
export class OrderService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  checkoutAttempt = async (userId: string, idempotencyKey: string) => {
    const checkoutKey = normalizeIdempotencyKey(idempotencyKey);
    const [attempt] = await this.db
      .select({
        status: checkoutIdempotencyKeys.status,
        idempotencyOrderId: checkoutIdempotencyKeys.orderId,
        orderId: orders.orderId,
      })
      .from(checkoutIdempotencyKeys)
      .leftJoin(orders, and(eq(checkoutIdempotencyKeys.orderId, orders.orderId), eq(orders.userId, userId)))
      .where(and(eq(checkoutIdempotencyKeys.userId, userId), eq(checkoutIdempotencyKeys.idempotencyKey, checkoutKey)))
      .limit(1);
    if (!attempt || attempt.status !== "COMPLETED") return { status: "NOT_OBSERVED" as const, orderId: null };
    if (!attempt.idempotencyOrderId || !attempt.orderId) throw new Error(OrderErrorMessage.CheckoutAttemptMalformed);
    return { status: "CONFIRMED" as const, orderId: attempt.orderId };
  };

  checkoutCart = async (userId: string, input: CheckoutInput) => {
    const checkoutKey = normalizeIdempotencyKey(input.idempotencyKey);
    const expectedCart = validateExpectedCart(input.expectedCart);
    return this.db.transaction(async (tx) => {
      const [user] = await tx.select().from(users).where(eq(users.userId, userId)).limit(1).for("no key update");
      if (!user || user.deactivatedAt || user.anonymizedAt)
        throw new CustomUnauthorizedException(OrderErrorMessage.AuthenticationRequired);
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
        if (!existingIdempotency || existingIdempotency.status !== "COMPLETED")
          throw new CustomBadRequestException(OrderErrorMessage.CheckoutProcessing);
        if (!existingIdempotency.orderId) throw new Error(OrderErrorMessage.CheckoutAttemptMalformed);
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
      if (!cart) {
        if (expectedCart) throw cartSnapshotChanged();
        throw new CustomBadRequestException(OrderErrorMessage.CartEmpty);
      }
      const rows = await tx
        .select()
        .from(cartItems)
        .innerJoin(productSkus, eq(cartItems.skuId, productSkus.skuId))
        .innerJoin(products, eq(productSkus.productId, products.productId))
        .where(eq(cartItems.cartId, cart.cartId))
        .limit(MAX_CART_ITEMS + 1);
      assertCartItemCount(rows.length);
      if (expectedCart) {
        const currentCart = rows
          .map(({ cartItems: item, productSkus: sku }) => ({
            cartItemId: item.cartItemId,
            skuId: sku.skuId,
            quantity: item.quantity,
            unitPrice: sku.price,
          }))
          .sort((left, right) => left.cartItemId.localeCompare(right.cartItemId));
        if (
          currentCart.length !== expectedCart.length ||
          expectedCart.some((item, index) => {
            const currentItem = currentCart[index];
            return (
              !currentItem ||
              currentItem.cartItemId !== item.cartItemId ||
              currentItem.skuId !== item.skuId ||
              currentItem.quantity !== item.quantity ||
              currentItem.unitPrice !== item.unitPrice
            );
          })
        )
          throw cartSnapshotChanged();
      }
      if (rows.length === 0) throw new CustomBadRequestException(OrderErrorMessage.CartEmpty);
      if (rows.some(({ productSkus: sku, products: product }) => !sku.isActive || product.status !== "PUBLISHED"))
        throw new CustomBadRequestException(OrderErrorMessage.CartContainsUnavailableItem);
      const insufficientStock = rows.find(({ cartItems: item, productSkus: sku }) => sku.stock < item.quantity);
      if (insufficientStock)
        throw new CustomBadRequestException(getInsufficientStockMessage(insufficientStock.productSkus.code));
      const totalAmount = calculateCartTotal(
        rows.map(({ cartItems: item, productSkus: sku }) => ({ price: sku.price, quantity: item.quantity })),
      );
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
  };

  listOrders = async (userId: string) => {
    const userOrders = (
      await this.db
        .select()
        .from(orders)
        .where(eq(orders.userId, userId))
        .orderBy(desc(orders.createdAt))
        .limit(MAX_LEGACY_COLLECTION_SIZE)
    ).slice(0, MAX_LEGACY_COLLECTION_SIZE);
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
