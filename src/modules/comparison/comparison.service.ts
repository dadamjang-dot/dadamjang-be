import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { CustomNotFoundException } from "src/common/errors/custom-exceptions";
import { ComparisonErrorMessage } from "./comparison.error";
import { CatalogService } from "src/modules/catalog/catalog.service";
import { Database, DRIZZLE } from "src/modules/database/database.module";
import { activityEvents, comparisonItems } from "src/modules/database/schema";

@Injectable()
export class ComparisonService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly catalogService: CatalogService,
  ) {}

  list = async (userId: string) => {
    const rows = await this.db
      .select()
      .from(comparisonItems)
      .where(eq(comparisonItems.userId, userId))
      .orderBy(desc(comparisonItems.createdAt));
    const productById = new Map(
      (await this.catalogService.getProductsByIds(rows.map(({ productId }) => productId))).map((product) => [
        product.productId,
        product,
      ]),
    );

    return rows.map((item) => {
      const product = productById.get(item.productId);
      if (!product) throw new CustomNotFoundException(ComparisonErrorMessage.ProductNotFound);
      return { ...item, product };
    });
  };

  listPriceSummaries = async (userId: string) => {
    const rows = await this.db
      .select()
      .from(comparisonItems)
      .where(eq(comparisonItems.userId, userId))
      .orderBy(desc(comparisonItems.createdAt));

    return this.catalogService.getProductPriceSummariesByIds(rows.map((row) => row.productId));
  };

  add = async (userId: string, productId: string) => {
    const product = await this.catalogService.getProduct(productId);
    if (!product || product.status !== "PUBLISHED")
      throw new CustomNotFoundException(ComparisonErrorMessage.ProductNotFound);
    const [item] = await this.db
      .insert(comparisonItems)
      .values({ userId, productId })
      .onConflictDoNothing()
      .returning();
    await this.db.insert(activityEvents).values({
      actorUserId: userId,
      eventType: "COMPARISON_ITEM_ADDED",
      subjectType: "PRODUCT",
      subjectId: productId,
    });
    if (item) return { ...item, product };
    const [existing] = await this.db
      .select()
      .from(comparisonItems)
      .where(and(eq(comparisonItems.userId, userId), eq(comparisonItems.productId, productId)))
      .limit(1);
    return { ...existing, product };
  };

  remove = async (userId: string, productId: string) => {
    await this.db
      .delete(comparisonItems)
      .where(and(eq(comparisonItems.userId, userId), eq(comparisonItems.productId, productId)));
    await this.db.insert(activityEvents).values({
      actorUserId: userId,
      eventType: "COMPARISON_ITEM_REMOVED",
      subjectType: "PRODUCT",
      subjectId: productId,
    });
    return true;
  };
}
