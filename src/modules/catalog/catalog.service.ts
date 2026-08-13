import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, gte, ilike, inArray, lte, sql } from "drizzle-orm";
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
    const conditions = this.productConditions(filter);
    const [rows, countRows] = await Promise.all([
      this.db
        .select()
        .from(products)
        .where(and(...conditions))
        .orderBy(desc(products.createdAt), desc(products.productId)),
      this.db
        .select({ count: sql<number>`count(*)` })
        .from(products)
        .where(and(...conditions)),
    ]);
    const filtered = (await this.withSkus(rows)).filter((product) => this.matchesFilter(product, filter));
    const sorted = this.sortProducts(filtered, filter.sort);
    const start = cursor ? this.cursorStart(sorted, cursor, filter.sort) : 0;
    const page = sorted.slice(start, start + first + 1);
    const nodes = page.slice(0, first);
    const hasNextPage = page.length > first;
    const tail = nodes[nodes.length - 1];
    return {
      nodes,
      hasNextPage,
      nextCursor: hasNextPage && tail ? encodeProductCursor(this.toProductCursor(tail, filter.sort)) : null,
      totalCount: Number(countRows[0]?.count ?? sorted.length),
    };
  };

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
      const lowestPrice = sql<number>`(
        select min(${productSkus.price})
        from ${productSkus}
        where ${productSkus.productId} = ${products.productId}
          and ${productSkus.isActive} = true
      )`;
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
      await tx.insert(productSkus).values(input.skus.map((sku) => ({ ...sku, productId: product.productId })));
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
        .orderBy(productSkus.createdAt),
      brandIds.length
        ? this.db
            .select({ brandId: brands.brandId, name: brands.name, slug: brands.slug })
            .from(brands)
            .where(inArray(brands.brandId, brandIds))
        : Promise.resolve<{ brandId: string; name: string; slug: string }[]>([]),
    ]);
    const skuMap = new Map<string, (typeof productSkus.$inferSelect)[]>();
    skus.forEach((sku) => skuMap.set(sku.productId, [...(skuMap.get(sku.productId) ?? []), sku]));
    const brandById = new Map(brandRows.map((brand) => [brand.brandId, brand]));
    return productRows.map((product) => ({
      ...product,
      brand: product.brandId ? (brandById.get(product.brandId) ?? null) : null,
      skus: skuMap.get(product.productId) ?? [],
    }));
  };

  private matchesFilter = (product: ProductType, filter: ProductFilterInput) => {
    if (filter.categoryIds?.length && !filter.categoryIds.includes(product.categoryId)) return false;
    if (!filter.categoryIds?.length && filter.categoryId && product.categoryId !== filter.categoryId) return false;
    if (filter.brandIds?.length && (!product.brandId || !filter.brandIds.includes(product.brandId))) return false;
    if (
      (filter.colorIds?.length || filter.sizeIds?.length) &&
      !product.skus.some(
        (sku) =>
          (!filter.colorIds?.length || (sku.colorId !== null && filter.colorIds.includes(sku.colorId))) &&
          (!filter.sizeIds?.length || (sku.sizeId !== null && filter.sizeIds.includes(sku.sizeId))),
      )
    )
      return false;
    if (filter.saleOnly !== undefined && product.isOnSale !== filter.saleOnly) return false;
    if (filter.expressOnly !== undefined && product.isExpressDelivery !== filter.expressOnly) return false;
    const lowestPrice = this.lowestSkuPrice(product);
    if (filter.minPrice !== undefined && lowestPrice < filter.minPrice) return false;
    if (filter.maxPrice !== undefined && lowestPrice > filter.maxPrice) return false;
    return true;
  };

  private sortProducts = (nodes: ProductType[], sort?: ProductFilterInput["sort"]) =>
    [...nodes].sort((left, right) => this.compareProducts(left, right, sort));

  private compareProducts = (left: ProductType, right: ProductType, sort?: ProductFilterInput["sort"]) => {
    const selectedSort = sort ?? ProductSort.RECOMMENDED;
    const valueComparison =
      selectedSort === ProductSort.LOW_PRICE
        ? this.lowestSkuPrice(left) - this.lowestSkuPrice(right)
        : selectedSort === ProductSort.HIGH_PRICE
          ? this.lowestSkuPrice(right) - this.lowestSkuPrice(left)
          : selectedSort === ProductSort.POPULAR
            ? this.stockTotal(right) - this.stockTotal(left)
            : right.createdAt.getTime() - left.createdAt.getTime();
    if (valueComparison !== 0) return valueComparison;
    const createdAtComparison = right.createdAt.getTime() - left.createdAt.getTime();
    return createdAtComparison !== 0 ? createdAtComparison : right.productId.localeCompare(left.productId);
  };

  private cursorStart = (nodes: ProductType[], cursor: ProductCursor, sort?: ProductFilterInput["sort"]) => {
    const cursorIndex = nodes.findIndex((node) => node.productId === cursor.productId);
    if (cursorIndex >= 0) return cursorIndex + 1;
    const start = nodes.findIndex((node) => this.compareProductToCursor(node, cursor, sort) > 0);
    return start >= 0 ? start : nodes.length;
  };

  private compareProductToCursor = (product: ProductType, cursor: ProductCursor, sort?: ProductFilterInput["sort"]) => {
    const selectedSort = sort ?? ProductSort.RECOMMENDED;
    if (
      selectedSort !== ProductSort.LATEST &&
      selectedSort !== ProductSort.RECOMMENDED &&
      cursor.sortValue !== undefined
    ) {
      const productValue = this.sortValue(product, selectedSort);
      const valueComparison =
        selectedSort === ProductSort.LOW_PRICE ? productValue - cursor.sortValue : cursor.sortValue - productValue;
      if (valueComparison !== 0) return valueComparison;
    }
    const createdAtComparison = Date.parse(cursor.createdAt) - product.createdAt.getTime();
    return createdAtComparison !== 0 ? createdAtComparison : cursor.productId.localeCompare(product.productId);
  };

  private toProductCursor = (product: ProductType, sort?: ProductFilterInput["sort"]): ProductCursor => {
    const selectedSort = sort ?? ProductSort.RECOMMENDED;
    return {
      createdAt: product.createdAt.toISOString(),
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
