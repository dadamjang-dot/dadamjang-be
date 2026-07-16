import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, ilike, inArray, lt } from "drizzle-orm";
import { CustomBadRequestException, CustomNotFoundException } from "src/common/errors/custom-exceptions";
import { Database, DRIZZLE } from "src/modules/database/database.module";
import { categories, productSkus, products } from "src/modules/database/schema";
import { CatalogErrorMessage } from "./catalog.error";
import { MAX_PAGE_SIZE } from "./catalog.constant";
import {
  CreateCategoryInput,
  CreateProductDraftInput,
  ProductFilterInput,
  ProductPriceEvidenceType,
  ProductPriceSummaryType,
  ProductType,
} from "./catalog.types";

type ProductCursor = { createdAt: string; productId: string };

export const encodeProductCursor = (cursor: ProductCursor) => Buffer.from(JSON.stringify(cursor)).toString("base64url");

export const decodeProductCursor = (cursor: string): ProductCursor => {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as ProductCursor;
    if (!value.createdAt || !value.productId || Number.isNaN(Date.parse(value.createdAt)))
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

  createCategory = async (input: CreateCategoryInput) => {
    const [category] = await this.db.insert(categories).values(input).returning();
    return category;
  };

  listProducts = async (filter: ProductFilterInput) => {
    const { rows, first } = await this.listProductRows(filter);
    const nodes = await this.sortProducts(await this.withSkus(rows.slice(0, first)), filter.sort);
    const hasNextPage = rows.length > first;
    const tail = nodes[nodes.length - 1];
    return {
      nodes,
      hasNextPage,
      nextCursor:
        hasNextPage && tail
          ? encodeProductCursor({
              createdAt: tail.createdAt.toISOString(),
              productId: tail.productId,
            })
          : null,
    };
  };

  listProductPriceSummaries = async (filter: ProductFilterInput) => {
    const { rows, first } = await this.listProductRows(filter);
    const productsWithSkus = await this.sortProducts(await this.withSkus(rows.slice(0, first)), filter.sort);
    const nodes = productsWithSkus.map((product) => this.toPriceSummary(product));
    const hasNextPage = rows.length > first;
    const tail = productsWithSkus[productsWithSkus.length - 1];
    return {
      nodes,
      hasNextPage,
      nextCursor:
        hasNextPage && tail
          ? encodeProductCursor({
              createdAt: tail.createdAt.toISOString(),
              productId: tail.productId,
            })
          : null,
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

  private listProductRows = async (filter: ProductFilterInput) => {
    const first = Math.min(Math.max(filter.first ?? 20, 1), MAX_PAGE_SIZE);
    const cursor = filter.after ? decodeProductCursor(filter.after) : undefined;
    const conditions = [eq(products.status, "PUBLISHED")];
    if (filter.categoryId) conditions.push(eq(products.categoryId, filter.categoryId));
    if (filter.query?.trim()) conditions.push(ilike(products.title, `%${filter.query.trim()}%`));
    if (cursor) conditions.push(lt(products.createdAt, new Date(cursor.createdAt)));

    const rows = await this.db
      .select()
      .from(products)
      .where(and(...conditions))
      .orderBy(desc(products.createdAt), desc(products.productId))
      .limit(first + 1);
    return { rows, first };
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
          title: input.title,
          description: input.description,
          imageUrls: input.imageUrls,
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
    const skus = await this.db
      .select()
      .from(productSkus)
      .where(
        inArray(
          productSkus.productId,
          productRows.map((product) => product.productId),
        ),
      )
      .orderBy(productSkus.createdAt);
    const skuMap = new Map<string, (typeof productSkus.$inferSelect)[]>();
    skus.forEach((sku) => skuMap.set(sku.productId, [...(skuMap.get(sku.productId) ?? []), sku]));
    return productRows.map((product) => ({
      ...product,
      skus: skuMap.get(product.productId) ?? [],
    }));
  };

  private sortProducts = async (nodes: ProductType[], sort?: ProductFilterInput["sort"]) => {
    if (sort === "LOW_PRICE") {
      return [...nodes].sort((a, b) => this.lowestSkuPrice(a) - this.lowestSkuPrice(b));
    }
    if (sort === "POPULAR") {
      return [...nodes].sort(
        (a, b) => b.skus.reduce((sum, sku) => sum + sku.stock, 0) - a.skus.reduce((sum, sku) => sum + sku.stock, 0),
      );
    }
    return nodes;
  };

  private lowestSkuPrice = (product: ProductType) => Math.min(...product.skus.map((sku) => sku.price));

  private highestSkuPrice = (product: ProductType) => Math.max(...product.skus.map((sku) => sku.price));

  private toPriceSummary = (product: ProductType): ProductPriceSummaryType => {
    const finalPrice = this.lowestSkuPrice(product);
    const basePrice = this.highestSkuPrice(product);
    const discountAmount = Math.max(basePrice - finalPrice, 0);
    return {
      productId: product.productId,
      name: product.title,
      thumbnail: product.imageUrls[0] ?? null,
      basePrice,
      finalPrice,
      priceRevision: `${product.productId}:${product.createdAt.getTime()}:${finalPrice}`,
      lowestPriceEvidenceSummary:
        discountAmount > 0 ? `최저 옵션 기준 ${discountAmount.toLocaleString()}원 차이` : "현재 옵션 최저가 기준",
    };
  };
}
