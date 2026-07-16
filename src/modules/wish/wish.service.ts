import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { WishErrorMessage } from "./wish.error";
import { CatalogService } from "src/modules/catalog/catalog.service";
import { CustomNotFoundException } from "src/common/errors/custom-exceptions";
import { Database, DRIZZLE } from "src/modules/database/database.module";
import { activityEvents, products, wishes } from "src/modules/database/schema";

@Injectable()
export class WishService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly catalogService: CatalogService,
  ) {}

  list = async (userId: string) => {
    const rows = await this.db
      .select()
      .from(wishes)
      .innerJoin(products, eq(wishes.productId, products.productId))
      .where(eq(wishes.userId, userId))
      .orderBy(desc(wishes.createdAt));
    const productById = new Map(
      (await Promise.all(rows.map(({ products: product }) => this.catalogService.getProduct(product.productId)))).map(
        (product) => [product.productId, product],
      ),
    );
    return rows.map(({ wishes: wish }) => ({
      ...wish,
      product: productById.get(wish.productId)!,
    }));
  };

  add = async (userId: string, productId: string) => {
    const [product] = await this.db.select().from(products).where(eq(products.productId, productId)).limit(1);
    if (!product || product.status !== "PUBLISHED") throw new CustomNotFoundException(WishErrorMessage.ProductNotFound);
    const [wish] = await this.db.insert(wishes).values({ userId, productId }).onConflictDoNothing().returning();
    await this.db.insert(activityEvents).values({
      actorUserId: userId,
      eventType: "WISH_ADDED",
      subjectType: "PRODUCT",
      subjectId: productId,
    });
    if (wish) return wish;
    const [existing] = await this.db
      .select()
      .from(wishes)
      .where(and(eq(wishes.userId, userId), eq(wishes.productId, productId)))
      .limit(1);
    if (!existing) throw new Error("Wish creation failed");
    return existing;
  };

  remove = async (userId: string, productId: string) => {
    await this.db.delete(wishes).where(and(eq(wishes.userId, userId), eq(wishes.productId, productId)));
    await this.db.insert(activityEvents).values({
      actorUserId: userId,
      eventType: "WISH_REMOVED",
      subjectType: "PRODUCT",
      subjectId: productId,
    });
    return true;
  };
}
