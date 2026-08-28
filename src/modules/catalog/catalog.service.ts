import { Inject, Injectable } from "@nestjs/common";
import { SQL, and, asc, desc, eq, getTableColumns, gte, ilike, inArray, lte, or, sql } from "drizzle-orm";
import { CustomBadRequestException, CustomNotFoundException } from "src/common/errors/custom-exceptions";
import { requireResult } from "src/common/invariants/require-result";
import { Database, DRIZZLE } from "src/modules/database/database.module";
import { brands, categories, colors, productSkus, products, sizes } from "src/modules/database/schema";
import { CatalogErrorMessage } from "./catalog.error";
import { MAX_PAGE_SIZE } from "./catalog.constant";
import {
  CatalogFilterOptionsType,
  CreateCategoryInput,
  CreateProductDraftInput,
  ProductFilterInput,
  ProductPriceEvidenceType,
  ProductPriceSummaryType,
  ProductSort,
  ProductType,
} from "./catalog.types";

type DateProductCursor = {
  v: 1;
  sort: ProductSort.RECOMMENDED | ProductSort.LATEST;
  createdAt: string;
  productId: string;
};

type MetricProductCursor = {
  v: 1;
  sort: ProductSort.LOW_PRICE | ProductSort.HIGH_PRICE | ProductSort.POPULAR;
  sortValue: number;
  createdAt: string;
  productId: string;
};

type ProductCursor = DateProductCursor | MetricProductCursor;
type CatalogDatabase = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

const DATE_PRODUCT_SORTS = new Set<ProductSort>([ProductSort.RECOMMENDED, ProductSort.LATEST]);
const METRIC_PRODUCT_SORTS = new Set<ProductSort>([ProductSort.LOW_PRICE, ProductSort.HIGH_PRICE, ProductSort.POPULAR]);
const PRODUCT_SORTS = new Set<string>(Object.values(ProductSort));
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CURSOR_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.(\d{6})Z$/;
const DATE_CURSOR_KEYS = ["v", "sort", "createdAt", "productId"];
const METRIC_CURSOR_KEYS = [...DATE_CURSOR_KEYS, "sortValue"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (value: Record<string, unknown>, expected: string[]) => {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
};

const isCanonicalCursorTimestamp = (value: string) => {
  const match = CURSOR_TIMESTAMP_PATTERN.exec(value);
  if (!match) return false;
  const fraction = match[1];
  if (!fraction) return false;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return false;
  return `${parsed.toISOString().slice(0, -1)}${fraction.slice(3)}Z` === value;
};

const isProductCursor = (value: unknown): value is ProductCursor => {
  if (
    !isRecord(value) ||
    value.v !== 1 ||
    typeof value.sort !== "string" ||
    !PRODUCT_SORTS.has(value.sort) ||
    typeof value.createdAt !== "string" ||
    !isCanonicalCursorTimestamp(value.createdAt) ||
    typeof value.productId !== "string" ||
    !UUID_PATTERN.test(value.productId)
  )
    return false;
  if (DATE_PRODUCT_SORTS.has(value.sort as ProductSort)) return hasExactKeys(value, DATE_CURSOR_KEYS);
  return (
    METRIC_PRODUCT_SORTS.has(value.sort as ProductSort) &&
    hasExactKeys(value, METRIC_CURSOR_KEYS) &&
    typeof value.sortValue === "number" &&
    Number.isFinite(value.sortValue)
  );
};

export const encodeProductCursor = (cursor: ProductCursor) => Buffer.from(JSON.stringify(cursor)).toString("base64url");

export const decodeProductCursor = (cursor: string, expectedSort: ProductSort): ProductCursor => {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!isProductCursor(value) || value.sort !== expectedSort) throw new Error("invalid cursor");
    return value;
  } catch {
    throw new CustomBadRequestException(CatalogErrorMessage.InvalidCursor);
  }
};

@Injectable()
export class CatalogService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  listCategories = () =>
    this.db
      .select()
      .from(categories)
      .where(eq(categories.isActive, true))
      .orderBy(categories.sortOrder, categories.name);

  listCatalogFilterOptions = async (): Promise<CatalogFilterOptionsType> => {
    const [categoryRows, brandRows, colorRows, sizeRows] = await Promise.all([
      this.db
        .select()
        .from(categories)
        .where(eq(categories.isActive, true))
        .orderBy(asc(categories.sortOrder), asc(categories.name)),
      this.db.select().from(brands).where(eq(brands.isActive, true)).orderBy(asc(brands.name)),
      this.db.select().from(colors).where(eq(colors.isActive, true)).orderBy(asc(colors.name)),
      this.db.select().from(sizes).where(eq(sizes.isActive, true)).orderBy(asc(sizes.sortOrder), asc(sizes.name)),
    ]);
    return {
      categories: categoryRows,
      brands: brandRows,
      colors: colorRows,
      sizes: sizeRows,
    };
  };

  createCategory = async (input: CreateCategoryInput) => {
    return requireResult((await this.db.insert(categories).values(input).returning())[0]);
  };

  listProducts = async (filter: ProductFilterInput) => {
    const { nodes, hasNextPage, nextCursor, totalCount } = await this.listCatalogProducts(filter);
    return {
      nodes,
      hasNextPage,
      nextCursor,
      totalCount,
    };
  };

  listProductPriceSummaries = async (filter: ProductFilterInput) => {
    const { nodes: productsWithSkus, hasNextPage, nextCursor, totalCount } = await this.listCatalogProducts(filter);
    return {
      nodes: productsWithSkus.map((product) => this.toPriceSummary(product)),
      hasNextPage,
      nextCursor,
      totalCount,
    };
  };

  getProductPriceSummary = async (productId: string) => this.toPriceSummary(await this.getProduct(productId));

  getProductPriceEvidence = async (productId: string, priceRevision?: string): Promise<ProductPriceEvidenceType> => {
    const product = await this.getProduct(productId);
    const summary = this.toPriceSummary(product);
    const revision = priceRevision ?? summary.priceRevision;
    return {
      productId: product.productId,
      priceRevision: revision,
      priceHistory: [
        {
          label: "기준가",
          price: summary.basePrice,
          recordedAt: product.createdAt,
        },
        {
          label: "현재 최저가",
          price: summary.finalPrice,
          recordedAt: product.createdAt,
        },
      ],
      couponConditions: [
        {
          title: "다담장 위시템 기본 혜택",
          discountAmount: Math.max(summary.basePrice - summary.finalPrice, 0),
          condition: "상품 비교 화면에서 최저 옵션 기준으로 적용",
        },
      ],
      shippingPolicy: {
        title: "기본 배송",
        shippingFee: summary.finalPrice >= 30_000 ? 0 : 3_000,
        condition: "30,000원 이상 무료 배송",
      },
      offerSource: "product_sku_lowest_price",
      calculatedAt: new Date(),
    };
  };

  private listCatalogProducts = async (filter: ProductFilterInput) => {
    const first = Math.min(Math.max(filter.first ?? 20, 1), MAX_PAGE_SIZE);
    const selectedSort = filter.sort ?? ProductSort.RECOMMENDED;
    const cursor = filter.after ? decodeProductCursor(filter.after, selectedSort) : undefined;
    return this.db.transaction(
      async (tx) => {
        const candidateSkuMetrics = this.activeSkuMetrics(tx, "candidateSkuMetrics");
        const activeLowestPrice = sql<number>`${candidateSkuMetrics.activeLowestPrice}`;
        const activeStockTotal = sql<number>`${candidateSkuMetrics.activeStockTotal}`;
        const conditions = this.productConditions(filter, activeLowestPrice);
        const sortValue =
          selectedSort === ProductSort.LOW_PRICE || selectedSort === ProductSort.HIGH_PRICE
            ? activeLowestPrice
            : selectedSort === ProductSort.POPULAR
              ? activeStockTotal
              : undefined;
        const cursorCondition = cursor ? this.productCursorCondition(cursor, sortValue) : undefined;
        const order = sortValue
          ? [
              selectedSort === ProductSort.LOW_PRICE ? asc(sortValue) : desc(sortValue),
              desc(products.createdAt),
              desc(products.productId),
            ]
          : [desc(products.createdAt), desc(products.productId)];
        const cursorCreatedAt = sql<string>`to_char(${products.createdAt}, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
          "cursorCreatedAt",
        );
        const cursorSortValue = sql<number | null>`${sortValue ?? sql`null::double precision`}`.as("cursorSortValue");
        const countSkuMetrics = this.activeSkuMetrics(tx, "countSkuMetrics");
        const countLowestPrice = sql<number>`${countSkuMetrics.activeLowestPrice}`;
        const countRowsPromise =
          filter.minPrice !== undefined || filter.maxPrice !== undefined
            ? tx
                .select({ count: sql<number>`count(*)` })
                .from(products)
                .leftJoinLateral(countSkuMetrics, sql`true`)
                .where(and(...this.productConditions(filter, countLowestPrice)))
            : tx
                .select({ count: sql<number>`count(*)` })
                .from(products)
                .where(and(...this.productConditions(filter)));
        const [rows, countRows] = await Promise.all([
          tx
            .select({ ...getTableColumns(products), cursorCreatedAt, cursorSortValue })
            .from(products)
            .leftJoinLateral(candidateSkuMetrics, sql`true`)
            .where(and(...conditions, cursorCondition))
            .orderBy(...order)
            .limit(first + 1),
          countRowsPromise,
        ]);
        const pageRows = rows.slice(0, first);
        const nodes = await this.withSkus(
          pageRows.map(({ cursorCreatedAt: _, cursorSortValue: __, ...product }) => product),
          tx,
        );
        const hasNextPage = rows.length > first;
        const tailRow = pageRows[pageRows.length - 1];
        return {
          nodes,
          hasNextPage,
          nextCursor:
            hasNextPage && tailRow
              ? encodeProductCursor(
                  this.toProductCursor(
                    tailRow.productId,
                    tailRow.cursorCreatedAt,
                    selectedSort,
                    tailRow.cursorSortValue,
                  ),
                )
              : null,
          totalCount: Number(countRows[0]?.count ?? 0),
        };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  };

  private productCursorCondition = (cursor: ProductCursor, sortValue: SQL<number> | undefined) => {
    const tieBreaker = sql`(${products.createdAt}, ${products.productId}) < (${cursor.createdAt}::timestamp, ${cursor.productId}::uuid)`;
    if (!("sortValue" in cursor)) return tieBreaker;
    if (!sortValue) throw new CustomBadRequestException(CatalogErrorMessage.InvalidCursor);
    return or(
      cursor.sort === ProductSort.LOW_PRICE
        ? sql`${sortValue} > ${cursor.sortValue}`
        : sql`${sortValue} < ${cursor.sortValue}`,
      and(sql`${sortValue} = ${cursor.sortValue}`, tieBreaker),
    );
  };

  private activeSkuMetrics = (db: CatalogDatabase, alias: string) =>
    db
      .select({
        activeLowestPrice: sql<number>`coalesce(min(${productSkus.price}), 0)::double precision`.as(
          "activeLowestPrice",
        ),
        activeStockTotal: sql<number>`coalesce(sum(${productSkus.stock}), 0)::double precision`.as("activeStockTotal"),
      })
      .from(productSkus)
      .where(and(eq(productSkus.productId, products.productId), eq(productSkus.isActive, true)))
      .as(alias);

  private productConditions = (filter: ProductFilterInput, activeLowestPrice?: SQL<number>) => {
    const conditions = [eq(products.status, "PUBLISHED")];
    if (filter.categoryIds?.length) conditions.push(inArray(products.categoryId, filter.categoryIds));
    else if (filter.categoryId) conditions.push(eq(products.categoryId, filter.categoryId));
    if (filter.query?.trim()) conditions.push(ilike(products.title, `%${filter.query.trim()}%`));
    if (filter.brandIds?.length) conditions.push(inArray(products.brandId, filter.brandIds));
    if (filter.saleOnly !== undefined) conditions.push(eq(products.isOnSale, filter.saleOnly));
    if (filter.expressOnly !== undefined) conditions.push(eq(products.isExpressDelivery, filter.expressOnly));

    const skuConditions = [sql`${productSkus.productId} = ${products.productId}`, sql`${productSkus.isActive} = true`];
    if (filter.colorIds?.length) skuConditions.push(inArray(productSkus.colorId, filter.colorIds));
    if (filter.sizeIds?.length) skuConditions.push(inArray(productSkus.sizeId, filter.sizeIds));
    if (filter.colorIds?.length || filter.sizeIds?.length) {
      conditions.push(sql`exists (select 1 from ${productSkus} where ${sql.join(skuConditions, sql` and `)})`);
    }

    if (filter.minPrice !== undefined || filter.maxPrice !== undefined) {
      if (!activeLowestPrice) throw new Error("Active SKU price metric is required");
      if (filter.minPrice !== undefined) conditions.push(gte(activeLowestPrice, filter.minPrice));
      if (filter.maxPrice !== undefined) conditions.push(lte(activeLowestPrice, filter.maxPrice));
    }

    return conditions;
  };

  getProduct = async (productId: string) => {
    const [product] = await this.db
      .select()
      .from(products)
      .where(and(eq(products.productId, productId), eq(products.status, "PUBLISHED")))
      .limit(1);
    if (!product) throw new CustomNotFoundException(CatalogErrorMessage.ProductNotFound);
    return requireResult((await this.withSkus([product]))[0]);
  };

  getProductsByIds = async (productIds: string[]): Promise<ProductType[]> => {
    if (!productIds.length) return [];
    const rows = await this.db
      .select()
      .from(products)
      .where(and(inArray(products.productId, productIds), eq(products.status, "PUBLISHED")));
    return this.withSkus(rows);
  };

  createDraft = async (partnerId: string, input: CreateProductDraftInput) => {
    if (input.skus.length === 0) throw new CustomBadRequestException("At least one SKU is required");
    if (input.skus.some((sku) => sku.price < 0 || sku.stock < 0))
      throw new CustomBadRequestException(CatalogErrorMessage.InvalidPriceOrStock);
    return this.db.transaction(async (tx) => {
      const product = requireResult(
        (
          await tx
            .insert(products)
            .values({
              partnerId,
              categoryId: input.categoryId,
              brandId: input.brandId,
              title: input.title,
              description: input.description,
              imageUrls: input.imageUrls,
              isOnSale: input.isOnSale,
              isExpressDelivery: input.isExpressDelivery,
            })
            .returning()
        )[0],
      );
      await tx
        .insert(productSkus)
        .values(input.skus.map((sku, position) => ({ ...sku, position, productId: product.productId })));
      return product;
    });
  };

  getPartnerProduct = async (partnerId: string, productId: string) => {
    const [product] = await this.db
      .select()
      .from(products)
      .where(and(eq(products.productId, productId), eq(products.partnerId, partnerId)))
      .limit(1);
    if (!product) throw new CustomNotFoundException(CatalogErrorMessage.ProductNotFound);
    return requireResult((await this.withSkus([product]))[0]);
  };

  approveProduct = async (productId: string, approved: boolean, rejectionReason?: string) => {
    const [product] = await this.db
      .update(products)
      .set({
        approvalStatus: approved ? "APPROVED" : "REJECTED",
        rejectionReason: approved ? null : (rejectionReason ?? "Rejected by administrator"),
        updatedAt: new Date(),
      })
      .where(eq(products.productId, productId))
      .returning();
    if (!product) throw new CustomNotFoundException(CatalogErrorMessage.ProductNotFound);
    return product;
  };

  publishProduct = async (partnerId: string, productId: string) => {
    const [product] = await this.db
      .update(products)
      .set({ status: "PUBLISHED", publishedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(products.productId, productId),
          eq(products.partnerId, partnerId),
          eq(products.approvalStatus, "APPROVED"),
        ),
      )
      .returning();
    if (!product) throw new CustomBadRequestException(CatalogErrorMessage.PublishUnapprovedProduct);
    return product;
  };

  private withSkus = async (
    productRows: (typeof products.$inferSelect)[],
    db: CatalogDatabase = this.db,
  ): Promise<ProductType[]> => {
    if (productRows.length === 0) return [];
    const productIds = productRows.map((product) => product.productId);
    const brandIds = productRows.flatMap((product) => (product.brandId ? [product.brandId] : []));
    const [skus, brandRows] = await Promise.all([
      db
        .select()
        .from(productSkus)
        .where(and(inArray(productSkus.productId, productIds), eq(productSkus.isActive, true)))
        .orderBy(asc(productSkus.position), asc(productSkus.skuId)),
      brandIds.length
        ? db
            .select({ brandId: brands.brandId, name: brands.name, slug: brands.slug })
            .from(brands)
            .where(inArray(brands.brandId, brandIds))
        : Promise.resolve<{ brandId: string; name: string; slug: string }[]>([]),
    ]);
    const skuMap = new Map<string, (typeof productSkus.$inferSelect)[]>();
    for (const sku of skus) {
      const productSkuRows = skuMap.get(sku.productId) ?? [];
      productSkuRows.push(sku);
      skuMap.set(sku.productId, productSkuRows);
    }
    const brandById = new Map(brandRows.map((brand) => [brand.brandId, brand]));
    return productRows.map((product) => ({
      ...product,
      brand: product.brandId ? (brandById.get(product.brandId) ?? null) : null,
      skus: skuMap.get(product.productId) ?? [],
    }));
  };

  private toProductCursor = (
    productId: string,
    createdAt: string,
    sort: ProductSort,
    cursorSortValue: number | null,
  ): ProductCursor => {
    if (sort === ProductSort.LATEST || sort === ProductSort.RECOMMENDED) return { v: 1, sort, createdAt, productId };
    if (cursorSortValue === null) throw new Error("Catalog cursor sort metric is required");
    return {
      v: 1,
      sort,
      sortValue: cursorSortValue,
      createdAt,
      productId,
    };
  };

  private lowestSkuPrice = (product: ProductType) =>
    product.skus.length > 0 ? Math.min(...product.skus.map((sku) => sku.price)) : 0;

  private highestSkuPrice = (product: ProductType) =>
    product.skus.length > 0 ? Math.max(...product.skus.map((sku) => sku.price)) : 0;

  private toPriceSummary = (product: ProductType): ProductPriceSummaryType => {
    const finalPrice = this.lowestSkuPrice(product);
    const basePrice = this.highestSkuPrice(product);
    const discountAmount = Math.max(basePrice - finalPrice, 0);
    return {
      productId: product.productId,
      name: product.title,
      thumbnail: product.imageUrls[0] ?? null,
      isOnSale: product.isOnSale,
      isExpressDelivery: product.isExpressDelivery,
      basePrice,
      finalPrice,
      priceRevision: `${product.productId}:${product.createdAt.getTime()}:${finalPrice}`,
      lowestPriceEvidenceSummary:
        discountAmount > 0 ? `최저 옵션 기준 ${discountAmount.toLocaleString()}원 차이` : "현재 옵션 최저가 기준",
    };
  };
}
