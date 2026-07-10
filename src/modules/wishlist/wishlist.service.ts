import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { CatalogService } from "src/modules/catalog/catalog.service";
import { CustomNotFoundException } from "src/common/errors/custom-exceptions";
import { Database, DRIZZLE } from "src/modules/database/database.module";
import { activityEvents, products, wishlists } from "src/modules/database/schema";

@Injectable()
export class WishlistService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly catalogService: CatalogService,
  ) {}

  list = async (userId: string) => {
    const rows = await this.db
      .select()
      .from(wishlists)
      .innerJoin(products, eq(wishlists.productId, products.productId))
      .where(eq(wishlists.userId, userId))
      .orderBy(desc(wishlists.createdAt));
    const productById = new Map(
      (await Promise.all(rows.map(({ products: product }) => this.catalogService.getProduct(product.productId)))).map(
        (product) => [product.productId, product],
      ),
    );
    return rows.map(({ wishlists: wishlist }) => ({
      ...wishlist,
      product: productById.get(wishlist.productId)!,
    }));
  };

  add = async (userId: string, productId: string) => {
    const [product] = await this.db.select().from(products).where(eq(products.productId, productId)).limit(1);
    if (!product || product.status !== "PUBLISHED") throw new CustomNotFoundException("Product not found");
    const [wishlist] = await this.db.insert(wishlists).values({ userId, productId }).onConflictDoNothing().returning();
    await this.db.insert(activityEvents).values({
      actorUserId: userId,
      eventType: "WISHLIST_ADDED",
      subjectType: "PRODUCT",
      subjectId: productId,
    });
    if (wishlist) return wishlist;
    const [existing] = await this.db
      .select()
      .from(wishlists)
      .where(and(eq(wishlists.userId, userId), eq(wishlists.productId, productId)))
      .limit(1);
    if (!existing) throw new Error("Wishlist creation failed");
    return existing;
  };

  remove = async (userId: string, productId: string) => {
    await this.db.delete(wishlists).where(and(eq(wishlists.userId, userId), eq(wishlists.productId, productId)));
    await this.db.insert(activityEvents).values({
      actorUserId: userId,
      eventType: "WISHLIST_REMOVED",
      subjectType: "PRODUCT",
      subjectId: productId,
    });
    return true;
  };
}
