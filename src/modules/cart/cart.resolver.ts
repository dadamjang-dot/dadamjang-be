import { Args, Context, Mutation, Query, Resolver } from "@nestjs/graphql";
import { UseGuards } from "@nestjs/common";
import { UserRole } from "src/auth/role";
import { Roles } from "src/auth/roles.decorator";
import { CustomUnauthorizedException } from "src/common/errors/custom-exceptions";
import { JwtAccessTokenGuard } from "src/guards/accessToken.guard";
import { RolesGuard } from "src/guards/roles.guard";
import { CartService } from "./cart.service";
import { CartType, UpsertCartItemInput } from "./cart.types";

const currentUserId = (context: { req?: { user?: { userId?: string } } }) => {
  const userId = context.req?.user?.userId;
  if (!userId) throw new CustomUnauthorizedException("Authentication required");
  return userId;
};

@Resolver()
@UseGuards(JwtAccessTokenGuard, RolesGuard)
@Roles(UserRole.User)
export class CartResolver {
  constructor(private readonly cartService: CartService) {}
  @Query(() => CartType)
  cart(@Context() context: { req?: { user?: { userId?: string } } }) {
    return this.cartService.getCart(currentUserId(context));
  }
  @Mutation(() => CartType)
  upsertCartItem(
    @Args("input") input: UpsertCartItemInput,
    @Context() context: { req?: { user?: { userId?: string } } },
  ) {
    return this.cartService.upsertItem(currentUserId(context), input);
  }
  @Mutation(() => CartType)
  removeCartItem(@Args("skuId") skuId: string, @Context() context: { req?: { user?: { userId?: string } } }) {
    return this.cartService.removeItem(currentUserId(context), skuId);
  }
}
