import { Inject, Injectable } from "@nestjs/common";
import { SQL, and, asc, desc, eq, exists, getTableColumns, ilike, inArray, or, sql } from "drizzle-orm";
import { CustomBadRequestException, CustomNotFoundException } from "src/common/errors/custom-exceptions";
import { requireResult } from "src/common/invariants/require-result";
import { Database, DRIZZLE } from "src/modules/database/database.module";
import {
  activityEvents,
  brands,
  categories,
  colors,
  partners,
  productSkus,
  products,
  sizes,
} from "src/modules/database/schema";
import { EmailService } from "src/modules/email/email.service";
import { MediaService } from "src/modules/media/media.service";
import { PartnerErrorMessage } from "./partner.error";
import {
  ApplyPartnerInput,
  PartnerProductFilterInput,
  PartnerProductInput,
  PartnerProductState,
} from "./partner.types";

type Cursor = { updatedAt: string; productId: string };
const encodeCursor = (value: Cursor) => Buffer.from(JSON.stringify(value)).toString("base64url");
const decodeCursor = (value: string): Cursor => {
  try {
    const cursor = JSON.parse(Buffer.from(value, "base64url").toString()) as Cursor;
    if (!cursor.productId || Number.isNaN(Date.parse(cursor.updatedAt))) throw new Error();
    return cursor;
  } catch {
    throw new CustomBadRequestException("Invalid cursor");
  }
};

@Injectable()
export class PartnerService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly emailService: EmailService,
    private readonly mediaService: MediaService,
  ) {}

  apply = async (ownerUserId: string, input: ApplyPartnerInput) => {
    const [existing] = await this.db.select().from(partners).where(eq(partners.ownerUserId, ownerUserId)).limit(1);
    if (existing) throw new CustomBadRequestException(PartnerErrorMessage.AlreadyExists);
    const businessEmail = this.emailService.normalizeEmail(input.businessEmail);
    await this.emailService.consumeVerifiedEmailToken(input.businessEmailVerificationToken, businessEmail);
    const partner = requireResult(
      (
        await this.db
          .insert(partners)
          .values({ ...input, businessEmail, ownerUserId })
          .returning()
      )[0],
    );
    await this.db.insert(activityEvents).values({
      actorUserId: ownerUserId,
      eventType: "PARTNER_APPLICATION_SUBMITTED",
      subjectType: "PARTNER",
      subjectId: partner.partnerId,
    });
    return partner;
  };

  getMine = async (ownerUserId: string) => {
    const [partner] = await this.db.select().from(partners).where(eq(partners.ownerUserId, ownerUserId)).limit(1);
    if (!partner) throw new CustomNotFoundException(PartnerErrorMessage.NotFound);
    const [brand] = partner.brandId
      ? await this.db.select().from(brands).where(eq(brands.brandId, partner.brandId)).limit(1)
      : [];
    return { ...partner, brand: brand ?? null };
  };

  dashboard = async (ownerUserId: string) => {
    const partner = await this.approvedPartner(ownerUserId);
    const rows = await this.db
      .select({ status: products.status, approvalStatus: products.approvalStatus, count: sql<number>`count(*)` })
      .from(products)
      .where(and(eq(products.partnerId, partner.partnerId), eq(products.brandId, partner.brandId)))
      .groupBy(products.status, products.approvalStatus);
    const result = { draftCount: 0, pendingCount: 0, rejectedCount: 0, approvedCount: 0, publishedCount: 0 };
    for (const row of rows) {
      const key = `${this.state(row)}Count` as keyof typeof result;
      result[key] += Number(row.count);
    }
    return result;
  };

  listProducts = async (ownerUserId: string, filter: PartnerProductFilterInput) => {
    const partner = await this.approvedPartner(ownerUserId);
    const first = Math.min(Math.max(filter.first ?? 20, 1), 100);
    const conditions: (SQL | undefined)[] = [
      eq(products.partnerId, partner.partnerId),
      eq(products.brandId, partner.brandId),
    ];
    if (filter.query?.trim()) {
      const query = `%${filter.query.trim()}%`;
      conditions.push(
        or(
          ilike(products.title, query),
          exists(
            this.db
              .select({ value: sql`1` })
              .from(productSkus)
              .where(and(eq(productSkus.productId, products.productId), ilike(productSkus.code, query))),
          ),
        ),
      );
    }
    if (filter.categoryId) conditions.push(eq(products.categoryId, filter.categoryId));
    if (filter.state === PartnerProductState.Published) conditions.push(eq(products.status, "PUBLISHED"));
    else if (filter.state)
      conditions.push(and(eq(products.status, "DRAFT"), eq(products.approvalStatus, filter.state)));
    if (filter.after) {
      const cursor = decodeCursor(filter.after);
      const cursorUpdatedAt = sql`${cursor.updatedAt}::timestamp`;
      conditions.push(
        or(
          sql`${products.updatedAt} < ${cursorUpdatedAt}`,
          and(sql`${products.updatedAt} = ${cursorUpdatedAt}`, sql`${products.productId} < ${cursor.productId}`),
        ),
      );
    }
    const [rows, count] = await Promise.all([
      this.db
        .select({ ...getTableColumns(products), cursorUpdatedAt: sql<string>`${products.updatedAt}::text` })
        .from(products)
        .where(and(...conditions))
        .orderBy(desc(products.updatedAt), desc(products.productId))
        .limit(first + 1),
      this.db
        .select({ count: sql<number>`count(*)` })
        .from(products)
        .where(and(...conditions.slice(0, filter.after ? -1 : undefined))),
    ]);
    const pageRows = rows.slice(0, first);
    const nodes = await this.hydrate(ownerUserId, pageRows);
    const tail = pageRows[pageRows.length - 1];
    return {
      nodes,
      hasNextPage: rows.length > first,
      nextCursor:
        rows.length > first && tail
          ? encodeCursor({ updatedAt: tail.cursorUpdatedAt, productId: tail.productId })
          : null,
      totalCount: Number(count[0]?.count ?? 0),
    };
  };

  getProduct = async (ownerUserId: string, productId: string) => {
    const partner = await this.approvedPartner(ownerUserId);
    const [product] = await this.db
      .select()
      .from(products)
      .where(
        and(
          eq(products.productId, productId),
          eq(products.partnerId, partner.partnerId),
          eq(products.brandId, partner.brandId),
        ),
      )
      .limit(1);
    if (!product) throw new CustomNotFoundException("Product not found");
    return requireResult((await this.hydrate(ownerUserId, [product]))[0]);
  };

  createDraft = async (ownerUserId: string, input: PartnerProductInput) => {
    const partner = await this.approvedPartner(ownerUserId);
    const imageKeys = await this.validate(ownerUserId, input);
    const imageUrls = await Promise.all(imageKeys.map((key) => this.mediaService.getProductImageUrl(key)));
    const created = await this.db.transaction(async (tx) => {
      const product = requireResult(
        (
          await tx
            .insert(products)
            .values({
              partnerId: partner.partnerId,
              brandId: partner.brandId,
              categoryId: input.categoryId,
              title: input.title.trim(),
              description: input.description.trim(),
              imageKeys,
              imageUrls,
              approvalStatus: "DRAFT",
              isOnSale: input.isOnSale,
              isExpressDelivery: input.isExpressDelivery,
            })
            .returning()
        )[0],
      );
      await tx
        .insert(productSkus)
        .values(input.skus.map((sku, position) => ({ ...sku, position, productId: product.productId })));
      await this.mediaService.replaceImageReferences(tx, "PRODUCT", product.productId, imageKeys);
      return product;
    });
    return this.getProduct(ownerUserId, created.productId);
  };

  updateDraft = async (ownerUserId: string, productId: string, input: PartnerProductInput) => {
    const partner = await this.approvedPartner(ownerUserId);
    const imageKeys = await this.validate(ownerUserId, input);
    const imageUrls = await Promise.all(imageKeys.map((key) => this.mediaService.getProductImageUrl(key)));
    await this.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(products)
        .set({
          categoryId: input.categoryId,
          title: input.title.trim(),
          description: input.description.trim(),
          imageKeys,
          imageUrls,
          isOnSale: input.isOnSale,
          isExpressDelivery: input.isExpressDelivery,
          approvalStatus: "DRAFT",
          rejectionReason: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(products.productId, productId),
            eq(products.partnerId, partner.partnerId),
            eq(products.brandId, partner.brandId),
            eq(products.status, "DRAFT"),
            inArray(products.approvalStatus, ["DRAFT", "REJECTED"]),
          ),
        )
        .returning();
      if (!updated) throw new CustomBadRequestException(PartnerErrorMessage.InvalidTransition);
      await tx.delete(productSkus).where(eq(productSkus.productId, productId));
      await tx.insert(productSkus).values(input.skus.map((sku, position) => ({ ...sku, position, productId })));
      await this.mediaService.replaceImageReferences(tx, "PRODUCT", productId, imageKeys);
    });
    return this.getProduct(ownerUserId, productId);
  };

  submit = async (ownerUserId: string, productId: string) =>
    this.transition(ownerUserId, productId, "DRAFT", "PENDING", false);
  publish = async (ownerUserId: string, productId: string) =>
    this.transition(ownerUserId, productId, "APPROVED", "APPROVED", true);

  publishProduct = async (ownerUserId: string, productId: string) => {
    const partner = await this.getMine(ownerUserId);
    if (partner.status !== "APPROVED")
      throw new CustomBadRequestException(PartnerErrorMessage.ApprovalRequiredForPublishing);
    return this.publish(ownerUserId, productId);
  };

  private transition = async (ownerUserId: string, productId: string, from: string, to: string, publish: boolean) => {
    const partner = await this.approvedPartner(ownerUserId);
    const [candidate] = await this.db
      .select()
      .from(products)
      .where(
        and(
          eq(products.productId, productId),
          eq(products.partnerId, partner.partnerId),
          eq(products.brandId, partner.brandId),
          eq(products.status, "DRAFT"),
          eq(products.approvalStatus, from),
        ),
      )
      .limit(1);
    if (!candidate) throw new CustomBadRequestException(PartnerErrorMessage.InvalidTransition);
    await this.mediaService.validateProductImageObjects(candidate.imageKeys, ownerUserId);
    const [product] = await this.db
      .update(products)
      .set(
        publish
          ? { status: "PUBLISHED", publishedAt: new Date(), updatedAt: new Date() }
          : { approvalStatus: to, updatedAt: new Date() },
      )
      .where(
        and(
          eq(products.productId, productId),
          eq(products.partnerId, partner.partnerId),
          eq(products.brandId, partner.brandId),
          eq(products.status, "DRAFT"),
          eq(products.approvalStatus, from),
        ),
      )
      .returning();
    if (!product) throw new CustomBadRequestException(PartnerErrorMessage.InvalidTransition);
    return this.getProduct(ownerUserId, productId);
  };

  private approvedPartner = async (ownerUserId: string) => {
    const partner = await this.getMine(ownerUserId);
    if (partner.status !== "APPROVED" || !partner.brandId)
      throw new CustomBadRequestException(PartnerErrorMessage.ApprovalRequiredForProduct);
    return { ...partner, brandId: partner.brandId };
  };

  private validate = async (ownerUserId: string, input: PartnerProductInput) => {
    if (
      input.title.trim().length < 1 ||
      input.title.length > 200 ||
      input.description.trim().length < 1 ||
      input.description.length > 2000 ||
      input.imageKeys.length < 1 ||
      input.imageKeys.length > 10 ||
      input.skus.length < 1 ||
      input.skus.some(
        (sku) => !Number.isInteger(sku.price) || sku.price < 0 || !Number.isInteger(sku.stock) || sku.stock < 0,
      ) ||
      new Set(input.skus.map((sku) => sku.code)).size !== input.skus.length
    )
      throw new CustomBadRequestException(PartnerErrorMessage.InvalidProductInput);
    if (input.imageKeys.some((key) => !this.mediaService.isProductImageKeyForUser(key, ownerUserId)))
      throw new CustomBadRequestException(PartnerErrorMessage.ImageOwnership);
    const [category] = await this.db
      .select()
      .from(categories)
      .where(and(eq(categories.categoryId, input.categoryId), eq(categories.isActive, true)))
      .limit(1);
    const colorIds = input.skus.flatMap((sku) => (sku.colorId ? [sku.colorId] : []));
    const sizeIds = input.skus.flatMap((sku) => (sku.sizeId ? [sku.sizeId] : []));
    const [validColors, validSizes] = await Promise.all([
      colorIds.length
        ? this.db
            .select()
            .from(colors)
            .where(and(inArray(colors.colorId, colorIds), eq(colors.isActive, true)))
        : [],
      sizeIds.length
        ? this.db
            .select()
            .from(sizes)
            .where(and(inArray(sizes.sizeId, sizeIds), eq(sizes.isActive, true)))
        : [],
    ]);
    if (
      !category ||
      new Set(validColors.map((v) => v.colorId)).size !== new Set(colorIds).size ||
      new Set(validSizes.map((v) => v.sizeId)).size !== new Set(sizeIds).size
    )
      throw new CustomBadRequestException(PartnerErrorMessage.CatalogOptionInactive);
    return this.mediaService.validateProductImageObjects(input.imageKeys, ownerUserId);
  };

  private hydrate = async (ownerUserId: string, rows: (typeof products.$inferSelect)[]) => {
    if (!rows.length) return [];
    const skus = await this.db
      .select()
      .from(productSkus)
      .where(
        inArray(
          productSkus.productId,
          rows.map((row) => row.productId),
        ),
      )
      .orderBy(asc(productSkus.position), asc(productSkus.skuId));
    const partner = await this.getMine(ownerUserId);
    return Promise.all(
      rows.map(async (row) => ({
        ...row,
        brand: partner.brand,
        skus: skus.filter((sku) => sku.productId === row.productId),
        imageUrls: await Promise.all(row.imageKeys.map((key) => this.mediaService.getProductImageUrl(key))),
      })),
    );
  };

  private state = (row: { status: string; approvalStatus: string }) =>
    row.status === "PUBLISHED" ? "published" : row.approvalStatus.toLowerCase();
}
