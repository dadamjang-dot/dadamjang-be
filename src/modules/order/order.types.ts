import { Field, InputType, Int, ObjectType } from "@nestjs/graphql";
import type { OrderStatus, PaymentStatus } from "./order.constant";

export type CheckoutAttemptStatus = "CONFIRMED" | "NOT_OBSERVED";

@ObjectType()
export class CheckoutAttemptType {
  @Field(() => String)
  status!: CheckoutAttemptStatus;
  @Field(() => String, { nullable: true })
  orderId!: string | null;
}

@ObjectType()
export class OrderItemType {
  @Field()
  orderItemId!: string;
  @Field()
  productId!: string;
  @Field()
  skuId!: string;
  @Field()
  productTitle!: string;
  @Field()
  skuOptionName!: string;
  @Field(() => Int)
  unitPrice!: number;
  @Field(() => Int)
  quantity!: number;
}

@ObjectType()
export class OrderType {
  @Field()
  orderId!: string;
  @Field()
  orderNumber!: string;
  @Field()
  status!: OrderStatus;
  @Field()
  paymentStatus!: PaymentStatus;
  @Field(() => Int)
  totalAmount!: number;
  @Field(() => String, { nullable: true })
  paymentFailureReason!: string | null;
  @Field(() => [OrderItemType])
  items!: OrderItemType[];
  @Field()
  createdAt!: Date;
}

@InputType()
export class CheckoutExpectedCartItemInput {
  @Field(() => String)
  cartItemId!: string;
  @Field(() => String)
  skuId!: string;
  @Field(() => Int)
  quantity!: number;
  @Field(() => Int)
  unitPrice!: number;
}

@InputType()
export class CheckoutCartInput {
  @Field(() => String)
  idempotencyKey!: string;
  @Field(() => [CheckoutExpectedCartItemInput], { nullable: true })
  expectedCart?: CheckoutExpectedCartItemInput[] | null;
}
