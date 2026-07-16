import { Inject, Injectable } from "@nestjs/common";
import { desc, eq, inArray } from "drizzle-orm";
import { FeedErrorMessage } from "./feed.error";
import { CatalogService } from "src/modules/catalog/catalog.service";
import { CustomBadRequestException } from "src/common/errors/custom-exceptions";
import { Database, DRIZZLE } from "src/modules/database/database.module";
import { activityEvents, products, wishlists } from "src/modules/database/schema";

type FeedCursor = { offset: number };
const MAX_PAGE_SIZE = 50;
const stableHash = (value: string) =>
  [...value].reduce((hash, character) => ((hash << 5) - hash + character.charCodeAt(0)) | 0, 0) >>> 0;
const encodeCursor = (cursor: FeedCursor) => Buffer.from(JSON.stringify(cursor)).toString("base64url");
const decodeCursor = (cursor: string): FeedCursor => {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as FeedCursor;
    if (!Number.isInteger(parsed.offset) || parsed.offset < 0) throw new Error("invalid");
    return parsed;
  } catch {
    throw new CustomBadRequestException(FeedErrorMessage.InvalidCursor);
  }
};

@Injectable()
export class FeedService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly catalogService: CatalogService,
  ) {}

  personalizedFeed = async (userId: string, first = 20, after?: string) => {
    const pageSize = Math.min(Math.max(first, 1), MAX_PAGE_SIZE);
    const offset = after ? decodeCursor(after).offset : 0;
    const likedProducts = await this.db
      .select({ productId: wishlists.productId })
      .from(wishlists)
      .where(eq(wishlists.userId, userId));
    const viewed = await this.db
      .select({ subjectId: activityEvents.subjectId })
      .from(activityEvents)
      .where(eq(activityEvents.actorUserId, userId))
      .orderBy(desc(activityEvents.createdAt))
      .limit(100);
    const preferenceProductIds = [
      ...new Set([
        ...likedProducts.map((row) => row.productId),
        ...viewed.filter((row) => row.subjectId.length === 36).map((row) => row.subjectId),
      ]),
    ];
    const preferenceRows = preferenceProductIds.length
      ? await this.db
          .select({ categoryId: products.categoryId })
          .from(products)
          .where(inArray(products.productId, preferenceProductIds))
      : [];
    const categoryIds = new Set(preferenceRows.map((row) => row.categoryId));
    const candidates = await this.db
      .select()
      .from(products)
      .where(eq(products.status, "PUBLISHED"))
      .orderBy(desc(products.createdAt))
      .limit(200);
    const ranked = candidates
      .map((product) => ({
        product,
        score: (categoryIds.has(product.categoryId) ? 1_000_000 : 0) + stableHash(`${userId}:${product.productId}`),
      }))
      .sort((left, right) => right.score - left.score || left.product.productId.localeCompare(right.product.productId));
    const slice = ranked.slice(offset, offset + pageSize);
    const nodes = await Promise.all(slice.map(({ product }) => this.catalogService.getProduct(product.productId)));
    const nextOffset = offset + nodes.length;
    return {
      nodes,
      hasNextPage: nextOffset < ranked.length,
      nextCursor: nextOffset < ranked.length ? encodeCursor({ offset: nextOffset }) : null,
      personalizedCategoryCount: categoryIds.size,
    };
  };
}
