import { Field, InputType, Int, ObjectType } from "@nestjs/graphql";
import type { OrderStatus, PaymentStatus } from "./order.constant";

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
export class CheckoutCartInput {
  @Field(() => String)
  idempotencyKey!: string;
}
