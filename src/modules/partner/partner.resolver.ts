import { Args, Context, Mutation, Query, Resolver } from "@nestjs/graphql";
import { UseGuards } from "@nestjs/common";
import { UserRole } from "src/auth/role";
import { Roles } from "src/auth/roles.decorator";
import { CreateProductDraftInput, ProductType } from "src/modules/catalog/catalog.types";
import { CustomUnauthorizedException } from "src/common/errors/custom-exceptions";
import { JwtAccessTokenGuard } from "src/guards/accessToken.guard";
import { RolesGuard } from "src/guards/roles.guard";
import { PartnerService } from "./partner.service";
import { ApplyPartnerInput, PartnerType } from "./partner.types";

const currentUserId = (context: { req?: { user?: { userId?: string } } }) => {
  const userId = context.req?.user?.userId;
  if (!userId) throw new CustomUnauthorizedException("Authentication required");
  return userId;
};

@Resolver()
export class PartnerResolver {
  constructor(private readonly partnerService: PartnerService) {}
  @Query(() => PartnerType)
  @UseGuards(JwtAccessTokenGuard, RolesGuard)
  @Roles(UserRole.User, UserRole.Partner)
  myPartner(@Context() context: { req?: { user?: { userId?: string } } }) {
    return this.partnerService.getMine(currentUserId(context));
  }
  @Mutation(() => PartnerType)
  @UseGuards(JwtAccessTokenGuard, RolesGuard)
  @Roles(UserRole.User)
  applyPartner(@Args("input") input: ApplyPartnerInput, @Context() context: { req?: { user?: { userId?: string } } }) {
    return this.partnerService.apply(currentUserId(context), input);
  }
  @Mutation(() => ProductType)
  @UseGuards(JwtAccessTokenGuard, RolesGuard)
  @Roles(UserRole.Partner)
  createPartnerProductDraft(
    @Args("input") input: CreateProductDraftInput,
    @Context() context: { req?: { user?: { userId?: string } } },
  ) {
    return this.partnerService.createDraft(currentUserId(context), input);
  }
  @Mutation(() => ProductType)
  @UseGuards(JwtAccessTokenGuard, RolesGuard)
  @Roles(UserRole.Partner)
  publishPartnerProduct(
    @Args("productId") productId: string,
    @Context() context: { req?: { user?: { userId?: string } } },
  ) {
    return this.partnerService.publishProduct(currentUserId(context), productId);
  }
}
