import { UseGuards } from "@nestjs/common";
import { Args, Context, Mutation, Query, Resolver } from "@nestjs/graphql";

import { UserRole } from "src/auth/role";
import { Roles } from "src/auth/roles.decorator";
import { CustomUnauthorizedException } from "src/common/errors/custom-exceptions";
import { BrandType } from "src/modules/catalog/catalog.types";
import { JwtAccessTokenGuard } from "src/guards/access-token.guard";
import { RolesGuard } from "src/guards/roles.guard";
import { WishLibraryErrorMessage } from "./wish-library.error";
import { WishLibraryService } from "./wish-library.service";
import { RecentlyViewedProductType } from "./wish-library.types";

const currentUserId = (context: { req?: { user?: { userId?: string } } }) => {
  const userId = context.req?.user?.userId;
  if (!userId) throw new CustomUnauthorizedException(WishLibraryErrorMessage.AuthenticationRequired);
  return userId;
};

@Resolver()
@UseGuards(JwtAccessTokenGuard, RolesGuard)
@Roles(UserRole.User)
export class WishLibraryResolver {
  constructor(private readonly wishLibraryService: WishLibraryService) {}

  @Query(() => [BrandType])
  followedBrands(@Context() context: { req?: { user?: { userId?: string } } }) {
    return this.wishLibraryService.listFollowedBrands(currentUserId(context));
  }

  @Mutation(() => BrandType)
  followBrand(@Args("brandId") brandId: string, @Context() context: { req?: { user?: { userId?: string } } }) {
    return this.wishLibraryService.followBrand(currentUserId(context), brandId);
  }

  @Mutation(() => Boolean)
  unfollowBrand(@Args("brandId") brandId: string, @Context() context: { req?: { user?: { userId?: string } } }) {
    return this.wishLibraryService.unfollowBrand(currentUserId(context), brandId);
  }

  @Query(() => [RecentlyViewedProductType])
  recentlyViewedProducts(@Context() context: { req?: { user?: { userId?: string } } }) {
    return this.wishLibraryService.listRecentlyViewedProducts(currentUserId(context));
  }

  @Mutation(() => Boolean)
  recordRecentProductView(
    @Args("productId") productId: string,
    @Context() context: { req?: { user?: { userId?: string } } },
  ) {
    return this.wishLibraryService.recordRecentProductView(currentUserId(context), productId);
  }
}
