import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { CustomNotFoundException } from "src/common/errors/custom-exceptions";
import { ComparisonErrorMessage } from "./comparison.error";
import { CatalogService } from "src/modules/catalog/catalog.service";
import { Database, DRIZZLE } from "src/modules/database/database.module";
import { activityEvents, comparisonItems, products } from "src/modules/database/schema";

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
      .innerJoin(products, eq(comparisonItems.productId, products.productId))
      .where(eq(comparisonItems.userId, userId))
      .orderBy(desc(comparisonItems.createdAt));
    const productList = (
      await Promise.all(rows.map(({ products: product }) => this.catalogService.getProduct(product.productId)))
    ).map((product) => [product.productId, product] as const);
    const productById = new Map(productList);

    return rows.map(({ comparisonItems: item }) => ({
      ...item,
      product: productById.get(item.productId)!,
    }));
  };

  listPriceSummaries = async (userId: string) => {
    const rows = await this.db
      .select()
      .from(comparisonItems)
      .where(eq(comparisonItems.userId, userId))
      .orderBy(desc(comparisonItems.createdAt));

    return Promise.all(rows.map((row) => this.catalogService.getProductPriceSummary(row.productId)));
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
