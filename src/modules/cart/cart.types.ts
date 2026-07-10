import { Field, InputType, Int, ObjectType } from "@nestjs/graphql";
import { ProductSkuType, ProductType } from "src/modules/catalog/catalog.types";

@ObjectType()
export class CartItemType {
  @Field()
  cartItemId!: string;
  @Field(() => Int)
  quantity!: number;
  @Field(() => ProductSkuType)
  sku!: ProductSkuType;
  @Field(() => ProductType)
  product!: ProductType;
}

@ObjectType()
export class CartType {
  @Field()
  cartId!: string;
  @Field(() => [CartItemType])
  items!: CartItemType[];
  @Field(() => Int)
  totalAmount!: number;
}

@InputType()
export class UpsertCartItemInput {
  @Field()
  skuId!: string;
  @Field(() => Int)
  quantity!: number;
}
