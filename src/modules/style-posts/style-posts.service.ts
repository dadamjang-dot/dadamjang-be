import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHmac, timingSafeEqual } from "crypto";
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { hasDatabaseErrorCode } from "src/common/errors/database-error";
import { CustomBadRequestException, CustomNotFoundException } from "src/common/errors/custom-exceptions";
import { requireResult } from "src/common/invariants/require-result";
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
import { IMAGE_SUMMARY_WIDTH } from "src/modules/media/media.constant";
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
const MAX_LEGACY_COLLECTION_SIZE = 100;
const STYLE_POST_CATEGORIES = new Set<string>(Object.values(StylePostCategory));
const STYLE_POST_SORTS = new Set<string>(Object.values(StylePostSort));
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STYLE_POST_ID_REFERENCE = sql.raw('"stylePosts"."stylePostId"');
const ANONYMOUS_RANKING_TIMEOUT = "5000ms";

type StylePostCursor = {
  category: StylePostCategory | null;
  sort: StylePostSort;
  sortValue: number;
  createdAt: string;
  snapshotAt: string;
  stylePostId: string;
};

type LikedStylePostCursor = {
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStylePostCursor = (value: unknown): value is StylePostCursor => {
  if (!isRecord(value)) return false;
  return (
    (value.category === null || (typeof value.category === "string" && STYLE_POST_CATEGORIES.has(value.category))) &&
    typeof value.sort === "string" &&
    STYLE_POST_SORTS.has(value.sort) &&
    typeof value.sortValue === "number" &&
    Number.isFinite(value.sortValue) &&
    typeof value.createdAt === "string" &&
    !Number.isNaN(Date.parse(value.createdAt)) &&
    typeof value.snapshotAt === "string" &&
    !Number.isNaN(Date.parse(value.snapshotAt)) &&
    typeof value.stylePostId === "string" &&
    UUID_PATTERN.test(value.stylePostId)
  );
};

const isLikedStylePostCursor = (value: unknown): value is LikedStylePostCursor => {
  if (!isRecord(value)) return false;
  return (
    typeof value.createdAt === "string" &&
    !Number.isNaN(Date.parse(value.createdAt)) &&
    typeof value.stylePostId === "string" &&
    UUID_PATTERN.test(value.stylePostId)
  );
};

const signCursor = (payload: string, secret: string) =>
  createHmac("sha256", secret).update(payload).digest("base64url");

const encodeCursor = (cursor: StylePostCursor, secret: string) => {
  const payload = Buffer.from(JSON.stringify(cursor)).toString("base64url");
  return `${payload}.${signCursor(payload, secret)}`;
};

const decodeCursor = (value: string, secret: string): StylePostCursor => {
  try {
    const [payload, signature, ...rest] = value.split(".");
    if (!payload || !signature || rest.length) throw new Error("invalid");
    const expected = Buffer.from(signCursor(payload, secret), "base64url");
    const received = Buffer.from(signature, "base64url");
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) throw new Error("invalid");
    const cursor: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!isStylePostCursor(cursor)) throw new Error("invalid");
    return cursor;
  } catch {
    throw new CustomBadRequestException(StylePostErrorMessage.InvalidCursor);
  }
};

const encodeLikedStylePostCursor = (cursor: LikedStylePostCursor, secret: string) => {
  const payload = Buffer.from(JSON.stringify(cursor)).toString("base64url");
  return `${payload}.${signCursor(payload, secret)}`;
};

const decodeLikedStylePostCursor = (value: string, secret: string): LikedStylePostCursor => {
  try {
    const [payload, signature, ...rest] = value.split(".");
    if (!payload || !signature || rest.length) throw new Error("invalid");
    const expected = Buffer.from(signCursor(payload, secret), "base64url");
    const received = Buffer.from(signature, "base64url");
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) throw new Error("invalid");
    const cursor: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!isLikedStylePostCursor(cursor)) throw new Error("invalid");
    return cursor;
  } catch {
    throw new CustomBadRequestException(StylePostErrorMessage.InvalidCursor);
  }
};

const unique = (values: string[]) => [...new Set(values)];

@Injectable()
export class StylePostsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly mediaService: MediaService,
    configService: ConfigService,
  ) {
    this.cursorSecret = configService.getOrThrow<string>("JWT_ACCESS_TOKEN_SECRET");
  }

  private readonly cursorSecret: string;

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
    if (!STYLE_POST_CATEGORIES.has(input.category))
      throw new CustomBadRequestException(StylePostErrorMessage.InvalidCategory);

    const productIds = unique(input.productIds);
    if (productIds.length < 1 || productIds.length > 5)
      throw new CustomBadRequestException(StylePostErrorMessage.ProductCount);

    const imageKeys = unique(input.imageKeys);
    if (imageKeys.length < 1 || imageKeys.length > 5)
      throw new CustomBadRequestException(StylePostErrorMessage.ImageCount);
    if (imageKeys.some((key) => !this.mediaService.isStylePostImageKeyForUser(key, authorId)))
      throw new CustomBadRequestException(StylePostErrorMessage.InvalidImageKey);

    const hashtags = unique((input.hashtags ?? []).map((tag) => tag.trim().replace(/^#/, "")));
    if (hashtags.length > 10) throw new CustomBadRequestException(StylePostErrorMessage.HashtagCount);
    if (hashtags.some((tag) => !/^[가-힣A-Za-z0-9_]{1,20}$/.test(tag)))
      throw new CustomBadRequestException(StylePostErrorMessage.InvalidHashtag);

    const purchasedProducts = await this.getPurchasedProductRows(authorId, productIds);
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

    const attachedImageKeys = await this.mediaService.validateStylePostImageObjects(imageKeys, authorId);
    const imageUrls = attachedImageKeys.map((key) => this.mediaService.getStylePostImageUrl(key));
    try {
      const post = await this.db.transaction(async (tx) => {
        const created = requireResult(
          (
            await tx
              .insert(stylePosts)
              .values({
                authorId,
                title: content.slice(0, 200),
                content,
                imageUrls,
                category: input.category,
                hashtags,
                brandTagIds,
                imageKeys: attachedImageKeys,
                idempotencyKey,
                isPartner,
              })
              .returning()
          )[0],
        );
        await tx
          .insert(stylePostProducts)
          .values(productIds.map((productId) => ({ stylePostId: created.stylePostId, productId })));
        await this.mediaService.replaceImageReferences(tx, "STYLE_POST", created.stylePostId, attachedImageKeys);
        return created;
      });
      return this.get(post.stylePostId, authorId);
    } catch (error) {
      if (!hasDatabaseErrorCode(error, "23505")) throw error;
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
    if (!UUID_PATTERN.test(stylePostId)) throw new CustomBadRequestException(StylePostErrorMessage.InvalidStylePostId);
    const [post] = await this.db.select().from(stylePosts).where(eq(stylePosts.stylePostId, stylePostId)).limit(1);
    if (!post) throw new CustomNotFoundException(StylePostErrorMessage.NotFound);
    return requireResult((await this.hydrate([post], viewerId))[0]);
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
    const cursor = after ? decodeCursor(after, this.cursorSecret) : undefined;
    if (cursor && (cursor.category !== category || cursor.sort !== sort))
      throw new CustomBadRequestException(StylePostErrorMessage.InvalidCursor);
    const snapshotAt = cursor ? new Date(cursor.snapshotAt) : new Date();
    const stylePostSnapshotAt = sql.param(snapshotAt, stylePosts.createdAt);
    const likeSnapshotAt = sql.param(snapshotAt, stylePostLikes.createdAt);
    const likeCount = sql<number>`(
      select count(*)::int
      from ${stylePostLikes}
      where ${stylePostLikes.stylePostId} = ${STYLE_POST_ID_REFERENCE}
        and ${stylePostLikes.createdAt} <= ${likeSnapshotAt}
        and (${stylePostLikes.deletedAt} is null or ${stylePostLikes.deletedAt} > ${likeSnapshotAt})
    )`;
    const createdAtEpoch = sql<number>`extract(epoch from ${stylePosts.createdAt})::double precision`;
    const sortValue =
      sort === StylePostSort.POPULAR
        ? likeCount
        : sort === StylePostSort.LATEST
          ? sql<number>`${createdAtEpoch} * 1000`
          : sql<number>`round((ln(${likeCount} + 1) + ${createdAtEpoch} / 259200) * 1000000000)::bigint`;
    const categoryCondition = category ? eq(stylePosts.category, category) : undefined;
    const snapshotCondition = sql`${stylePosts.createdAt} <= ${stylePostSnapshotAt}`;
    let cursorRow: { stylePostId: string; createdAt: Date } | undefined;
    if (cursor) {
      [cursorRow] = await this.db
        .select({ stylePostId: stylePosts.stylePostId, createdAt: stylePosts.createdAt })
        .from(stylePosts)
        .where(and(eq(stylePosts.stylePostId, cursor.stylePostId), categoryCondition, snapshotCondition))
        .limit(1);
      if (!cursorRow || cursorRow.createdAt.toISOString() !== cursor.createdAt)
        throw new CustomBadRequestException(StylePostErrorMessage.InvalidCursor);
    }
    const cursorCreatedAt = cursorRow?.createdAt;
    const sameCreatedAt = cursorCreatedAt
      ? sql`${stylePosts.createdAt} = ${sql.param(cursorCreatedAt, stylePosts.createdAt)}`
      : undefined;
    const cursorCondition =
      cursor && cursorCreatedAt
        ? sort === StylePostSort.LATEST
          ? or(
              sql`${stylePosts.createdAt} < ${sql.param(cursorCreatedAt, stylePosts.createdAt)}`,
              and(sameCreatedAt, sql`${stylePosts.stylePostId} < ${cursor.stylePostId}`),
            )
          : or(
              sql`${sortValue} < ${cursor.sortValue}`,
              and(
                sql`${sortValue} = ${cursor.sortValue}`,
                sql`${stylePosts.createdAt} < ${sql.param(cursorCreatedAt, stylePosts.createdAt)}`,
              ),
              and(
                sql`${sortValue} = ${cursor.sortValue}`,
                sameCreatedAt,
                sql`${stylePosts.stylePostId} < ${cursor.stylePostId}`,
              ),
            )
        : undefined;
    const pageKeys = await this.db.transaction(
      async (tx) => {
        await tx.execute(sql`select set_config('statement_timeout', ${ANONYMOUS_RANKING_TIMEOUT}, true)`);
        return tx
          .select({ stylePostId: stylePosts.stylePostId, createdAt: stylePosts.createdAt, sortValue })
          .from(stylePosts)
          .where(and(categoryCondition, snapshotCondition, cursorCondition))
          .orderBy(desc(sortValue), desc(stylePosts.createdAt), desc(stylePosts.stylePostId))
          .limit(pageSize + 1);
      },
      { accessMode: "read only" },
    );
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
    const posts = await this.hydrate(pageRows, viewerId, IMAGE_SUMMARY_WIDTH);
    const hasNextPage = visibleKeys.length > pageSize;
    const tail = pageKeysForPage[pageKeysForPage.length - 1];
    return {
      nodes: posts,
      hasNextPage,
      nextCursor:
        hasNextPage && tail
          ? encodeCursor(
              {
                category,
                sort,
                sortValue: Number(tail.sortValue),
                createdAt: tail.createdAt.toISOString(),
                snapshotAt: snapshotAt.toISOString(),
                stylePostId: tail.stylePostId,
              },
              this.cursorSecret,
            )
          : null,
    };
  };

  listLiked = async (userId: string, after?: string, first?: number): Promise<StylePostConnectionType> => {
    const pageSize = Math.min(Math.max(first ?? 20, 1), MAX_PAGE_SIZE);
    const cursor = after ? decodeLikedStylePostCursor(after, this.cursorSecret) : undefined;
    let cursorRow: { stylePostId: string; createdAt: Date } | undefined;
    if (cursor) {
      [cursorRow] = await this.db
        .select({ stylePostId: stylePostLikes.stylePostId, createdAt: stylePostLikes.createdAt })
        .from(stylePostLikes)
        .where(
          and(
            eq(stylePostLikes.userId, userId),
            eq(stylePostLikes.stylePostId, cursor.stylePostId),
            eq(stylePostLikes.createdAt, new Date(cursor.createdAt)),
            isNull(stylePostLikes.deletedAt),
          ),
        )
        .limit(1);
      if (!cursorRow) throw new CustomBadRequestException(StylePostErrorMessage.InvalidCursor);
    }
    const cursorCreatedAt = cursorRow?.createdAt;
    const cursorCondition =
      cursor && cursorCreatedAt
        ? or(
            sql`${stylePostLikes.createdAt} < ${sql.param(cursorCreatedAt, stylePostLikes.createdAt)}`,
            and(
              eq(stylePostLikes.createdAt, cursorCreatedAt),
              sql`${stylePostLikes.stylePostId} < ${cursor.stylePostId}`,
            ),
          )
        : undefined;
    const pageKeys = await this.db
      .select({ stylePostId: stylePostLikes.stylePostId, createdAt: stylePostLikes.createdAt })
      .from(stylePostLikes)
      .where(and(eq(stylePostLikes.userId, userId), isNull(stylePostLikes.deletedAt), cursorCondition))
      .orderBy(desc(stylePostLikes.createdAt), desc(stylePostLikes.stylePostId))
      .limit(pageSize + 1);
    const visibleKeys = pageKeys.slice(0, pageSize);
    const rows = visibleKeys.length
      ? await this.db
          .select()
          .from(stylePosts)
          .where(
            inArray(
              stylePosts.stylePostId,
              visibleKeys.map((row) => row.stylePostId),
            ),
          )
      : [];
    const rowsById = new Map(rows.map((row) => [row.stylePostId, row]));
    const pageRows = visibleKeys.flatMap((key) => {
      const row = rowsById.get(key.stylePostId);
      return row ? [row] : [];
    });
    const tail = visibleKeys[visibleKeys.length - 1];
    const hasNextPage = pageKeys.length > pageSize;
    return {
      nodes: await this.hydrate(pageRows, userId, IMAGE_SUMMARY_WIDTH),
      hasNextPage,
      nextCursor:
        hasNextPage && tail
          ? encodeLikedStylePostCursor(
              { createdAt: tail.createdAt.toISOString(), stylePostId: tail.stylePostId },
              this.cursorSecret,
            )
          : null,
    };
  };

  purchasedStyleProducts = async (userId: string): Promise<PurchasedStyleProductType[]> => {
    const rows = await this.getPurchasedProductRows(userId);
    return rows.map((row) => ({ ...row }));
  };

  like = async (stylePostId: string, userId: string) => {
    await this.setLikeState(stylePostId, userId, true);
    return this.get(stylePostId, userId);
  };

  unlike = async (stylePostId: string, userId: string) => {
    await this.setLikeState(stylePostId, userId, false);
    return this.get(stylePostId, userId);
  };

  private setLikeState = async (stylePostId: string, userId: string, liked: boolean) => {
    if (!UUID_PATTERN.test(stylePostId)) throw new CustomBadRequestException(StylePostErrorMessage.InvalidStylePostId);
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${stylePostId}:${userId}`}, 5))`);
      const [post] = await tx
        .select({ stylePostId: stylePosts.stylePostId })
        .from(stylePosts)
        .where(eq(stylePosts.stylePostId, stylePostId))
        .limit(1);
      if (!post) throw new CustomNotFoundException(StylePostErrorMessage.NotFound);
      if (liked) {
        await tx.insert(stylePostLikes).values({ stylePostId, userId }).onConflictDoNothing();
        return;
      }
      await tx
        .update(stylePostLikes)
        .set({ deletedAt: new Date() })
        .where(
          and(
            eq(stylePostLikes.stylePostId, stylePostId),
            eq(stylePostLikes.userId, userId),
            isNull(stylePostLikes.deletedAt),
          ),
        );
    });
  };

  private getPurchasedProductRows = async (
    userId: string,
    productIds?: string[],
  ): Promise<PurchasedStyleProductRow[]> => {
    const lastPurchasedAt = sql<Date>`max(${orders.createdAt})`.mapWith(orders.createdAt);
    const rows = await this.db
      .select({
        productId: products.productId,
        title: products.title,
        imageUrls: products.imageUrls,
        brandId: brands.brandId,
        brandName: brands.name,
        categoryId: products.categoryId,
        lastPurchasedAt,
      })
      .from(orderItems)
      .innerJoin(orders, eq(orderItems.orderId, orders.orderId))
      .innerJoin(products, eq(orderItems.productId, products.productId))
      .leftJoin(brands, eq(products.brandId, brands.brandId))
      .where(
        and(
          eq(orders.userId, userId),
          inArray(orders.status, [...PURCHASED_ORDER_STATUSES]),
          productIds ? inArray(orderItems.productId, productIds) : undefined,
        ),
      )
      .groupBy(products.productId, products.title, products.imageUrls, brands.brandId, brands.name, products.categoryId)
      .orderBy(desc(lastPurchasedAt))
      .limit(MAX_LEGACY_COLLECTION_SIZE);
    return rows.slice(0, MAX_LEGACY_COLLECTION_SIZE);
  };

  private hydrate = async (
    rows: (typeof stylePosts.$inferSelect)[],
    viewerId?: string,
    thumbnailWidth?: number,
  ): Promise<StylePostType[]> => {
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
        .where(and(inArray(stylePostLikes.stylePostId, postIds), isNull(stylePostLikes.deletedAt)))
        .groupBy(stylePostLikes.stylePostId),
      viewerId
        ? this.db
            .select({ stylePostId: stylePostLikes.stylePostId })
            .from(stylePostLikes)
            .where(
              and(
                inArray(stylePostLikes.stylePostId, postIds),
                eq(stylePostLikes.userId, viewerId),
                isNull(stylePostLikes.deletedAt),
              ),
            )
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
        thumbnailUrl:
          thumbnailWidth && row.imageKeys[0]
            ? this.mediaService.getStylePostImageUrl(row.imageKeys[0], thumbnailWidth)
            : (imageUrls[0] ?? null),
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
