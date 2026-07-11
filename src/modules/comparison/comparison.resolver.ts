import { Args, Context, Mutation, Query, Resolver } from "@nestjs/graphql";
import { UseGuards } from "@nestjs/common";
import { UserRole } from "src/auth/role";
import { Roles } from "src/auth/roles.decorator";
import { CustomUnauthorizedException } from "src/common/errors/custom-exceptions";
import { ProductPriceSummaryType } from "src/modules/catalog/catalog.types";
import { JwtAccessTokenGuard } from "src/guards/accessToken.guard";
import { RolesGuard } from "src/guards/roles.guard";
import { ComparisonService } from "./comparison.service";
import { ComparisonItemType } from "./comparison.types";

const currentUserId = (context: { req?: { user?: { userId?: string } } }) => {
  const userId = context.req?.user?.userId;
  if (!userId) throw new CustomUnauthorizedException("Authentication required");
  return userId;
};

@Resolver()
@UseGuards(JwtAccessTokenGuard, RolesGuard)
@Roles(UserRole.User)
export class ComparisonResolver {
  constructor(private readonly comparisonService: ComparisonService) {}

  @Query(() => [ComparisonItemType])
  comparison(@Context() context: { req?: { user?: { userId?: string } } }) {
    return this.comparisonService.list(currentUserId(context));
  }

  @Query(() => [ProductPriceSummaryType])
  comparisonPriceSummaries(@Context() context: { req?: { user?: { userId?: string } } }) {
    return this.comparisonService.listPriceSummaries(currentUserId(context));
  }

  @Mutation(() => ComparisonItemType)
  addComparisonItem(
    @Args("productId") productId: string,
    @Context() context: { req?: { user?: { userId?: string } } },
  ) {
    return this.comparisonService.add(currentUserId(context), productId);
  }

  @Mutation(() => Boolean)
  removeComparisonItem(
    @Args("productId") productId: string,
    @Context() context: { req?: { user?: { userId?: string } } },
  ) {
    return this.comparisonService.remove(currentUserId(context), productId);
  }
}
