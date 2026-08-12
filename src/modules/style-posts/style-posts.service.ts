import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import { CustomBadRequestException, CustomNotFoundException } from "src/common/errors/custom-exceptions";
import { Database, DRIZZLE } from "src/modules/database/database.module";
import {
  brands,
  orders,
  orderItems,
  products,
  stylePostLikes,
  stylePostProducts,
  stylePosts,
  users,
} from "src/modules/database/schema";
import { MediaService } from "src/modules/media/media.service";
import { MAX_PAGE_SIZE } from "./style-posts.constant";
import { StylePostErrorMessage } from "./style-posts.error";
import {
  CreateStylePostInput,
  PurchasedStyleProductType,
  StylePostAuthorType,
  StylePostBrandTagType,
  StylePostCategory,
  StylePostConnectionType,
  StylePostFilterInput,
  StylePostProductType,
  StylePostSort,
  StylePostType,
} from "./style-posts.types";

const PURCHASED_ORDER_STATUSES = ["PAID", "FULFILLING", "COMPLETED"] as const;
const STYLE_POST_CATEGORIES = Object.values(StylePostCategory);
const STYLE_POST_SORTS = Object.values(StylePostSort);

type StylePostCursor = {
  category: StylePostCategory | null;
  sort: StylePostSort;
  sortValue: number;
  createdAt: string;
  stylePostId: string;
};

type PurchasedStyleProductRow = {
  productId: string;
  title: string;
  imageUrls: string[];
  brandId: string | null;
  brandName: string | null;
  categoryId: string;
  lastPurchasedAt: Date;
};

const encodeCursor = (cursor: StylePostCursor) => Buffer.from(JSON.stringify(cursor)).toString("base64url");

const decodeCursor = (value: string): StylePostCursor => {
  try {
    const cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as StylePostCursor;
    if (
      !cursor.stylePostId ||
      !cursor.createdAt ||
      Number.isNaN(Date.parse(cursor.createdAt)) ||
      !STYLE_POST_SORTS.includes(cursor.sort) ||
      (cursor.category !== null && !STYLE_POST_CATEGORIES.includes(cursor.category)) ||
      !Number.isFinite(cursor.sortValue)
    ) {
      throw new Error("invalid");
    }
    return cursor;
  } catch {
    throw new CustomBadRequestException(StylePostErrorMessage.InvalidCursor);
  }
};

const unique = (values: string[]) => [...new Set(values)];

const isDuplicateError = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error && error.code === "23505";

@Injectable()
export class StylePostsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly mediaService: MediaService,
  ) {}

  create = async (authorId: string, isPartner: boolean, input: CreateStylePostInput): Promise<StylePostType> => {
    const idempotencyKey = input.idempotencyKey.trim();
    if (!idempotencyKey || idempotencyKey.length > 120)
      throw new CustomBadRequestException(StylePostErrorMessage.IdempotencyKeyRequired);

    const [existing] = await this.db
      .select()
      .from(stylePosts)
      .where(and(eq(stylePosts.authorId, authorId), eq(stylePosts.idempotencyKey, idempotencyKey)))
      .limit(1);
    if (existing) return this.get(existing.stylePostId, authorId);

    const content = input.content.trim();
    if (!content) throw new CustomBadRequestException(StylePostErrorMessage.ContentRequired);
    if (content.length > 1000) throw new CustomBadRequestException(StylePostErrorMessage.ContentTooLong);
    if (!STYLE_POST_CATEGORIES.includes(input.category))
      throw new CustomBadRequestException(StylePostErrorMessage.InvalidCategory);

    const productIds = unique(input.productIds);
    if (productIds.length < 1 || productIds.length > 5)
      throw new CustomBadRequestException(StylePostErrorMessage.ProductCount);

    const imageKeys = unique(input.imageKeys);
    if (imageKeys.length < 1 || imageKeys.length > 5)
      throw new CustomBadRequestException(StylePostErrorMessage.ImageCount);
    if (imageKeys.some((key) => !key.startsWith(`style-posts/${authorId}/`)))
      throw new CustomBadRequestException(StylePostErrorMessage.InvalidImageKey);

    const hashtags = unique((input.hashtags ?? []).map((tag) => tag.trim().replace(/^#/, "")));
    if (hashtags.length > 10) throw new CustomBadRequestException(StylePostErrorMessage.HashtagCount);
    if (hashtags.some((tag) => !/^[가-힣A-Za-z0-9_]{1,20}$/.test(tag)))
      throw new CustomBadRequestException(StylePostErrorMessage.InvalidHashtag);

    const purchasedProducts = await this.getPurchasedProductRows(authorId);
    const purchasedById = new Map(purchasedProducts.map((product) => [product.productId, product]));
    if (productIds.some((productId) => !purchasedById.has(productId)))
      throw new CustomBadRequestException(StylePostErrorMessage.ProductNotPurchased);

    const brandTagIds = unique(input.brandTagIds ?? []);
    const purchasedBrandIds = new Set(
      productIds
        .map((productId) => purchasedById.get(productId)?.brandId)
        .filter((brandId): brandId is string => !!brandId),
    );
    if (brandTagIds.some((brandId) => !purchasedBrandIds.has(brandId)))
      throw new CustomBadRequestException(StylePostErrorMessage.BrandTagNotPurchased);

    const imageUrls = imageKeys.map((key) => this.mediaService.getStylePostImageUrl(key));
    try {
      const post = await this.db.transaction(async (tx) => {
        const [created] = await tx
          .insert(stylePosts)
          .values({
            authorId,
            title: content.slice(0, 200),
            content,
            imageUrls,
            category: input.category,
            hashtags,
            brandTagIds,
            imageKeys,
            idempotencyKey,
            isPartner,
          })
          .returning();
        await tx
          .insert(stylePostProducts)
          .values(productIds.map((productId) => ({ stylePostId: created.stylePostId, productId })));
        return created;
      });
      return this.get(post.stylePostId, authorId);
    } catch (error) {
      if (!isDuplicateError(error)) throw error;
      const [duplicate] = await this.db
        .select()
        .from(stylePosts)
        .where(and(eq(stylePosts.authorId, authorId), eq(stylePosts.idempotencyKey, idempotencyKey)))
        .limit(1);
      if (!duplicate) throw error;
      return this.get(duplicate.stylePostId, authorId);
    }
  };

  get = async (stylePostId: string, viewerId?: string): Promise<StylePostType> => {
    const [post] = await this.db.select().from(stylePosts).where(eq(stylePosts.stylePostId, stylePostId)).limit(1);
    if (!post) throw new CustomNotFoundException(StylePostErrorMessage.NotFound);
    const [result] = await this.hydrate([post], viewerId);
    return result;
  };

  list = async (
    filter?: StylePostFilterInput,
    after?: string,
    first?: number,
    viewerId?: string,
  ): Promise<StylePostConnectionType> => {
    const category = filter?.category ?? null;
    const sort = filter?.sort ?? StylePostSort.RECOMMENDED;
    const pageSize = Math.min(Math.max(first ?? 20, 1), MAX_PAGE_SIZE);
    const cursor = after ? decodeCursor(after) : undefined;
    if (cursor && (cursor.category !== category || cursor.sort !== sort))
      throw new CustomBadRequestException(StylePostErrorMessage.InvalidCursor);
    const likeCount = sql<number>`(
      select count(*)::int
      from ${stylePostLikes}
      where ${stylePostLikes.stylePostId} = ${stylePosts.stylePostId}
    )`;
    const createdAtEpoch = sql<number>`extract(epoch from ${stylePosts.createdAt})::double precision`;
    const sortValue =
      sort === StylePostSort.POPULAR
        ? likeCount
        : sort === StylePostSort.LATEST
          ? sql<number>`${createdAtEpoch} * 1000`
          : sql<number>`ln(${likeCount} + 1) + ${createdAtEpoch} / 259200`;
    const categoryCondition = category ? eq(stylePosts.category, category) : undefined;
    if (cursor) {
      const [cursorRow] = await this.db
        .select({ stylePostId: stylePosts.stylePostId, createdAt: stylePosts.createdAt, sortValue })
        .from(stylePosts)
        .where(and(eq(stylePosts.stylePostId, cursor.stylePostId), categoryCondition))
        .limit(1);
      if (
        !cursorRow ||
        Number(cursorRow.sortValue) !== cursor.sortValue ||
        cursorRow.createdAt.toISOString() !== cursor.createdAt
      )
        throw new CustomBadRequestException(StylePostErrorMessage.InvalidCursor);
    }
    let cursorCondition;
    if (cursor) {
      const cursorLikeCount = sql<number>`(
        select count(*)::int
        from ${stylePostLikes}
        where ${stylePostLikes.stylePostId} = ${cursor.stylePostId}
      )`;
      const cursorCreatedAt = sql`(
        select ${stylePosts.createdAt}
        from ${stylePosts}
        where ${stylePosts.stylePostId} = ${cursor.stylePostId}
      )`;
      const cursorSortValue =
        sort === StylePostSort.POPULAR
          ? cursorLikeCount
          : sort === StylePostSort.LATEST
            ? sql<number>`extract(epoch from ${cursorCreatedAt})::double precision * 1000`
            : sql<number>`ln(${cursorLikeCount} + 1) + extract(epoch from ${cursorCreatedAt})::double precision / 259200`;
      const sameSortValue = sql`${sortValue} = ${cursorSortValue}`;
      const sameCreatedAt = sql`${stylePosts.createdAt} = ${cursorCreatedAt}`;
      cursorCondition = or(
        sql`${sortValue} < ${cursorSortValue}`,
        and(sameSortValue, sql`${stylePosts.createdAt} < ${cursorCreatedAt}`),
        and(sameSortValue, sameCreatedAt, sql`${stylePosts.stylePostId} < ${cursor.stylePostId}`),
      );
    }
    const pageKeys = await this.db
      .select({ stylePostId: stylePosts.stylePostId, createdAt: stylePosts.createdAt, sortValue })
      .from(stylePosts)
      .where(and(categoryCondition, cursorCondition))
      .orderBy(desc(sortValue), desc(stylePosts.createdAt), desc(stylePosts.stylePostId))
      .limit(pageSize + 1);
    const rowIds = pageKeys.map(({ stylePostId }) => stylePostId);
    const rows = rowIds.length
      ? await this.db.select().from(stylePosts).where(inArray(stylePosts.stylePostId, rowIds))
      : [];
    const rowsById = new Map(rows.map((row) => [row.stylePostId, row]));
    const visibleKeys = pageKeys.filter(({ stylePostId }) => rowsById.has(stylePostId));
    const pageKeysForPage = visibleKeys.slice(0, pageSize);
    const pageRows = pageKeysForPage
      .map(({ stylePostId }) => rowsById.get(stylePostId))
      .filter((row): row is typeof stylePosts.$inferSelect => Boolean(row));
    const posts = await this.hydrate(pageRows, viewerId);
    const hasNextPage = visibleKeys.length > pageSize;
    const tail = pageKeysForPage[pageKeysForPage.length - 1];
    return {
      nodes: posts,
      hasNextPage,
      nextCursor:
        hasNextPage && tail
          ? encodeCursor({
              category,
              sort,
              sortValue: Number(tail.sortValue),
              createdAt: tail.createdAt.toISOString(),
              stylePostId: tail.stylePostId,
            })
          : null,
    };
  };

  purchasedStyleProducts = async (userId: string): Promise<PurchasedStyleProductType[]> => {
    const rows = await this.getPurchasedProductRows(userId);
    return rows.map((row) => ({ ...row }));
  };

  like = async (stylePostId: string, userId: string) => {
    await this.get(stylePostId);
    await this.db.insert(stylePostLikes).values({ stylePostId, userId }).onConflictDoNothing();
    return this.get(stylePostId, userId);
  };

  unlike = async (stylePostId: string, userId: string) => {
    await this.get(stylePostId);
    await this.db
      .delete(stylePostLikes)
      .where(and(eq(stylePostLikes.stylePostId, stylePostId), eq(stylePostLikes.userId, userId)));
    return this.get(stylePostId, userId);
  };

  private getPurchasedProductRows = async (userId: string): Promise<PurchasedStyleProductRow[]> => {
    const rows = await this.db
      .select({
        productId: products.productId,
        title: products.title,
        imageUrls: products.imageUrls,
        brandId: brands.brandId,
        brandName: brands.name,
        categoryId: products.categoryId,
        lastPurchasedAt: orders.createdAt,
      })
      .from(orderItems)
      .innerJoin(orders, eq(orderItems.orderId, orders.orderId))
      .innerJoin(products, eq(orderItems.productId, products.productId))
      .leftJoin(brands, eq(products.brandId, brands.brandId))
      .where(and(eq(orders.userId, userId), inArray(orders.status, [...PURCHASED_ORDER_STATUSES])))
      .orderBy(desc(orders.createdAt));
    const latest = new Map<string, PurchasedStyleProductRow>();
    for (const row of rows) {
      if (!latest.has(row.productId)) latest.set(row.productId, row);
    }
    return [...latest.values()];
  };

  private hydrate = async (rows: (typeof stylePosts.$inferSelect)[], viewerId?: string): Promise<StylePostType[]> => {
    if (rows.length === 0) return [];
    const postIds = rows.map((row) => row.stylePostId);
    const authorIds = unique(rows.map((row) => row.authorId));
    const brandIds = unique(rows.flatMap((row) => row.brandTagIds ?? []));
    const [authors, productLinks, likeCounts, likedRows, brandRows] = await Promise.all([
      this.db
        .select({ userId: users.userId, userid: users.userid })
        .from(users)
        .where(inArray(users.userId, authorIds)),
      this.db
        .select({
          stylePostId: stylePostProducts.stylePostId,
          productId: products.productId,
          title: products.title,
          imageUrls: products.imageUrls,
          brandId: brands.brandId,
          brandName: brands.name,
          categoryId: products.categoryId,
        })
        .from(stylePostProducts)
        .innerJoin(products, eq(stylePostProducts.productId, products.productId))
        .leftJoin(brands, eq(products.brandId, brands.brandId))
        .where(inArray(stylePostProducts.stylePostId, postIds))
        .orderBy(asc(stylePostProducts.createdAt)),
      this.db
        .select({ stylePostId: stylePostLikes.stylePostId, likeCount: sql<number>`count(*)` })
        .from(stylePostLikes)
        .where(inArray(stylePostLikes.stylePostId, postIds))
        .groupBy(stylePostLikes.stylePostId),
      viewerId
        ? this.db
            .select({ stylePostId: stylePostLikes.stylePostId })
            .from(stylePostLikes)
            .where(and(inArray(stylePostLikes.stylePostId, postIds), eq(stylePostLikes.userId, viewerId)))
        : Promise.resolve([]),
      brandIds.length
        ? this.db
            .select({ brandId: brands.brandId, name: brands.name })
            .from(brands)
            .where(inArray(brands.brandId, brandIds))
        : Promise.resolve([] as { brandId: string; name: string }[]),
    ]);
    const authorById = new Map(authors.map((author) => [author.userId, author]));
    const productsByPost = new Map<string, StylePostProductType[]>();
    for (const product of productLinks) {
      const list = productsByPost.get(product.stylePostId) ?? [];
      list.push({ ...product });
      productsByPost.set(product.stylePostId, list);
    }
    const likeCountByPost = new Map(likeCounts.map((row) => [row.stylePostId, Number(row.likeCount)]));
    const likedPostIds = new Set(likedRows.map((row) => row.stylePostId));
    const brandById = new Map(brandRows.map((brand) => [brand.brandId, brand]));

    return rows.map((row) => {
      const imageUrls = row.imageUrls.length
        ? row.imageUrls
        : (row.imageKeys ?? []).map((key) => this.mediaService.getStylePostImageUrl(key));
      const author = authorById.get(row.authorId) as StylePostAuthorType;
      const brandTags = (row.brandTagIds ?? [])
        .map((brandId) => brandById.get(brandId))
        .filter((brand): brand is { brandId: string; name: string } => !!brand)
        .map((brand) => ({ ...brand }) as StylePostBrandTagType);
      return {
        stylePostId: row.stylePostId,
        authorId: row.authorId,
        author,
        title: row.title,
        content: row.content,
        category: row.category as StylePostCategory,
        imageUrls,
        thumbnailUrl: imageUrls[0] ?? null,
        hashtags: row.hashtags ?? [],
        brandTags,
        products: productsByPost.get(row.stylePostId) ?? [],
        isPartner: row.isPartner,
        likeCount: likeCountByPost.get(row.stylePostId) ?? 0,
        isLiked: likedPostIds.has(row.stylePostId),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
    });
  };
}
