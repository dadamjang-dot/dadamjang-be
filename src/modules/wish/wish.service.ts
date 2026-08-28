import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { WishErrorMessage } from "./wish.error";
import { CatalogService } from "src/modules/catalog/catalog.service";
import { CustomNotFoundException } from "src/common/errors/custom-exceptions";
import { Database, DRIZZLE } from "src/modules/database/database.module";
import { activityEvents, products, wishes } from "src/modules/database/schema";

const MAX_LEGACY_COLLECTION_SIZE = 100;

@Injectable()
export class WishService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly catalogService: CatalogService,
  ) {}

  list = async (userId: string) => {
    const rows = (
      await this.db
        .select()
        .from(wishes)
        .where(eq(wishes.userId, userId))
        .orderBy(desc(wishes.createdAt))
        .limit(MAX_LEGACY_COLLECTION_SIZE)
    ).slice(0, MAX_LEGACY_COLLECTION_SIZE);
    const productById = new Map(
      (await this.catalogService.getProductsByIds(rows.map((wish) => wish.productId))).map((product) => [
        product.productId,
        product,
      ]),
    );
    return rows.map((wish) => {
      const product = productById.get(wish.productId);
      if (!product) throw new CustomNotFoundException(WishErrorMessage.ProductNotFound);
      return { ...wish, product };
    });
  };

  add = async (userId: string, productId: string) => {
    const [product] = await this.db.select().from(products).where(eq(products.productId, productId)).limit(1);
    if (!product || product.status !== "PUBLISHED") throw new CustomNotFoundException(WishErrorMessage.ProductNotFound);
    return this.db.transaction(async (tx) => {
      const [wish] = await tx.insert(wishes).values({ userId, productId }).onConflictDoNothing().returning();
      if (wish) {
        await tx.insert(activityEvents).values({
          actorUserId: userId,
          eventType: "WISH_ADDED",
          subjectType: "PRODUCT",
          subjectId: productId,
        });
        return wish;
      }
      const [existing] = await tx
        .select()
        .from(wishes)
        .where(and(eq(wishes.userId, userId), eq(wishes.productId, productId)))
        .limit(1);
      if (!existing) throw new Error("Wish creation failed");
      return existing;
    });
  };

  remove = async (userId: string, productId: string) => {
    await this.db.transaction(async (tx) => {
      const [removed] = await tx
        .delete(wishes)
        .where(and(eq(wishes.userId, userId), eq(wishes.productId, productId)))
        .returning({ productId: wishes.productId });
      if (!removed) return;
      await tx.insert(activityEvents).values({
        actorUserId: userId,
        eventType: "WISH_REMOVED",
        subjectType: "PRODUCT",
        subjectId: productId,
      });
    });
    return true;
  };
}
