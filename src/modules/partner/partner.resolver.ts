import { UseGuards } from "@nestjs/common";
import { Args, Context, Mutation, Query, Resolver } from "@nestjs/graphql";
import { UserRole } from "src/auth/role";
import { Roles } from "src/auth/roles.decorator";
import { CustomUnauthorizedException } from "src/common/errors/custom-exceptions";
import { JwtAccessTokenGuard } from "src/guards/accessToken.guard";
import { RolesGuard } from "src/guards/roles.guard";
import { PartnerErrorMessage } from "./partner.error";
import { PartnerService } from "./partner.service";
import {
  ApplyPartnerInput,
  PartnerDashboardType,
  PartnerProductConnectionType,
  PartnerProductFilterInput,
  PartnerProductInput,
  PartnerProductType,
  PartnerType,
} from "./partner.types";

const currentUserId = (context: { req?: { user?: { userId?: string } } }) => {
  const userId = context.req?.user?.userId;
  if (!userId) throw new CustomUnauthorizedException(PartnerErrorMessage.AuthenticationRequired);
  return userId;
};

@Resolver()
@UseGuards(JwtAccessTokenGuard, RolesGuard)
export class PartnerResolver {
  constructor(private readonly partnerService: PartnerService) {}
  @Query(() => PartnerType)
  @Roles(UserRole.User, UserRole.Partner)
  myPartner(@Context() context: { req?: { user?: { userId?: string } } }) {
    return this.partnerService.getMine(currentUserId(context));
  }
  @Query(() => PartnerDashboardType)
  @Roles(UserRole.Partner)
  myPartnerDashboard(@Context() context: { req?: { user?: { userId?: string } } }) {
    return this.partnerService.dashboard(currentUserId(context));
  }
  @Query(() => PartnerProductConnectionType)
  @Roles(UserRole.Partner)
  myPartnerProducts(
    @Args("filter", { type: () => PartnerProductFilterInput, nullable: true })
    filter: PartnerProductFilterInput | undefined,
    @Context() context: { req?: { user?: { userId?: string } } },
  ) {
    return this.partnerService.listProducts(currentUserId(context), filter ?? {});
  }
  @Query(() => PartnerProductType)
  @Roles(UserRole.Partner)
  myPartnerProduct(@Args("productId") productId: string, @Context() context: { req?: { user?: { userId?: string } } }) {
    return this.partnerService.getProduct(currentUserId(context), productId);
  }
  @Mutation(() => PartnerType)
  @Roles(UserRole.User)
  applyPartner(@Args("input") input: ApplyPartnerInput, @Context() context: { req?: { user?: { userId?: string } } }) {
    return this.partnerService.apply(currentUserId(context), input);
  }
  @Mutation(() => PartnerProductType)
  @Roles(UserRole.Partner)
  createPartnerProductDraft(
    @Args("input") input: PartnerProductInput,
    @Context() context: { req?: { user?: { userId?: string } } },
  ) {
    return this.partnerService.createDraft(currentUserId(context), input);
  }
  @Mutation(() => PartnerProductType)
  @Roles(UserRole.Partner)
  updatePartnerProductDraft(
    @Args("productId") productId: string,
    @Args("input") input: PartnerProductInput,
    @Context() context: { req?: { user?: { userId?: string } } },
  ) {
    return this.partnerService.updateDraft(currentUserId(context), productId, input);
  }
  @Mutation(() => PartnerProductType)
  @Roles(UserRole.Partner)
  submitPartnerProductForReview(
    @Args("productId") productId: string,
    @Context() context: { req?: { user?: { userId?: string } } },
  ) {
    return this.partnerService.submit(currentUserId(context), productId);
  }
  @Mutation(() => PartnerProductType)
  @Roles(UserRole.Partner)
  publishPartnerProduct(
    @Args("productId") productId: string,
    @Context() context: { req?: { user?: { userId?: string } } },
  ) {
    return this.partnerService.publish(currentUserId(context), productId);
  }
}
