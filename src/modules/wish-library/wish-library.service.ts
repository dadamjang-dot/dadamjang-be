import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gte, inArray, lte } from "drizzle-orm";

import { CustomNotFoundException } from "src/common/errors/custom-exceptions";
import { CatalogErrorMessage } from "src/modules/catalog/catalog.error";
import { CatalogService } from "src/modules/catalog/catalog.service";
import { Database, DRIZZLE } from "src/modules/database/database.module";
import { brandFollows, brands, recentProductViews } from "src/modules/database/schema";
import { WishLibraryErrorMessage } from "./wish-library.error";
import type { RecentlyViewedProductType } from "./wish-library.types";

const RECENT_PRODUCT_VIEW_LIMIT = 50;
const RECENT_PRODUCT_VIEW_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const recentProductViewCutoff = () => new Date(Date.now() - RECENT_PRODUCT_VIEW_RETENTION_MS);

@Injectable()
export class WishLibraryService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly catalogService: CatalogService,
  ) {}

  listFollowedBrands = async (userId: string) => {
    const rows = await this.db
      .select({ brandId: brands.brandId, name: brands.name, slug: brands.slug })
      .from(brandFollows)
      .innerJoin(brands, eq(brandFollows.brandId, brands.brandId))
      .where(and(eq(brandFollows.userId, userId), eq(brands.isActive, true)))
      .orderBy(desc(brandFollows.createdAt));
    return rows;
  };

  followBrand = async (userId: string, brandId: string) => {
    const [brand] = await this.db
      .select({ brandId: brands.brandId, name: brands.name, slug: brands.slug })
      .from(brands)
      .where(and(eq(brands.brandId, brandId), eq(brands.isActive, true)))
      .limit(1);
    if (!brand) throw new CustomNotFoundException(WishLibraryErrorMessage.BrandNotFound);
    await this.db.insert(brandFollows).values({ userId, brandId }).onConflictDoNothing();
    return brand;
  };

  unfollowBrand = async (userId: string, brandId: string) => {
    await this.db.delete(brandFollows).where(and(eq(brandFollows.userId, userId), eq(brandFollows.brandId, brandId)));
    return true;
  };

  listRecentlyViewedProducts = async (userId: string): Promise<RecentlyViewedProductType[]> => {
    const views = await this.db
      .select({ productId: recentProductViews.productId, viewedAt: recentProductViews.viewedAt })
      .from(recentProductViews)
      .where(and(eq(recentProductViews.userId, userId), gte(recentProductViews.viewedAt, recentProductViewCutoff())))
      .orderBy(desc(recentProductViews.viewedAt));
    const products = await this.catalogService.getProductsByIds(views.map((view) => view.productId));
    const productById = new Map(products.map((product) => [product.productId, product]));
    return views.flatMap((view) => {
      const product = productById.get(view.productId);
      return product ? [{ ...view, product }] : [];
    });
  };

  recordRecentProductView = async (userId: string, productId: string) => {
    const [product] = await this.catalogService.getProductsByIds([productId]);
    if (!product) throw new CustomNotFoundException(CatalogErrorMessage.ProductNotFound);
    const viewedAt = new Date();
    const cutoff = recentProductViewCutoff();
    await this.db.transaction(async (tx) => {
      await tx
        .insert(recentProductViews)
        .values({ userId, productId, viewedAt })
        .onConflictDoUpdate({
          target: [recentProductViews.userId, recentProductViews.productId],
          set: { viewedAt },
        });
      await tx
        .delete(recentProductViews)
        .where(and(eq(recentProductViews.userId, userId), lte(recentProductViews.viewedAt, cutoff)));
      const overflow = await tx
        .select({ recentProductViewId: recentProductViews.recentProductViewId })
        .from(recentProductViews)
        .where(eq(recentProductViews.userId, userId))
        .orderBy(desc(recentProductViews.viewedAt), desc(recentProductViews.recentProductViewId))
        .offset(RECENT_PRODUCT_VIEW_LIMIT);
      if (overflow.length) {
        await tx.delete(recentProductViews).where(
          inArray(
            recentProductViews.recentProductViewId,
            overflow.map((view) => view.recentProductViewId),
          ),
        );
      }
    });
    return true;
  };
}
