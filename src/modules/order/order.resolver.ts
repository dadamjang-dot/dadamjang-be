import { Args, Context, Mutation, Query, Resolver } from "@nestjs/graphql";
import { UseGuards } from "@nestjs/common";
import { UserRole } from "src/auth/role";
import { Roles } from "src/auth/roles.decorator";
import { CustomUnauthorizedException } from "src/common/errors/custom-exceptions";
import { JwtAccessTokenGuard } from "src/guards/access-token.guard";
import { RolesGuard } from "src/guards/roles.guard";
import { OrderErrorMessage } from "./order.error";
import { CheckoutAttemptType, CheckoutCartInput, OrderType } from "./order.types";
import { OrderService } from "./order.service";

const currentUserId = (context: { req?: { user?: { userId?: string } } }) => {
  const userId = context.req?.user?.userId;
  if (!userId) throw new CustomUnauthorizedException(OrderErrorMessage.AuthenticationRequired);
  return userId;
};

@Resolver()
@UseGuards(JwtAccessTokenGuard, RolesGuard)
@Roles(UserRole.User)
export class OrderResolver {
  constructor(private readonly orderService: OrderService) {}
  @Query(() => CheckoutAttemptType)
  checkoutAttempt(
    @Args("idempotencyKey", { type: () => String }) idempotencyKey: string,
    @Context() context: { req?: { user?: { userId?: string } } },
  ) {
    return this.orderService.checkoutAttempt(currentUserId(context), idempotencyKey);
  }
  @Query(() => [OrderType])
  orders(@Context() context: { req?: { user?: { userId?: string } } }) {
    return this.orderService.listOrders(currentUserId(context));
  }
  @Query(() => OrderType)
  order(@Args("orderId") orderId: string, @Context() context: { req?: { user?: { userId?: string } } }) {
    return this.orderService.getOrder(currentUserId(context), orderId);
  }
  @Mutation(() => OrderType)
  checkoutCart(
    @Args("input", { type: () => CheckoutCartInput, nullable: true })
    input: CheckoutCartInput | undefined,
    @Context() context: { req?: { user?: { userId?: string } } },
  ) {
    return this.orderService.checkoutCart(currentUserId(context), input ?? {});
  }
}
