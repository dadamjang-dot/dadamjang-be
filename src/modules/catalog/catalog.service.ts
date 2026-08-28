import { Inject, Injectable } from "@nestjs/common";
import { SQL, and, asc, desc, eq, getTableColumns, gte, ilike, inArray, lte, or, sql } from "drizzle-orm";
import { CustomBadRequestException, CustomNotFoundException } from "src/common/errors/custom-exceptions";
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

type ProductCursor = { createdAt: string; productId: string; sortValue?: number };

export const encodeProductCursor = (cursor: ProductCursor) => Buffer.from(JSON.stringify(cursor)).toString("base64url");

export const decodeProductCursor = (cursor: string): ProductCursor => {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as ProductCursor;
    if (
      !value.createdAt ||
      !value.productId ||
      Number.isNaN(Date.parse(value.createdAt)) ||
      (value.sortValue !== undefined && !Number.isFinite(value.sortValue))
    )
      throw new Error("invalid cursor");
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
    const [category] = await this.db.insert(categories).values(input).returning();
    return category;
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
    const cursor = filter.after ? decodeProductCursor(filter.after) : undefined;
    const selectedSort = filter.sort ?? ProductSort.RECOMMENDED;
    const conditions = this.productConditions(filter);
    const sortValue =
      selectedSort === ProductSort.LOW_PRICE || selectedSort === ProductSort.HIGH_PRICE
        ? sql<number>`coalesce(${this.activeLowestPrice()}, 0)::double precision`
        : selectedSort === ProductSort.POPULAR
          ? this.activeStockTotal()
          : undefined;
    const cursorCondition = cursor ? this.productCursorCondition(cursor, selectedSort, sortValue) : undefined;
    const order = sortValue
      ? [
          selectedSort === ProductSort.LOW_PRICE ? asc(sortValue) : desc(sortValue),
          desc(products.createdAt),
          desc(products.productId),
        ]
      : [desc(products.createdAt), desc(products.productId)];
    const cursorCreatedAt = sql<string>`to_char(${products.createdAt}, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
    const [rows, countRows] = await Promise.all([
      this.db
        .select({ ...getTableColumns(products), cursorCreatedAt })
        .from(products)
        .where(and(...conditions, cursorCondition))
        .orderBy(...order)
        .limit(first + 1),
      this.db
        .select({ count: sql<number>`count(*)` })
        .from(products)
        .where(and(...conditions)),
    ]);
    const pageRows = rows.slice(0, first);
    const nodes = await this.withSkus(pageRows.map(({ cursorCreatedAt: _, ...product }) => product));
    const hasNextPage = rows.length > first;
    const tail = nodes[nodes.length - 1];
    const tailRow = pageRows[pageRows.length - 1];
    return {
      nodes,
      hasNextPage,
      nextCursor:
        hasNextPage && tail && tailRow
          ? encodeProductCursor(this.toProductCursor(tail, tailRow.cursorCreatedAt, filter.sort))
          : null,
      totalCount: Number(countRows[0]?.count ?? 0),
    };
  };

  private productCursorCondition = (cursor: ProductCursor, sort: ProductSort, sortValue: SQL<number> | undefined) => {
    const createdAt = sql`${cursor.createdAt}::timestamp`;
    const tieBreaker = or(
      sql`${products.createdAt} < ${createdAt}`,
      and(sql`${products.createdAt} = ${createdAt}`, sql`${products.productId} < ${cursor.productId}`),
    );
    if (!sortValue || cursor.sortValue === undefined) return tieBreaker;
    return or(
      sort === ProductSort.LOW_PRICE
        ? sql`${sortValue} > ${cursor.sortValue}`
        : sql`${sortValue} < ${cursor.sortValue}`,
      and(sql`${sortValue} = ${cursor.sortValue}`, tieBreaker),
    );
  };

  private activeLowestPrice = () => sql<number>`(
    select min(${productSkus.price})
    from ${productSkus}
    where ${productSkus.productId} = ${products.productId}
      and ${productSkus.isActive} = true
  )`;

  private activeStockTotal = () => sql<number>`coalesce((
    select sum(${productSkus.stock})
    from ${productSkus}
    where ${productSkus.productId} = ${products.productId}
      and ${productSkus.isActive} = true
  ), 0)::double precision`;

  private productConditions = (filter: ProductFilterInput) => {
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
      const lowestPrice = this.activeLowestPrice();
      if (filter.minPrice !== undefined) conditions.push(gte(lowestPrice, filter.minPrice));
      if (filter.maxPrice !== undefined) conditions.push(lte(lowestPrice, filter.maxPrice));
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
    return (await this.withSkus([product]))[0];
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
      const [product] = await tx
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
        .returning();
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
    return (await this.withSkus([product]))[0];
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

  private withSkus = async (productRows: (typeof products.$inferSelect)[]): Promise<ProductType[]> => {
    if (productRows.length === 0) return [];
    const productIds = productRows.map((product) => product.productId);
    const brandIds = productRows.flatMap((product) => (product.brandId ? [product.brandId] : []));
    const [skus, brandRows] = await Promise.all([
      this.db
        .select()
        .from(productSkus)
        .where(and(inArray(productSkus.productId, productIds), eq(productSkus.isActive, true)))
        .orderBy(asc(productSkus.position), asc(productSkus.skuId)),
      brandIds.length
        ? this.db
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
    product: ProductType,
    createdAt: string,
    sort?: ProductFilterInput["sort"],
  ): ProductCursor => {
    const selectedSort = sort ?? ProductSort.RECOMMENDED;
    return {
      createdAt,
      productId: product.productId,
      ...(selectedSort === ProductSort.LATEST || selectedSort === ProductSort.RECOMMENDED
        ? {}
        : { sortValue: this.sortValue(product, selectedSort) }),
    };
  };

  private sortValue = (product: ProductType, sort: ProductSort) => {
    if (sort === ProductSort.LOW_PRICE) return this.lowestSkuPrice(product);
    if (sort === ProductSort.HIGH_PRICE) return this.lowestSkuPrice(product);
    return this.stockTotal(product);
  };

  private stockTotal = (product: ProductType) => product.skus.reduce((sum, sku) => sum + sku.stock, 0);

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
