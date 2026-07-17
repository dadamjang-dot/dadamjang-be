import { Args, Context, Mutation, Query, Resolver } from "@nestjs/graphql";
import { UseGuards } from "@nestjs/common";
import { UserRole } from "src/auth/role";
import { Roles } from "src/auth/roles.decorator";
import { CustomUnauthorizedException } from "src/common/errors/custom-exceptions";
import { JwtAccessTokenGuard } from "src/guards/accessToken.guard";
import { RolesGuard } from "src/guards/roles.guard";
import { WishErrorMessage } from "./wish.error";
import { WishService } from "./wish.service";
import { WishType } from "./wish.types";

const currentUserId = (context: { req?: { user?: { userId?: string } } }) => {
  const userId = context.req?.user?.userId;
  if (!userId) throw new CustomUnauthorizedException(WishErrorMessage.AuthenticationRequired);
  return userId;
};

@Resolver()
@UseGuards(JwtAccessTokenGuard, RolesGuard)
@Roles(UserRole.User)
export class WishResolver {
  constructor(private readonly wishService: WishService) {}

  @Query(() => [WishType])
  wishlist(@Context() context: { req?: { user?: { userId?: string } } }) {
    return this.wishService.list(currentUserId(context));
  }

  @Mutation(() => WishType)
  addWish(@Args("productId") productId: string, @Context() context: { req?: { user?: { userId?: string } } }) {
    return this.wishService.add(currentUserId(context), productId);
  }

  @Mutation(() => Boolean)
  removeWish(@Args("productId") productId: string, @Context() context: { req?: { user?: { userId?: string } } }) {
    return this.wishService.remove(currentUserId(context), productId);
  }
}
