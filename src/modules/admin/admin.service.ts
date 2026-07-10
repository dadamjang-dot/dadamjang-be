import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gt, isNull } from "drizzle-orm";
import { randomUUID } from "crypto";
import * as bcrypt from "bcrypt";
import { hashToken } from "src/common/security/token-hash";
import { CatalogService } from "src/modules/catalog/catalog.service";
import { OrderService } from "src/modules/order/order.service";
import { CustomBadRequestException, CustomNotFoundException } from "src/common/errors/custom-exceptions";
import { Database, DRIZZLE } from "src/modules/database/database.module";
import { adminInvites, auditLogs, partners, users } from "src/modules/database/schema";
import { CreateAdminInviteInput, ReviewPartnerInput, ReviewProductInput, TransitionOrderInput } from "./admin.types";

@Injectable()
export class AdminService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly catalogService: CatalogService,
    private readonly orderService: OrderService,
  ) {}

  listPendingPartners = () => this.db.select().from(partners).where(eq(partners.status, "PENDING"));

  reviewPartner = async (adminUserId: string, input: ReviewPartnerInput) =>
    this.db.transaction(async (tx) => {
      const [partner] = await tx
        .update(partners)
        .set({
          status: input.approved ? "APPROVED" : "REJECTED",
          rejectionReason: input.approved ? null : (input.rejectionReason ?? "Rejected by administrator"),
          reviewedByUserId: adminUserId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(partners.partnerId, input.partnerId))
        .returning();
      if (!partner) throw new CustomNotFoundException("Partner not found");
      if (input.approved)
        await tx
          .update(users)
          .set({ role: "PARTNER", updatedAt: new Date() })
          .where(eq(users.userId, partner.ownerUserId));
      await tx.insert(auditLogs).values({
        actorUserId: adminUserId,
        action: input.approved ? "PARTNER_APPROVED" : "PARTNER_REJECTED",
        entityType: "PARTNER",
        entityId: partner.partnerId,
        metadata: { rejectionReason: input.rejectionReason ?? null },
      });
      return partner;
    });

  reviewProduct = async (adminUserId: string, input: ReviewProductInput) => {
    const product = await this.catalogService.approveProduct(input.productId, input.approved, input.rejectionReason);
    await this.db.insert(auditLogs).values({
      actorUserId: adminUserId,
      action: input.approved ? "PRODUCT_APPROVED" : "PRODUCT_REJECTED",
      entityType: "PRODUCT",
      entityId: input.productId,
      metadata: { rejectionReason: input.rejectionReason ?? null },
    });
    return product;
  };
  transitionOrder = async (adminUserId: string, input: TransitionOrderInput) => {
    const order = await this.orderService.transitionOrder(input.orderId, input.nextStatus);
    await this.db.insert(auditLogs).values({
      actorUserId: adminUserId,
      action: "ORDER_STATUS_CHANGED",
      entityType: "ORDER",
      entityId: order.orderId,
      metadata: { nextStatus: input.nextStatus },
    });
    return order;
  };

  createInvite = async (adminUserId: string, input: CreateAdminInviteInput) => {
    const token = randomUUID();
    const [invite] = await this.db
      .insert(adminInvites)
      .values({
        email: input.email.toLowerCase(),
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
        },
      })
      .returning();
    await this.db.insert(auditLogs).values({
      actorUserId: adminUserId,
      action: "ADMIN_INVITED",
      entityType: "ADMIN_INVITE",
      entityId: invite.inviteId,
      metadata: { email: invite.email },
    });
    return { ...invite, token };
  };

  acceptInvite = async (input: { token: string; userid: string; password: string }) =>
    this.db.transaction(async (tx) => {
      const [invite] = await tx
        .select()
        .from(adminInvites)
        .where(
          and(
            eq(adminInvites.tokenHash, hashToken(input.token)),
            isNull(adminInvites.acceptedAt),
            gt(adminInvites.expiresAt, new Date()),
          ),
        )
        .limit(1);
      if (!invite) throw new CustomBadRequestException("Invalid or expired admin invite");
      const [existingUser] = await tx.select().from(users).where(eq(users.email, invite.email.toLowerCase())).limit(1);
      const userId = existingUser?.userId ?? randomUUID();
      if (existingUser) {
        await tx.update(users).set({ role: "ADMIN", updatedAt: new Date() }).where(eq(users.userId, userId));
      } else {
        await tx.insert(users).values({
          userId,
          userid: input.userid.toLowerCase(),
          email: invite.email.toLowerCase(),
          password: await bcrypt.hash(input.password, 10),
          role: "ADMIN",
        });
      }
      const [acceptedInvite] = await tx
        .update(adminInvites)
        .set({ acceptedByUserId: userId, acceptedAt: new Date() })
        .where(eq(adminInvites.inviteId, invite.inviteId))
        .returning();
      if (!acceptedInvite) throw new CustomBadRequestException("Invalid or expired admin invite");
      return { ...invite, token: null };
    });
}
