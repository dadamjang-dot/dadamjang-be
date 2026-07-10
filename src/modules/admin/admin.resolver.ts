import { Args, Context, Mutation, Query, Resolver } from "@nestjs/graphql";
import { UseGuards } from "@nestjs/common";
import { UserRole } from "src/auth/role";
import { Roles } from "src/auth/roles.decorator";
import { ProductType } from "src/modules/catalog/catalog.types";
import { CustomUnauthorizedException } from "src/common/errors/custom-exceptions";
import { JwtAccessTokenGuard } from "src/guards/accessToken.guard";
import { RolesGuard } from "src/guards/roles.guard";
import { AdminService } from "./admin.service";
import {
  AcceptAdminInviteInput,
  AdminInviteType,
  CreateAdminInviteInput,
  PartnerReviewType,
  ReviewPartnerInput,
  ReviewProductInput,
  TransitionOrderInput,
} from "./admin.types";
import { OrderType } from "src/modules/order/order.types";

const currentUserId = (context: { req?: { user?: { userId?: string } } }) => {
  const userId = context.req?.user?.userId;
  if (!userId) throw new CustomUnauthorizedException("Authentication required");
  return userId;
};

@Resolver()
export class AdminResolver {
  constructor(private readonly adminService: AdminService) {}
  @Query(() => [PartnerReviewType])
  @UseGuards(JwtAccessTokenGuard, RolesGuard)
  @Roles(UserRole.Admin)
  pendingPartners() {
    return this.adminService.listPendingPartners();
  }
  @Mutation(() => PartnerReviewType)
  @UseGuards(JwtAccessTokenGuard, RolesGuard)
  @Roles(UserRole.Admin)
  reviewPartner(
    @Args("input") input: ReviewPartnerInput,
    @Context() context: { req?: { user?: { userId?: string } } },
  ) {
    return this.adminService.reviewPartner(currentUserId(context), input);
  }
  @Mutation(() => ProductType)
  @UseGuards(JwtAccessTokenGuard, RolesGuard)
  @Roles(UserRole.Admin)
  reviewProduct(
    @Args("input") input: ReviewProductInput,
    @Context() context: { req?: { user?: { userId?: string } } },
  ) {
    return this.adminService.reviewProduct(currentUserId(context), input);
  }
  @Mutation(() => OrderType)
  @UseGuards(JwtAccessTokenGuard, RolesGuard)
  @Roles(UserRole.Admin)
  transitionOrder(
    @Args("input") input: TransitionOrderInput,
    @Context() context: { req?: { user?: { userId?: string } } },
  ) {
    return this.adminService.transitionOrder(currentUserId(context), input);
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
  acceptAdminInvite(@Args("input") input: AcceptAdminInviteInput) {
    return this.adminService.acceptInvite(input);
  }
}
