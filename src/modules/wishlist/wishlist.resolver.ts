import { Args, Context, Mutation, Query, Resolver } from "@nestjs/graphql";
import { UseGuards } from "@nestjs/common";
import { UserRole } from "src/auth/role";
import { Roles } from "src/auth/roles.decorator";
import { CustomUnauthorizedException } from "src/common/errors/custom-exceptions";
import { JwtAccessTokenGuard } from "src/guards/accessToken.guard";
import { RolesGuard } from "src/guards/roles.guard";
import { WishlistErrorMessage } from "./wishlist.error";
import { WishlistService } from "./wishlist.service";
import { WishlistType } from "./wishlist.types";

const currentUserId = (context: { req?: { user?: { userId?: string } } }) => {
  const userId = context.req?.user?.userId;
  if (!userId) throw new CustomUnauthorizedException(WishlistErrorMessage.AuthenticationRequired);
  return userId;
};

@Resolver()
@UseGuards(JwtAccessTokenGuard, RolesGuard)
@Roles(UserRole.User)
export class WishlistResolver {
  constructor(private readonly wishlistService: WishlistService) {}

  @Query(() => [WishlistType])
  wishlist(@Context() context: { req?: { user?: { userId?: string } } }) {
    return this.wishlistService.list(currentUserId(context));
  }

  @Mutation(() => WishlistType)
  addWishlist(@Args("productId") productId: string, @Context() context: { req?: { user?: { userId?: string } } }) {
    return this.wishlistService.add(currentUserId(context), productId);
  }

  @Mutation(() => Boolean)
  removeWishlist(@Args("productId") productId: string, @Context() context: { req?: { user?: { userId?: string } } }) {
    return this.wishlistService.remove(currentUserId(context), productId);
  }
}
