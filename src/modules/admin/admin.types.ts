import { Field, InputType, Int, ObjectType } from "@nestjs/graphql";
import type { OrderStatus, PaymentStatus } from "src/modules/order/order.constant";

@InputType()
export class ReviewPartnerInput {
  @Field()
  partnerId!: string;
  @Field()
  approved!: boolean;
  @Field(() => String, { nullable: true })
  rejectionReason?: string;
}

@InputType()
export class ReviewProductInput {
  @Field()
  productId!: string;
  @Field()
  approved!: boolean;
  @Field(() => String, { nullable: true })
  rejectionReason?: string;
}

@InputType()
export class TransitionOrderInput {
  @Field()
  orderId!: string;
  @Field()
  nextStatus!: OrderStatus;
}

@InputType()
export class CreateAdminInviteInput {
  @Field()
  email!: string;
}

@InputType()
export class RevokeAdminInviteInput {
  @Field()
  inviteId!: string;
}

@InputType()
export class AcceptAdminInviteInput {
  @Field()
  token!: string;
  @Field()
  userid!: string;
  @Field()
  password!: string;
}

@InputType()
export class AdminPartnerFilterInput {
  @Field(() => String, { nullable: true })
  query?: string;
  @Field(() => String, { nullable: true })
  status?: string;
  @Field(() => String, { nullable: true })
  createdFrom?: string;
  @Field(() => String, { nullable: true })
  createdTo?: string;
  @Field(() => String, { nullable: true })
  after?: string;
  @Field(() => Int, { nullable: true })
  first?: number;
}

@InputType()
export class AdminProductFilterInput {
  @Field(() => String, { nullable: true })
  query?: string;
  @Field(() => String, { nullable: true })
  approvalStatus?: string;
  @Field(() => String, { nullable: true })
  partnerId?: string;
  @Field(() => String, { nullable: true })
  categoryId?: string;
  @Field(() => String, { nullable: true })
  createdFrom?: string;
  @Field(() => String, { nullable: true })
  createdTo?: string;
  @Field(() => String, { nullable: true })
  after?: string;
  @Field(() => Int, { nullable: true })
  first?: number;
}

@InputType()
export class AdminOrderFilterInput {
  @Field(() => String, { nullable: true })
  query?: string;
  @Field(() => String, { nullable: true })
  status?: string;
  @Field(() => String, { nullable: true })
  createdFrom?: string;
  @Field(() => String, { nullable: true })
  createdTo?: string;
  @Field(() => String, { nullable: true })
  after?: string;
  @Field(() => Int, { nullable: true })
  first?: number;
}

@InputType()
export class AdminInviteFilterInput {
  @Field(() => String, { nullable: true })
  query?: string;
  @Field(() => String, { nullable: true })
  status?: string;
  @Field(() => String, { nullable: true })
  after?: string;
  @Field(() => Int, { nullable: true })
  first?: number;
}

@InputType()
export class AdminAuditLogFilterInput {
  @Field(() => String, { nullable: true })
  actorUserId?: string;
  @Field(() => String, { nullable: true })
  action?: string;
  @Field(() => String, { nullable: true })
  entityType?: string;
  @Field(() => String, { nullable: true })
  createdFrom?: string;
  @Field(() => String, { nullable: true })
  createdTo?: string;
  @Field(() => String, { nullable: true })
  after?: string;
  @Field(() => Int, { nullable: true })
  first?: number;
}

@InputType()
export class UpdateCategoryInput {
  @Field()
  categoryId!: string;
  @Field(() => String, { nullable: true })
  name?: string;
  @Field(() => String, { nullable: true })
  slug?: string;
  @Field(() => String, { nullable: true })
  parentId?: string | null;
  @Field(() => Int, { nullable: true })
  sortOrder?: number;
  @Field(() => Boolean, { nullable: true })
  isActive?: boolean;
}

@ObjectType()
export class AdminAuditLogType {
  @Field()
  auditLogId!: string;
  @Field(() => String, { nullable: true })
  actorUserId!: string | null;
  @Field(() => String, { nullable: true })
  actorUserid!: string | null;
  @Field()
  action!: string;
  @Field()
  entityType!: string;
  @Field()
  entityId!: string;
  @Field()
  metadataJson!: string;
  @Field()
  createdAt!: Date;
}

@ObjectType()
export class AdminAuditLogConnectionType {
  @Field(() => [AdminAuditLogType])
  nodes!: AdminAuditLogType[];
  @Field(() => String, { nullable: true })
  nextCursor!: string | null;
  @Field()
  hasNextPage!: boolean;
  @Field(() => Int)
  totalCount!: number;
}

@ObjectType()
export class AdminPartnerSummaryType {
  @Field()
  partnerId!: string;
  @Field()
  ownerUserId!: string;
  @Field()
  ownerUserid!: string;
  @Field()
  ownerEmail!: string;
  @Field()
  businessEmail!: string;
  @Field()
  businessRegistrationNumber!: string;
  @Field()
  tradeName!: string;
  @Field()
  status!: string;
  @Field(() => String, { nullable: true })
  rejectionReason!: string | null;
  @Field(() => Date, { nullable: true })
  reviewedAt!: Date | null;
  @Field()
  createdAt!: Date;
}

@ObjectType()
export class AdminPartnerDetailType extends AdminPartnerSummaryType {
  @Field(() => [AdminAuditLogType])
  auditLogs!: AdminAuditLogType[];
}

@ObjectType()
export class AdminPartnerConnectionType {
  @Field(() => [AdminPartnerSummaryType])
  nodes!: AdminPartnerSummaryType[];
  @Field(() => String, { nullable: true })
  nextCursor!: string | null;
  @Field()
  hasNextPage!: boolean;
  @Field(() => Int)
  totalCount!: number;
}

@ObjectType()
export class AdminProductSummaryType {
  @Field()
  productId!: string;
  @Field()
  partnerId!: string;
  @Field()
  partnerName!: string;
  @Field()
  categoryId!: string;
  @Field()
  categoryName!: string;
  @Field()
  title!: string;
  @Field()
  status!: string;
  @Field()
  approvalStatus!: string;
  @Field(() => String, { nullable: true })
  rejectionReason!: string | null;
  @Field(() => String, { nullable: true })
  thumbnailUrl!: string | null;
  @Field()
  createdAt!: Date;
}

@ObjectType()
export class AdminProductSkuType {
  @Field()
  skuId!: string;
  @Field()
  code!: string;
  @Field()
  optionName!: string;
  @Field(() => Int)
  price!: number;
  @Field(() => Int)
  stock!: number;
  @Field()
  isActive!: boolean;
}

@ObjectType()
export class AdminProductDetailType extends AdminProductSummaryType {
  @Field()
  description!: string;
  @Field(() => [String])
  imageUrls!: string[];
  @Field(() => [AdminProductSkuType])
  skus!: AdminProductSkuType[];
  @Field(() => [AdminAuditLogType])
  auditLogs!: AdminAuditLogType[];
}

@ObjectType()
export class AdminProductConnectionType {
  @Field(() => [AdminProductSummaryType])
  nodes!: AdminProductSummaryType[];
  @Field(() => String, { nullable: true })
  nextCursor!: string | null;
  @Field()
  hasNextPage!: boolean;
  @Field(() => Int)
  totalCount!: number;
}

@ObjectType()
export class AdminOrderSummaryType {
  @Field()
  orderId!: string;
  @Field()
  orderNumber!: string;
  @Field()
  buyerUserId!: string;
  @Field()
  buyerUserid!: string;
  @Field()
  buyerEmail!: string;
  @Field()
  status!: OrderStatus;
  @Field()
  paymentStatus!: PaymentStatus;
  @Field(() => Int)
  totalAmount!: number;
  @Field(() => Int)
  itemCount!: number;
  @Field(() => [String])
  allowedNextStatuses!: OrderStatus[];
  @Field()
  createdAt!: Date;
}

@ObjectType()
export class AdminOrderItemType {
  @Field()
  orderItemId!: string;
  @Field()
  productId!: string;
  @Field()
  skuId!: string;
  @Field()
  productTitle!: string;
  @Field()
  skuOptionName!: string;
  @Field(() => Int)
  unitPrice!: number;
  @Field(() => Int)
  quantity!: number;
}

@ObjectType()
export class AdminOrderDetailType extends AdminOrderSummaryType {
  @Field(() => String, { nullable: true })
  paymentFailureReason!: string | null;
  @Field(() => [AdminOrderItemType])
  items!: AdminOrderItemType[];
  @Field(() => [AdminAuditLogType])
  auditLogs!: AdminAuditLogType[];
}

@ObjectType()
export class AdminOrderConnectionType {
  @Field(() => [AdminOrderSummaryType])
  nodes!: AdminOrderSummaryType[];
  @Field(() => String, { nullable: true })
  nextCursor!: string | null;
  @Field()
  hasNextPage!: boolean;
  @Field(() => Int)
  totalCount!: number;
}

@ObjectType()
export class AdminCategoryType {
  @Field()
  categoryId!: string;
  @Field()
  name!: string;
  @Field()
  slug!: string;
  @Field(() => String, { nullable: true })
  parentId!: string | null;
  @Field(() => Int)
  sortOrder!: number;
  @Field()
  isActive!: boolean;
  @Field()
  createdAt!: Date;
  @Field()
  updatedAt!: Date;
}

@ObjectType()
export class AdminInviteType {
  @Field()
  inviteId!: string;
  @Field()
  email!: string;
  @Field()
  status!: string;
  @Field()
  invitedByUserId!: string;
  @Field()
  invitedByUserid!: string;
  @Field()
  expiresAt!: Date;
  @Field(() => Date, { nullable: true })
  acceptedAt!: Date | null;
  @Field(() => Date, { nullable: true })
  revokedAt!: Date | null;
  @Field()
  createdAt!: Date;
}

@ObjectType()
export class AdminInviteConnectionType {
  @Field(() => [AdminInviteType])
  nodes!: AdminInviteType[];
  @Field(() => String, { nullable: true })
  nextCursor!: string | null;
  @Field()
  hasNextPage!: boolean;
  @Field(() => Int)
  totalCount!: number;
}

@ObjectType()
export class AdminDashboardType {
  @Field(() => Int)
  pendingPartnerCount!: number;
  @Field(() => Int)
  pendingProductCount!: number;
  @Field(() => Int)
  processingOrderCount!: number;
  @Field(() => Int)
  activeInviteCount!: number;
  @Field(() => [AdminAuditLogType])
  recentAuditLogs!: AdminAuditLogType[];
}
