import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, ilike, inArray, lt } from "drizzle-orm";
import { CustomBadRequestException, CustomNotFoundException } from "src/common/errors/custom-exceptions";
import { Database, DRIZZLE } from "src/modules/database/database.module";
import { categories, productSkus, products } from "src/modules/database/schema";
import { CreateCategoryInput, CreateProductDraftInput, ProductFilterInput, ProductType } from "./catalog.types";

type ProductCursor = { createdAt: string; productId: string };
const MAX_PAGE_SIZE = 50;

export const encodeProductCursor = (cursor: ProductCursor) => Buffer.from(JSON.stringify(cursor)).toString("base64url");

export const decodeProductCursor = (cursor: string): ProductCursor => {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as ProductCursor;
    if (!value.createdAt || !value.productId || Number.isNaN(Date.parse(value.createdAt)))
      throw new Error("invalid cursor");
    return value;
  } catch {
    throw new CustomBadRequestException("Invalid product cursor");
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
    const nodes = await this.withSkus(rows.slice(0, first));
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

  getProduct = async (productId: string) => {
    const [product] = await this.db
      .select()
      .from(products)
      .where(and(eq(products.productId, productId), eq(products.status, "PUBLISHED")))
      .limit(1);
    if (!product) throw new CustomNotFoundException("Product not found");
    return (await this.withSkus([product]))[0];
  };

  createDraft = async (partnerId: string, input: CreateProductDraftInput) => {
    if (input.skus.length === 0) throw new CustomBadRequestException("At least one SKU is required");
    if (input.skus.some((sku) => sku.price < 0 || sku.stock < 0))
      throw new CustomBadRequestException("Price and stock must be non-negative");
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
    if (!product) throw new CustomNotFoundException("Product not found");
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
    if (!product) throw new CustomNotFoundException("Product not found");
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
    if (!product) throw new CustomBadRequestException("Product must be approved before publishing");
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
}
