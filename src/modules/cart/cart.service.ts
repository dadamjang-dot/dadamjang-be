import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { CustomBadRequestException, CustomNotFoundException } from "src/common/errors/custom-exceptions";
import { Database, DRIZZLE } from "src/modules/database/database.module";
import { activityEvents, brands, cartItems, carts, productSkus, products } from "src/modules/database/schema";
import { CartErrorMessage, getInsufficientStockMessage } from "./cart.error";
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
      .leftJoin(brands, eq(products.brandId, brands.brandId))
      .where(eq(cartItems.cartId, cart.cartId));
    const items = rows.map(({ brands: brand, cartItems: item, productSkus: sku, products: product }) => ({
      ...item,
      sku,
      product: {
        ...product,
        brand: brand ? { brandId: brand.brandId, name: brand.name, slug: brand.slug } : null,
        skus: [sku],
      },
    }));
    return {
      cartId: cart.cartId,
      items,
      totalAmount: items.reduce((sum, item) => sum + item.sku.price * item.quantity, 0),
    };
  };

  upsertItem = async (userId: string, input: UpsertCartItemInput) => {
    if (input.quantity < 1) throw new CustomBadRequestException(CartErrorMessage.QuantityMustBePositive);
    const [row] = await this.db
      .select()
      .from(productSkus)
      .innerJoin(products, eq(productSkus.productId, products.productId))
      .where(and(eq(productSkus.skuId, input.skuId), eq(productSkus.isActive, true)))
      .limit(1);
    if (!row) throw new CustomNotFoundException(CartErrorMessage.SkuNotFound);
    if (row.products.status !== "PUBLISHED") throw new CustomBadRequestException(CartErrorMessage.ProductUnavailable);
    if (row.productSkus.stock < input.quantity)
      throw new CustomBadRequestException(getInsufficientStockMessage(row.productSkus.code));
    await this.db.transaction(async (tx) => {
      const cart = await this.getOrCreateLockedCart(tx, userId);
      await tx
        .insert(cartItems)
        .values({ cartId: cart.cartId, skuId: input.skuId, quantity: input.quantity })
        .onConflictDoUpdate({
          target: [cartItems.cartId, cartItems.skuId],
          set: { quantity: input.quantity, updatedAt: new Date() },
        });
      await tx.insert(activityEvents).values({
        actorUserId: userId,
        eventType: "CART_ITEM_UPSERTED",
        subjectType: "SKU",
        subjectId: input.skuId,
        payload: { quantity: input.quantity },
      });
    });
    return this.getCart(userId);
  };

  removeItem = async (userId: string, skuId: string) => {
    await this.db.transaction(async (tx) => {
      const cart = await this.getOrCreateLockedCart(tx, userId);
      const [removed] = await tx
        .delete(cartItems)
        .where(and(eq(cartItems.cartId, cart.cartId), eq(cartItems.skuId, skuId)))
        .returning({ skuId: cartItems.skuId });
      if (!removed) return;
      await tx.insert(activityEvents).values({
        actorUserId: userId,
        eventType: "CART_ITEM_REMOVED",
        subjectType: "SKU",
        subjectId: skuId,
      });
    });
    return this.getCart(userId);
  };

  private getOrCreateLockedCart = async (tx: Pick<Database, "insert" | "select">, userId: string) => {
    await tx.insert(carts).values({ userId }).onConflictDoNothing();
    const [cart] = await tx.select().from(carts).where(eq(carts.userId, userId)).limit(1).for("update");
    if (!cart) throw new Error(CartErrorMessage.CartCreationFailed);
    return cart;
  };

  private getOrCreateCart = async (userId: string) => {
    const [cart] = await this.db.insert(carts).values({ userId }).onConflictDoNothing().returning();
    if (cart) return cart;
    const [existing] = await this.db.select().from(carts).where(eq(carts.userId, userId)).limit(1);
    if (!existing) throw new Error(CartErrorMessage.CartCreationFailed);
    return existing;
  };
}
