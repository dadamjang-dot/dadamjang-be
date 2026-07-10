import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { CustomBadRequestException, CustomNotFoundException } from "src/common/errors/custom-exceptions";
import { Database, DRIZZLE } from "src/modules/database/database.module";
import { activityEvents, cartItems, carts, productSkus, products } from "src/modules/database/schema";
import { CartType, UpsertCartItemInput } from "./cart.types";

@Injectable()
export class CartService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  getCart = async (userId: string): Promise<CartType> => {
    const cart = await this.getOrCreateCart(userId);
    const rows = await this.db
      .select()
      .from(cartItems)
      .innerJoin(productSkus, eq(cartItems.skuId, productSkus.skuId))
      .innerJoin(products, eq(productSkus.productId, products.productId))
      .where(eq(cartItems.cartId, cart.cartId));
    const items = rows.map(({ cartItems: item, productSkus: sku, products: product }) => ({
      ...item,
      sku,
      product: { ...product, skus: [sku] },
    }));
    return {
      cartId: cart.cartId,
      items,
      totalAmount: items.reduce((sum, item) => sum + item.sku.price * item.quantity, 0),
    };
  };

  upsertItem = async (userId: string, input: UpsertCartItemInput) => {
    if (input.quantity < 1) throw new CustomBadRequestException("Quantity must be positive");
    const [sku] = await this.db
      .select()
      .from(productSkus)
      .where(and(eq(productSkus.skuId, input.skuId), eq(productSkus.isActive, true)))
      .limit(1);
    if (!sku) throw new CustomNotFoundException("SKU not found");
    const cart = await this.getOrCreateCart(userId);
    await this.db
      .insert(cartItems)
      .values({ cartId: cart.cartId, skuId: input.skuId, quantity: input.quantity })
      .onConflictDoUpdate({
        target: [cartItems.cartId, cartItems.skuId],
        set: { quantity: input.quantity, updatedAt: new Date() },
      });
    await this.db.insert(activityEvents).values({
      actorUserId: userId,
      eventType: "CART_ITEM_UPSERTED",
      subjectType: "SKU",
      subjectId: input.skuId,
      payload: { quantity: input.quantity },
    });
    return this.getCart(userId);
  };

  removeItem = async (userId: string, skuId: string) => {
    const cart = await this.getOrCreateCart(userId);
    await this.db.delete(cartItems).where(and(eq(cartItems.cartId, cart.cartId), eq(cartItems.skuId, skuId)));
    await this.db.insert(activityEvents).values({
      actorUserId: userId,
      eventType: "CART_ITEM_REMOVED",
      subjectType: "SKU",
      subjectId: skuId,
    });
    return this.getCart(userId);
  };

  private getOrCreateCart = async (userId: string) => {
    const [cart] = await this.db.insert(carts).values({ userId }).onConflictDoNothing().returning();
    if (cart) return cart;
    const [existing] = await this.db.select().from(carts).where(eq(carts.userId, userId)).limit(1);
    if (!existing) throw new Error("Cart creation failed");
    return existing;
  };
}
