import { Inject, Injectable } from "@nestjs/common";
import * as bcrypt from "bcrypt";
import { randomBytes, randomUUID } from "crypto";
import { SQL, and, asc, desc, eq, gt, gte, ilike, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import {
  CustomBadRequestException,
  CustomConflictException,
  CustomNotFoundException,
  CustomServiceUnavailableException,
} from "src/common/errors/custom-exceptions";
import { requireResult } from "src/common/invariants/require-result";
import { hashToken } from "src/common/security/token-hash";
import { CreateCategoryInput } from "src/modules/catalog/catalog.types";
import { Database, DRIZZLE } from "src/modules/database/database.module";
import {
  adminInvites,
  auditLogs,
  brands,
  categories,
  orderItems,
  orders,
  partners,
  productSkus,
  products,
  users,
} from "src/modules/database/schema";
import { EmailService } from "src/modules/email/email.service";
import {
  getAllowedOrderTransitions,
  getOrderTransitionRule,
  isOrderStatus,
  isPaymentStatus,
} from "src/modules/order/order.constant";
import { getCannotTransitionMessage } from "src/modules/order/order.error";
import { AdminErrorMessage } from "./admin.error";
import {
  AcceptAdminInviteInput,
  AdminAuditLogFilterInput,
  AdminInviteFilterInput,
  AdminOrderFilterInput,
  AdminPartnerFilterInput,
  AdminProductFilterInput,
  CreateAdminInviteInput,
  ReviewPartnerInput,
  ReviewProductInput,
  TransitionOrderInput,
  UpdateCategoryInput,
} from "./admin.types";

type AdminCursor = { createdAt: string; id: string };

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 30;

const encodeAdminCursor = (cursor: AdminCursor) => Buffer.from(JSON.stringify(cursor)).toString("base64url");

const decodeAdminCursor = (value: string): { createdAt: Date; id: string } => {
  try {
    const cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as AdminCursor;
    const createdAt = new Date(cursor.createdAt);
    if (!cursor.id || Number.isNaN(createdAt.getTime())) throw new Error("invalid cursor");
    return { createdAt, id: cursor.id };
  } catch {
    throw new CustomBadRequestException(AdminErrorMessage.InvalidCursor);
  }
};

const pageSize = (first?: number) => Math.min(Math.max(first ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);

const parseDate = (value?: string, endOfDay = false) => {
  if (!value) return undefined;
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? `${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}+09:00`
    : value;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) throw new CustomBadRequestException(AdminErrorMessage.InvalidDate);
  return date;
};

const rejectionReason = (approved: boolean, value?: string) => {
  if (approved) return null;
  const reason = value?.trim() ?? "";
  if (reason.length < 1 || reason.length > 500)
    throw new CustomBadRequestException(AdminErrorMessage.RejectionReasonRequired);
  return reason;
};

const isDatabaseError = (error: unknown, code: string, depth = 0): boolean => {
  if (typeof error !== "object" || error === null || depth > 4) return false;
  if ("code" in error && error.code === code) return true;
  return "cause" in error && isDatabaseError(error.cause, code, depth + 1);
};

@Injectable()
export class AdminService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly emailService: EmailService,
  ) {}

  getDashboard = async () => {
    const now = new Date();
    const [partnerCount, productCount, orderCount, inviteCount, recentAuditLogs] = await Promise.all([
      this.count(partners, eq(partners.status, "PENDING")),
      this.count(products, eq(products.approvalStatus, "PENDING")),
      this.count(orders, inArray(orders.status, ["PAYMENT_PENDING", "PAID", "FULFILLING"])),
      this.count(
        adminInvites,
        and(isNull(adminInvites.acceptedAt), isNull(adminInvites.revokedAt), gt(adminInvites.expiresAt, now)),
      ),
      this.listAuditLogs({ first: 5 }),
    ]);
    return {
      pendingPartnerCount: partnerCount,
      pendingProductCount: productCount,
      processingOrderCount: orderCount,
      activeInviteCount: inviteCount,
      recentAuditLogs: recentAuditLogs.nodes,
    };
  };

  listPartners = async (filter: AdminPartnerFilterInput) => {
    const first = pageSize(filter.first);
    const base = this.partnerConditions(filter);
    const cursor = filter.after ? decodeAdminCursor(filter.after) : undefined;
    const cursorCondition = cursor
      ? or(
          lt(partners.createdAt, cursor.createdAt),
          and(eq(partners.createdAt, cursor.createdAt), lt(partners.partnerId, cursor.id)),
        )
      : undefined;
    const [rows, totalCount] = await Promise.all([
      this.db
        .select({
          partnerId: partners.partnerId,
          ownerUserId: partners.ownerUserId,
          ownerUserid: users.userid,
          ownerEmail: users.email,
          businessEmail: partners.businessEmail,
          businessRegistrationNumber: partners.businessRegistrationNumber,
          tradeName: partners.tradeName,
          status: partners.status,
          rejectionReason: partners.rejectionReason,
          reviewedAt: partners.reviewedAt,
          createdAt: partners.createdAt,
        })
        .from(partners)
        .innerJoin(users, eq(partners.ownerUserId, users.userId))
        .where(and(...base, cursorCondition))
        .orderBy(desc(partners.createdAt), desc(partners.partnerId))
        .limit(first + 1),
      this.count(partners, and(...base)),
    ]);
    return this.toConnection(rows, first, totalCount, (node) => node.partnerId);
  };

  getPartner = async (partnerId: string) => {
    const [partner] = await this.db
      .select({
        partnerId: partners.partnerId,
        ownerUserId: partners.ownerUserId,
        ownerUserid: users.userid,
        ownerEmail: users.email,
        businessEmail: partners.businessEmail,
        businessRegistrationNumber: partners.businessRegistrationNumber,
        tradeName: partners.tradeName,
        status: partners.status,
        rejectionReason: partners.rejectionReason,
        reviewedAt: partners.reviewedAt,
        createdAt: partners.createdAt,
      })
      .from(partners)
      .innerJoin(users, eq(partners.ownerUserId, users.userId))
      .where(eq(partners.partnerId, partnerId))
      .limit(1);
    if (!partner) throw new CustomNotFoundException(AdminErrorMessage.PartnerNotFound);
    return { ...partner, auditLogs: await this.entityAuditLogs("PARTNER", partnerId) };
  };

  listProducts = async (filter: AdminProductFilterInput) => {
    const first = pageSize(filter.first);
    const base = this.productConditions(filter);
    const cursor = filter.after ? decodeAdminCursor(filter.after) : undefined;
    const cursorCondition = cursor
      ? or(
          lt(products.createdAt, cursor.createdAt),
          and(eq(products.createdAt, cursor.createdAt), lt(products.productId, cursor.id)),
        )
      : undefined;
    const [rows, totalCount] = await Promise.all([
      this.db
        .select({
          productId: products.productId,
          partnerId: products.partnerId,
          partnerName: partners.tradeName,
          categoryId: products.categoryId,
          categoryName: categories.name,
          title: products.title,
          status: products.status,
          approvalStatus: products.approvalStatus,
          rejectionReason: products.rejectionReason,
          imageUrls: products.imageUrls,
          createdAt: products.createdAt,
        })
        .from(products)
        .innerJoin(partners, eq(products.partnerId, partners.partnerId))
        .innerJoin(categories, eq(products.categoryId, categories.categoryId))
        .where(and(...base, cursorCondition))
        .orderBy(desc(products.createdAt), desc(products.productId))
        .limit(first + 1),
      this.count(products, and(...base)),
    ]);
    const nodes = rows.map(({ imageUrls, ...row }) => ({ ...row, thumbnailUrl: imageUrls[0] ?? null }));
    return this.toConnection(nodes, first, totalCount, (node) => node.productId);
  };

  getProduct = async (productId: string) => {
    const [product] = await this.db
      .select({
        productId: products.productId,
        partnerId: products.partnerId,
        partnerName: partners.tradeName,
        categoryId: products.categoryId,
        categoryName: categories.name,
        title: products.title,
        description: products.description,
        imageUrls: products.imageUrls,
        status: products.status,
        approvalStatus: products.approvalStatus,
        rejectionReason: products.rejectionReason,
        createdAt: products.createdAt,
      })
      .from(products)
      .innerJoin(partners, eq(products.partnerId, partners.partnerId))
      .innerJoin(categories, eq(products.categoryId, categories.categoryId))
      .where(eq(products.productId, productId))
      .limit(1);
    if (!product) throw new CustomNotFoundException(AdminErrorMessage.ProductNotFound);
    const [skus, history] = await Promise.all([
      this.db
        .select({
          skuId: productSkus.skuId,
          code: productSkus.code,
          optionName: productSkus.optionName,
          price: productSkus.price,
          stock: productSkus.stock,
          isActive: productSkus.isActive,
        })
        .from(productSkus)
        .where(eq(productSkus.productId, productId))
        .orderBy(asc(productSkus.createdAt)),
      this.entityAuditLogs("PRODUCT", productId),
    ]);
    return { ...product, thumbnailUrl: product.imageUrls[0] ?? null, skus, auditLogs: history };
  };

  listOrders = async (filter: AdminOrderFilterInput) => {
    const first = pageSize(filter.first);
    const base = this.orderConditions(filter);
    const cursor = filter.after ? decodeAdminCursor(filter.after) : undefined;
    const cursorCondition = cursor
      ? or(
          lt(orders.createdAt, cursor.createdAt),
          and(eq(orders.createdAt, cursor.createdAt), lt(orders.orderId, cursor.id)),
        )
      : undefined;
    const [rows, totalCount] = await Promise.all([
      this.db
        .select({
          orderId: orders.orderId,
          orderNumber: orders.orderNumber,
          buyerUserId: orders.userId,
          buyerUserid: users.userid,
          buyerEmail: users.email,
          status: orders.status,
          paymentStatus: orders.paymentStatus,
          totalAmount: orders.totalAmount,
          itemCount: sql<number>`(select coalesce(sum(${orderItems.quantity}), 0)::int from ${orderItems} where ${orderItems.orderId} = ${orders.orderId})`,
          createdAt: orders.createdAt,
        })
        .from(orders)
        .innerJoin(users, eq(orders.userId, users.userId))
        .where(and(...base, cursorCondition))
        .orderBy(desc(orders.createdAt), desc(orders.orderId))
        .limit(first + 1),
      this.count(orders, and(...base)),
    ]);
    const nodes = rows.map((row) => ({ ...row, allowedNextStatuses: getAllowedOrderTransitions(row.status) }));
    return this.toConnection(nodes, first, totalCount, (node) => node.orderId);
  };

  getOrder = async (orderId: string) => {
    const [order] = await this.db
      .select({
        orderId: orders.orderId,
        orderNumber: orders.orderNumber,
        buyerUserId: orders.userId,
        buyerUserid: users.userid,
        buyerEmail: users.email,
        status: orders.status,
        paymentStatus: orders.paymentStatus,
        paymentFailureReason: orders.paymentFailureReason,
        totalAmount: orders.totalAmount,
        itemCount: sql<number>`(select coalesce(sum(${orderItems.quantity}), 0)::int from ${orderItems} where ${orderItems.orderId} = ${orders.orderId})`,
        createdAt: orders.createdAt,
      })
      .from(orders)
      .innerJoin(users, eq(orders.userId, users.userId))
      .where(eq(orders.orderId, orderId))
      .limit(1);
    if (!order) throw new CustomNotFoundException(AdminErrorMessage.OrderNotFound);
    const [items, history] = await Promise.all([
      this.db.select().from(orderItems).where(eq(orderItems.orderId, orderId)).orderBy(asc(orderItems.createdAt)),
      this.entityAuditLogs("ORDER", orderId),
    ]);
    return { ...order, allowedNextStatuses: getAllowedOrderTransitions(order.status), items, auditLogs: history };
  };

  listCategories = () =>
    this.db
      .select()
      .from(categories)
      .orderBy(asc(categories.parentId), asc(categories.sortOrder), asc(categories.name));

  listInvites = async (filter: AdminInviteFilterInput) => {
    const first = pageSize(filter.first);
    const base = this.inviteConditions(filter);
    const cursor = filter.after ? decodeAdminCursor(filter.after) : undefined;
    const cursorCondition = cursor
      ? or(
          lt(adminInvites.createdAt, cursor.createdAt),
          and(eq(adminInvites.createdAt, cursor.createdAt), lt(adminInvites.inviteId, cursor.id)),
        )
      : undefined;
    const [rows, totalCount] = await Promise.all([
      this.db
        .select({
          inviteId: adminInvites.inviteId,
          email: adminInvites.email,
          invitedByUserId: adminInvites.invitedByUserId,
          invitedByUserid: users.userid,
          expiresAt: adminInvites.expiresAt,
          acceptedAt: adminInvites.acceptedAt,
          revokedAt: adminInvites.revokedAt,
          createdAt: adminInvites.createdAt,
        })
        .from(adminInvites)
        .innerJoin(users, eq(adminInvites.invitedByUserId, users.userId))
        .where(and(...base, cursorCondition))
        .orderBy(desc(adminInvites.createdAt), desc(adminInvites.inviteId))
        .limit(first + 1),
      this.count(adminInvites, and(...base)),
    ]);
    const nodes = rows.map((row) => ({ ...row, status: this.inviteStatus(row) }));
    return this.toConnection(nodes, first, totalCount, (node) => node.inviteId);
  };

  listAuditLogs = async (filter: AdminAuditLogFilterInput) => {
    const first = pageSize(filter.first);
    const base = this.auditConditions(filter);
    const cursor = filter.after ? decodeAdminCursor(filter.after) : undefined;
    const cursorCondition = cursor
      ? or(
          lt(auditLogs.createdAt, cursor.createdAt),
          and(eq(auditLogs.createdAt, cursor.createdAt), lt(auditLogs.auditLogId, cursor.id)),
        )
      : undefined;
    const [rows, totalCount] = await Promise.all([
      this.db
        .select({
          auditLogId: auditLogs.auditLogId,
          actorUserId: auditLogs.actorUserId,
          actorUserid: users.userid,
          action: auditLogs.action,
          entityType: auditLogs.entityType,
          entityId: auditLogs.entityId,
          metadata: auditLogs.metadata,
          createdAt: auditLogs.createdAt,
        })
        .from(auditLogs)
        .leftJoin(users, eq(auditLogs.actorUserId, users.userId))
        .where(and(...base, cursorCondition))
        .orderBy(desc(auditLogs.createdAt), desc(auditLogs.auditLogId))
        .limit(first + 1),
      this.count(auditLogs, and(...base)),
    ]);
    const nodes = rows.map(({ metadata, ...row }) => ({ ...row, metadataJson: JSON.stringify(metadata) }));
    return this.toConnection(nodes, first, totalCount, (node) => node.auditLogId);
  };

  reviewPartner = async (adminUserId: string, input: ReviewPartnerInput) => {
    const reason = rejectionReason(input.approved, input.rejectionReason);
    await this.db.transaction(async (tx) => {
      const [partner] = await tx
        .update(partners)
        .set({
          status: input.approved ? "APPROVED" : "REJECTED",
          rejectionReason: reason,
          reviewedByUserId: adminUserId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(partners.partnerId, input.partnerId), eq(partners.status, "PENDING")))
        .returning();
      if (!partner) return this.throwPartnerMutationError(input.partnerId);
      if (input.approved) {
        let brandId = partner.brandId;
        if (!brandId) {
          const brand = requireResult(
            (
              await tx
                .insert(brands)
                .values({ name: partner.tradeName, slug: `partner-${partner.partnerId}`, isActive: true })
                .onConflictDoUpdate({ target: brands.slug, set: { name: partner.tradeName, isActive: true } })
                .returning()
            )[0],
          );
          brandId = brand.brandId;
          await tx
            .update(partners)
            .set({ brandId })
            .where(and(eq(partners.partnerId, partner.partnerId), isNull(partners.brandId)));
        }
        await tx
          .update(users)
          .set({ role: "PARTNER", updatedAt: new Date() })
          .where(eq(users.userId, partner.ownerUserId));
      }
      await tx.insert(auditLogs).values({
        actorUserId: adminUserId,
        action: input.approved ? "PARTNER_APPROVED" : "PARTNER_REJECTED",
        entityType: "PARTNER",
        entityId: partner.partnerId,
        metadata: { previousStatus: "PENDING", nextStatus: partner.status, rejectionReason: reason },
      });
    });
    return this.getPartner(input.partnerId);
  };

  reviewProduct = async (adminUserId: string, input: ReviewProductInput) => {
    const reason = rejectionReason(input.approved, input.rejectionReason);
    await this.db.transaction(async (tx) => {
      const [product] = await tx
        .update(products)
        .set({
          approvalStatus: input.approved ? "APPROVED" : "REJECTED",
          rejectionReason: reason,
          updatedAt: new Date(),
        })
        .where(and(eq(products.productId, input.productId), eq(products.approvalStatus, "PENDING")))
        .returning();
      if (!product) return this.throwProductMutationError(input.productId);
      await tx.insert(auditLogs).values({
        actorUserId: adminUserId,
        action: input.approved ? "PRODUCT_APPROVED" : "PRODUCT_REJECTED",
        entityType: "PRODUCT",
        entityId: product.productId,
        metadata: { previousStatus: "PENDING", nextStatus: product.approvalStatus, rejectionReason: reason },
      });
    });
    return this.getProduct(input.productId);
  };

  transitionOrder = async (adminUserId: string, input: TransitionOrderInput) => {
    await this.db.transaction(async (tx) => {
      const [current] = await tx.select().from(orders).where(eq(orders.orderId, input.orderId)).limit(1);
      if (!current) throw new CustomNotFoundException(AdminErrorMessage.OrderNotFound);
      if (!isOrderStatus(input.nextStatus))
        throw new CustomBadRequestException(getCannotTransitionMessage(current.status, input.nextStatus));
      if (!isOrderStatus(current.status) || !isPaymentStatus(current.paymentStatus))
        throw new Error("Order has an invalid persisted state");
      const rule = getOrderTransitionRule(current.status, input.nextStatus);
      if (!rule) throw new CustomBadRequestException(getCannotTransitionMessage(current.status, input.nextStatus));
      if (current.paymentStatus !== rule.requiredPaymentStatus)
        throw new CustomConflictException(AdminErrorMessage.OrderChanged);
      const [updated] = await tx
        .update(orders)
        .set({
          status: input.nextStatus,
          paymentStatus: rule.paymentStatus,
          paymentFailureReason: rule.paymentFailureReason,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(orders.orderId, input.orderId),
            eq(orders.status, current.status),
            eq(orders.paymentStatus, current.paymentStatus),
          ),
        )
        .returning();
      if (!updated) throw new CustomConflictException(AdminErrorMessage.OrderChanged);
      await tx.insert(auditLogs).values({
        actorUserId: adminUserId,
        action: "ORDER_STATUS_CHANGED",
        entityType: "ORDER",
        entityId: updated.orderId,
        metadata: {
          previousStatus: current.status,
          nextStatus: updated.status,
          previousPaymentStatus: current.paymentStatus,
          nextPaymentStatus: updated.paymentStatus,
          paymentFailureReason: updated.paymentFailureReason,
        },
      });
    });
    return this.getOrder(input.orderId);
  };

  createCategory = async (adminUserId: string, input: CreateCategoryInput) => {
    const values = this.categoryValues(input);
    let categoryId = "";
    try {
      await this.db.transaction(async (tx) => {
        if (values.parentId) await this.assertCategoryExists(tx, values.parentId);
        const category = requireResult((await tx.insert(categories).values(values).returning())[0]);
        categoryId = category.categoryId;
        await tx.insert(auditLogs).values({
          actorUserId: adminUserId,
          action: "CATEGORY_CREATED",
          entityType: "CATEGORY",
          entityId: category.categoryId,
          metadata: { name: category.name, slug: category.slug, parentId: category.parentId },
        });
      });
    } catch (error) {
      if (isDatabaseError(error, "23505")) throw new CustomBadRequestException(AdminErrorMessage.DuplicateCategorySlug);
      throw error;
    }
    return this.getCategory(categoryId);
  };

  updateCategory = async (adminUserId: string, input: UpdateCategoryInput) => {
    try {
      await this.db.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(categories)
          .where(eq(categories.categoryId, input.categoryId))
          .limit(1);
        if (!current) throw new CustomNotFoundException(AdminErrorMessage.CategoryNotFound);
        const nextParentId = input.parentId === undefined ? current.parentId : input.parentId;
        if (nextParentId) {
          await this.assertCategoryExists(tx, nextParentId);
          await this.assertNoCategoryCycle(tx, input.categoryId, nextParentId);
        }
        if (input.isActive === false && current.isActive) await this.assertCategoryCanDeactivate(tx, input.categoryId);
        const values = this.categoryValues({
          name: input.name ?? current.name,
          slug: input.slug ?? current.slug,
          parentId: nextParentId ?? undefined,
          sortOrder: input.sortOrder ?? current.sortOrder,
          isActive: input.isActive ?? current.isActive,
        });
        const updated = requireResult(
          (
            await tx
              .update(categories)
              .set({ ...values, parentId: nextParentId, updatedAt: new Date() })
              .where(eq(categories.categoryId, input.categoryId))
              .returning()
          )[0],
        );
        await tx.insert(auditLogs).values({
          actorUserId: adminUserId,
          action: "CATEGORY_UPDATED",
          entityType: "CATEGORY",
          entityId: updated.categoryId,
          metadata: { before: current, after: updated },
        });
      });
    } catch (error) {
      if (isDatabaseError(error, "23505")) throw new CustomBadRequestException(AdminErrorMessage.DuplicateCategorySlug);
      throw error;
    }
    return this.getCategory(input.categoryId);
  };

  createInvite = async (adminUserId: string, input: CreateAdminInviteInput) => {
    const email = this.emailService.normalizeEmail(input.email);
    const token = randomBytes(32).toString("base64url");
    const [existingUser] = await this.db
      .select({ userId: users.userId })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    if (existingUser) throw new CustomBadRequestException(AdminErrorMessage.InviteEmailAlreadyRegistered);
    let inviteId = "";
    await this.db.transaction(async (tx) => {
      const invite = requireResult(
        (
          await tx
            .insert(adminInvites)
            .values({
              email,
              tokenHash: hashToken(token),
              invitedByUserId: adminUserId,
              expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
            })
            .onConflictDoUpdate({
              target: adminInvites.email,
              set: {
                tokenHash: hashToken(token),
                invitedByUserId: adminUserId,
                expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
                acceptedAt: null,
                acceptedByUserId: null,
                revokedAt: null,
                createdAt: new Date(),
              },
            })
            .returning()
        )[0],
      );
      inviteId = invite.inviteId;
      try {
        await this.emailService.sendAdminInvite(email, token);
      } catch {
        throw new CustomServiceUnavailableException(AdminErrorMessage.InviteEmailFailed);
      }
      await tx.insert(auditLogs).values({
        actorUserId: adminUserId,
        action: "ADMIN_INVITED",
        entityType: "ADMIN_INVITE",
        entityId: invite.inviteId,
        metadata: { email },
      });
    });
    return this.getInvite(inviteId);
  };

  revokeInvite = async (adminUserId: string, inviteId: string) => {
    await this.db.transaction(async (tx) => {
      const [invite] = await tx
        .update(adminInvites)
        .set({ revokedAt: new Date() })
        .where(
          and(eq(adminInvites.inviteId, inviteId), isNull(adminInvites.acceptedAt), isNull(adminInvites.revokedAt)),
        )
        .returning();
      if (!invite) {
        const [existing] = await tx
          .select({ inviteId: adminInvites.inviteId })
          .from(adminInvites)
          .where(eq(adminInvites.inviteId, inviteId))
          .limit(1);
        if (!existing) throw new CustomNotFoundException(AdminErrorMessage.InviteNotFound);
        throw new CustomConflictException(AdminErrorMessage.InviteChanged);
      }
      await tx.insert(auditLogs).values({
        actorUserId: adminUserId,
        action: "ADMIN_INVITE_REVOKED",
        entityType: "ADMIN_INVITE",
        entityId: invite.inviteId,
        metadata: { email: invite.email },
      });
    });
    return this.getInvite(inviteId);
  };

  acceptInvite = async (input: AcceptAdminInviteInput) => {
    const userid = this.emailService.normalizeUserid(input.userid);
    this.emailService.assertPassword(input.password);
    let inviteId = "";
    try {
      await this.db.transaction(async (tx) => {
        const now = new Date();
        const [invite] = await tx
          .select()
          .from(adminInvites)
          .where(
            and(
              eq(adminInvites.tokenHash, hashToken(input.token)),
              isNull(adminInvites.acceptedAt),
              isNull(adminInvites.revokedAt),
              gt(adminInvites.expiresAt, now),
            ),
          )
          .limit(1);
        if (!invite) throw new CustomBadRequestException(AdminErrorMessage.InvalidOrExpiredInvite);
        const [existingUser] = await tx
          .select({ userId: users.userId })
          .from(users)
          .where(eq(users.email, invite.email))
          .limit(1);
        if (existingUser) throw new CustomBadRequestException(AdminErrorMessage.InviteEmailAlreadyRegistered);
        const userId = randomUUID();
        await tx.insert(users).values({
          userId,
          userid,
          email: invite.email,
          password: await bcrypt.hash(input.password, 10),
          role: "ADMIN",
        });
        const [accepted] = await tx
          .update(adminInvites)
          .set({ acceptedByUserId: userId, acceptedAt: now })
          .where(
            and(
              eq(adminInvites.inviteId, invite.inviteId),
              isNull(adminInvites.acceptedAt),
              isNull(adminInvites.revokedAt),
              gt(adminInvites.expiresAt, now),
            ),
          )
          .returning();
        if (!accepted) throw new CustomConflictException(AdminErrorMessage.InviteChanged);
        inviteId = accepted.inviteId;
        await tx.insert(auditLogs).values({
          actorUserId: userId,
          action: "ADMIN_INVITE_ACCEPTED",
          entityType: "ADMIN_INVITE",
          entityId: accepted.inviteId,
          metadata: { email: accepted.email },
        });
      });
    } catch (error) {
      if (isDatabaseError(error, "23505")) throw new CustomBadRequestException("Userid is already in use");
      throw error;
    }
    return this.getInvite(inviteId);
  };

  private partnerConditions = (filter: AdminPartnerFilterInput) => {
    const conditions: SQL[] = [];
    if (filter.status) conditions.push(eq(partners.status, filter.status));
    if (filter.query?.trim()) {
      const query = `%${filter.query.trim()}%`;
      conditions.push(
        or(
          ilike(partners.tradeName, query),
          ilike(partners.businessEmail, query),
          ilike(partners.businessRegistrationNumber, query),
          sql`exists (
            select 1 from ${users}
            where ${users.userId} = ${partners.ownerUserId}
              and (${users.userid} ilike ${query} or ${users.email} ilike ${query})
          )`,
        )!,
      );
    }
    const from = parseDate(filter.createdFrom);
    const to = parseDate(filter.createdTo, true);
    if (from) conditions.push(gte(partners.createdAt, from));
    if (to) conditions.push(lte(partners.createdAt, to));
    return conditions;
  };

  private productConditions = (filter: AdminProductFilterInput) => {
    const conditions: SQL[] = [sql`not (${products.status} = 'DRAFT' and ${products.approvalStatus} = 'DRAFT')`];
    if (filter.approvalStatus) conditions.push(eq(products.approvalStatus, filter.approvalStatus));
    if (filter.partnerId) conditions.push(eq(products.partnerId, filter.partnerId));
    if (filter.categoryId) conditions.push(eq(products.categoryId, filter.categoryId));
    if (filter.query?.trim()) conditions.push(ilike(products.title, `%${filter.query.trim()}%`));
    const from = parseDate(filter.createdFrom);
    const to = parseDate(filter.createdTo, true);
    if (from) conditions.push(gte(products.createdAt, from));
    if (to) conditions.push(lte(products.createdAt, to));
    return conditions;
  };

  private orderConditions = (filter: AdminOrderFilterInput) => {
    const conditions: SQL[] = [];
    if (filter.status) conditions.push(eq(orders.status, filter.status));
    if (filter.query?.trim()) {
      const query = `%${filter.query.trim()}%`;
      conditions.push(
        or(
          ilike(orders.orderNumber, query),
          sql`exists (
            select 1 from ${users}
            where ${users.userId} = ${orders.userId}
              and (${users.userid} ilike ${query} or ${users.email} ilike ${query})
          )`,
        )!,
      );
    }
    const from = parseDate(filter.createdFrom);
    const to = parseDate(filter.createdTo, true);
    if (from) conditions.push(gte(orders.createdAt, from));
    if (to) conditions.push(lte(orders.createdAt, to));
    return conditions;
  };

  private inviteConditions = (filter: AdminInviteFilterInput) => {
    const conditions: SQL[] = [];
    if (filter.query?.trim()) conditions.push(ilike(adminInvites.email, `%${filter.query.trim()}%`));
    const now = new Date();
    if (filter.status === "PENDING")
      conditions.push(
        and(isNull(adminInvites.acceptedAt), isNull(adminInvites.revokedAt), gt(adminInvites.expiresAt, now))!,
      );
    if (filter.status === "ACCEPTED") conditions.push(isNotNull(adminInvites.acceptedAt));
    if (filter.status === "REVOKED") conditions.push(isNotNull(adminInvites.revokedAt));
    if (filter.status === "EXPIRED")
      conditions.push(
        and(isNull(adminInvites.acceptedAt), isNull(adminInvites.revokedAt), lte(adminInvites.expiresAt, now))!,
      );
    return conditions;
  };

  private auditConditions = (filter: AdminAuditLogFilterInput) => {
    const conditions: SQL[] = [];
    if (filter.actorUserId) conditions.push(eq(auditLogs.actorUserId, filter.actorUserId));
    if (filter.action) conditions.push(eq(auditLogs.action, filter.action));
    if (filter.entityType) conditions.push(eq(auditLogs.entityType, filter.entityType));
    const from = parseDate(filter.createdFrom);
    const to = parseDate(filter.createdTo, true);
    if (from) conditions.push(gte(auditLogs.createdAt, from));
    if (to) conditions.push(lte(auditLogs.createdAt, to));
    return conditions;
  };

  private entityAuditLogs = async (entityType: string, entityId: string) => {
    const rows = await this.db
      .select({
        auditLogId: auditLogs.auditLogId,
        actorUserId: auditLogs.actorUserId,
        actorUserid: users.userid,
        action: auditLogs.action,
        entityType: auditLogs.entityType,
        entityId: auditLogs.entityId,
        metadata: auditLogs.metadata,
        createdAt: auditLogs.createdAt,
      })
      .from(auditLogs)
      .leftJoin(users, eq(auditLogs.actorUserId, users.userId))
      .where(and(eq(auditLogs.entityType, entityType), eq(auditLogs.entityId, entityId)))
      .orderBy(desc(auditLogs.createdAt))
      .limit(30);
    return rows.map(({ metadata, ...row }) => ({ ...row, metadataJson: JSON.stringify(metadata) }));
  };

  private getInvite = async (inviteId: string) => {
    const [row] = await this.db
      .select({
        inviteId: adminInvites.inviteId,
        email: adminInvites.email,
        invitedByUserId: adminInvites.invitedByUserId,
        invitedByUserid: users.userid,
        expiresAt: adminInvites.expiresAt,
        acceptedAt: adminInvites.acceptedAt,
        revokedAt: adminInvites.revokedAt,
        createdAt: adminInvites.createdAt,
      })
      .from(adminInvites)
      .innerJoin(users, eq(adminInvites.invitedByUserId, users.userId))
      .where(eq(adminInvites.inviteId, inviteId))
      .limit(1);
    if (!row) throw new CustomNotFoundException(AdminErrorMessage.InviteNotFound);
    return { ...row, status: this.inviteStatus(row) };
  };

  private getCategory = async (categoryId: string) => {
    const [category] = await this.db.select().from(categories).where(eq(categories.categoryId, categoryId)).limit(1);
    if (!category) throw new CustomNotFoundException(AdminErrorMessage.CategoryNotFound);
    return category;
  };

  private categoryValues = (input: CreateCategoryInput) => {
    const name = input.name.trim();
    const slug = input.slug.trim().toLowerCase();
    if (!name || name.length > 100 || slug.length > 120 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))
      throw new CustomBadRequestException(AdminErrorMessage.InvalidCategory);
    if ((input.sortOrder ?? 0) < 0) throw new CustomBadRequestException(AdminErrorMessage.InvalidCategory);
    return {
      name,
      slug,
      parentId: input.parentId ?? null,
      sortOrder: input.sortOrder ?? 0,
      isActive: input.isActive ?? true,
    };
  };

  private assertCategoryExists = async (tx: Pick<Database, "select">, categoryId: string) => {
    const [category] = await tx
      .select({ categoryId: categories.categoryId })
      .from(categories)
      .where(eq(categories.categoryId, categoryId))
      .limit(1);
    if (!category) throw new CustomBadRequestException(AdminErrorMessage.CategoryNotFound);
  };

  private assertNoCategoryCycle = async (tx: Pick<Database, "select">, categoryId: string, parentId: string) => {
    let currentId: string | null = parentId;
    const visited = new Set<string>();
    while (currentId) {
      if (currentId === categoryId || visited.has(currentId))
        throw new CustomBadRequestException(AdminErrorMessage.CategoryCycle);
      visited.add(currentId);
      const [parent] = await tx
        .select({ parentId: categories.parentId })
        .from(categories)
        .where(eq(categories.categoryId, currentId))
        .limit(1);
      currentId = parent?.parentId ?? null;
    }
  };

  private assertCategoryCanDeactivate = async (tx: Pick<Database, "select">, categoryId: string) => {
    const [child] = await tx
      .select({ categoryId: categories.categoryId })
      .from(categories)
      .where(and(eq(categories.parentId, categoryId), eq(categories.isActive, true)))
      .limit(1);
    if (child) throw new CustomBadRequestException(AdminErrorMessage.CategoryHasActiveChildren);
    const [product] = await tx
      .select({ productId: products.productId })
      .from(products)
      .where(and(eq(products.categoryId, categoryId), eq(products.status, "PUBLISHED")))
      .limit(1);
    if (product) throw new CustomBadRequestException(AdminErrorMessage.CategoryHasPublicProducts);
  };

  private throwPartnerMutationError = async (partnerId: string): Promise<never> => {
    const [partner] = await this.db
      .select({ partnerId: partners.partnerId })
      .from(partners)
      .where(eq(partners.partnerId, partnerId))
      .limit(1);
    if (!partner) throw new CustomNotFoundException(AdminErrorMessage.PartnerNotFound);
    throw new CustomConflictException(AdminErrorMessage.AlreadyReviewed);
  };

  private throwProductMutationError = async (productId: string): Promise<never> => {
    const [product] = await this.db
      .select({ productId: products.productId })
      .from(products)
      .where(eq(products.productId, productId))
      .limit(1);
    if (!product) throw new CustomNotFoundException(AdminErrorMessage.ProductNotFound);
    throw new CustomConflictException(AdminErrorMessage.AlreadyReviewed);
  };

  private inviteStatus = (invite: { acceptedAt: Date | null; revokedAt: Date | null; expiresAt: Date }) => {
    if (invite.acceptedAt) return "ACCEPTED";
    if (invite.revokedAt) return "REVOKED";
    if (invite.expiresAt.getTime() <= Date.now()) return "EXPIRED";
    return "PENDING";
  };

  private toConnection = <T extends { createdAt: Date }>(
    rows: T[],
    first: number,
    totalCount: number,
    id: (node: T) => string,
  ) => {
    const nodes = rows.slice(0, first);
    const hasNextPage = rows.length > first;
    const tail = nodes[nodes.length - 1];
    return {
      nodes,
      nextCursor:
        hasNextPage && tail ? encodeAdminCursor({ createdAt: tail.createdAt.toISOString(), id: id(tail) }) : null,
      hasNextPage,
      totalCount,
    };
  };

  private count = async (
    table: typeof partners | typeof products | typeof orders | typeof adminInvites | typeof auditLogs,
    condition?: SQL,
  ) => {
    const rows = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(table)
      .where(condition);
    return Number(rows[0]?.count ?? 0);
  };
}
