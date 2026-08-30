import { UseGuards } from "@nestjs/common";
import { Args, Context, Mutation, Query, Resolver } from "@nestjs/graphql";
import { UserRole } from "src/auth/role";
import { Roles } from "src/auth/roles.decorator";
import { CustomUnauthorizedException } from "src/common/errors/custom-exceptions";
import { JwtAccessTokenGuard } from "src/guards/access-token.guard";
import { RolesGuard } from "src/guards/roles.guard";
import { CreateCategoryInput } from "src/modules/catalog/catalog.types";
import { AdminErrorMessage } from "./admin.error";
import { AdminService } from "./admin.service";
import {
  AcceptAdminInviteInput,
  AdminAuditLogConnectionType,
  AdminAuditLogFilterInput,
  AdminCategoryType,
  AdminDashboardType,
  AdminInviteConnectionType,
  AdminInviteFilterInput,
  AdminInviteType,
  AdminOrderConnectionType,
  AdminOrderDetailType,
  AdminOrderFilterInput,
  AdminPartnerConnectionType,
  AdminPartnerDetailType,
  AdminPartnerFilterInput,
  AdminProductConnectionType,
  AdminProductDetailType,
  AdminProductFilterInput,
  CreateAdminInviteInput,
  RevokeAdminInviteInput,
  ReviewPartnerInput,
  ReviewProductInput,
  TransitionOrderInput,
  UpdateCategoryInput,
} from "./admin.types";

const currentUserId = (context: { req?: { user?: { userId?: string } } }) => {
  const userId = context.req?.user?.userId;
  if (!userId) throw new CustomUnauthorizedException(AdminErrorMessage.AuthenticationRequired);
  return userId;
};

@Resolver()
export class AdminResolver {
  constructor(private readonly adminService: AdminService) {}

  @Query(() => AdminDashboardType)
  @UseGuards(JwtAccessTokenGuard, RolesGuard)
  @Roles(UserRole.Admin)
  adminDashboard() {
    return this.adminService.getDashboard();
  }

  @Query(() => AdminPartnerConnectionType)
  @UseGuards(JwtAccessTokenGuard, RolesGuard)
  @Roles(UserRole.Admin)
  adminPartners(
    @Args("filter", { type: () => AdminPartnerFilterInput, nullable: true }) filter?: AdminPartnerFilterInput,
  ) {
    return this.adminService.listPartners(filter ?? { status: "PENDING" });
  }

  @Query(() => AdminPartnerDetailType)
  @UseGuards(JwtAccessTokenGuard, RolesGuard)
  @Roles(UserRole.Admin)
  adminPartner(@Args("partnerId") partnerId: string) {
    return this.adminService.getPartner(partnerId);
  }

  @Query(() => AdminProductConnectionType)
  @UseGuards(JwtAccessTokenGuard, RolesGuard)
  @Roles(UserRole.Admin)
  adminProducts(
    @Args("filter", { type: () => AdminProductFilterInput, nullable: true }) filter?: AdminProductFilterInput,
  ) {
    return this.adminService.listProducts(filter ?? {});
  }

  @Query(() => AdminProductDetailType)
  @UseGuards(JwtAccessTokenGuard, RolesGuard)
  @Roles(UserRole.Admin)
  adminProduct(@Args("productId") productId: string) {
    return this.adminService.getProduct(productId);
  }

  @Query(() => AdminOrderConnectionType)
  @UseGuards(JwtAccessTokenGuard, RolesGuard)
  @Roles(UserRole.Admin)
  adminOrders(@Args("filter", { type: () => AdminOrderFilterInput, nullable: true }) filter?: AdminOrderFilterInput) {
    return this.adminService.listOrders(filter ?? {});
  }

  @Query(() => AdminOrderDetailType)
  @UseGuards(JwtAccessTokenGuard, RolesGuard)
  @Roles(UserRole.Admin)
  adminOrder(@Args("orderId") orderId: string) {
    return this.adminService.getOrder(orderId);
  }

  @Query(() => [AdminCategoryType])
  @UseGuards(JwtAccessTokenGuard, RolesGuard)
  @Roles(UserRole.Admin)
  adminCategories() {
    return this.adminService.listCategories();
  }

  @Query(() => AdminInviteConnectionType)
  @UseGuards(JwtAccessTokenGuard, RolesGuard)
  @Roles(UserRole.Admin)
  adminInvites(
    @Args("filter", { type: () => AdminInviteFilterInput, nullable: true }) filter?: AdminInviteFilterInput,
  ) {
    return this.adminService.listInvites(filter ?? {});
  }

  @Query(() => AdminAuditLogConnectionType)
  @UseGuards(JwtAccessTokenGuard, RolesGuard)
  @Roles(UserRole.Admin)
  adminAuditLogs(
    @Args("filter", { type: () => AdminAuditLogFilterInput, nullable: true }) filter?: AdminAuditLogFilterInput,
  ) {
    return this.adminService.listAuditLogs(filter ?? {});
  }

  @Mutation(() => AdminPartnerDetailType)
  @UseGuards(JwtAccessTokenGuard, RolesGuard)
  @Roles(UserRole.Admin)
  reviewPartner(
    @Args("input") input: ReviewPartnerInput,
    @Context() context: { req?: { user?: { userId?: string } } },
  ) {
    return this.adminService.reviewPartner(currentUserId(context), input);
  }

  @Mutation(() => AdminProductDetailType)
  @UseGuards(JwtAccessTokenGuard, RolesGuard)
  @Roles(UserRole.Admin)
  reviewProduct(
    @Args("input") input: ReviewProductInput,
    @Context() context: { req?: { user?: { userId?: string } } },
  ) {
    return this.adminService.reviewProduct(currentUserId(context), input);
  }

  @Mutation(() => AdminOrderDetailType)
  @UseGuards(JwtAccessTokenGuard, RolesGuard)
  @Roles(UserRole.Admin)
  transitionOrder(
    @Args("input") input: TransitionOrderInput,
    @Context() context: { req?: { user?: { userId?: string } } },
  ) {
    return this.adminService.transitionOrder(currentUserId(context), input);
  }

  @Mutation(() => AdminCategoryType)
  @UseGuards(JwtAccessTokenGuard, RolesGuard)
  @Roles(UserRole.Admin)
  createCategory(
    @Args("input") input: CreateCategoryInput,
    @Context() context: { req?: { user?: { userId?: string } } },
  ) {
    return this.adminService.createCategory(currentUserId(context), input);
  }

  @Mutation(() => AdminCategoryType)
  @UseGuards(JwtAccessTokenGuard, RolesGuard)
  @Roles(UserRole.Admin)
  updateCategory(
    @Args("input") input: UpdateCategoryInput,
    @Context() context: { req?: { user?: { userId?: string } } },
  ) {
    return this.adminService.updateCategory(currentUserId(context), input);
  }

  @Mutation(() => AdminInviteType)
  @UseGuards(JwtAccessTokenGuard, RolesGuard)
  @Roles(UserRole.Admin)
  createAdminInvite(
    @Args("input") input: CreateAdminInviteInput,
    @Context() context: { req?: { user?: { userId?: string } } },
  ) {
    return this.adminService.createInvite(currentUserId(context), input);
  }

  @Mutation(() => AdminInviteType)
  @UseGuards(JwtAccessTokenGuard, RolesGuard)
  @Roles(UserRole.Admin)
  revokeAdminInvite(
    @Args("input") input: RevokeAdminInviteInput,
    @Context() context: { req?: { user?: { userId?: string } } },
  ) {
    return this.adminService.revokeInvite(currentUserId(context), input.inviteId);
  }

  @Mutation(() => AdminInviteType)
  acceptAdminInvite(@Args("input") input: AcceptAdminInviteInput) {
    return this.adminService.acceptInvite(input);
  }
}
