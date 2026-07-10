import { Field, InputType, Int, ObjectType } from "@nestjs/graphql";

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
  status!: string;
  @Field()
  paymentStatus!: string;
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
  @Field(() => Boolean, { nullable: true })
  forcePaymentFailure?: boolean;
}
