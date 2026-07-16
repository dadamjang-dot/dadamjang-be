import { Field, ObjectType } from "@nestjs/graphql";
import { ProductType } from "src/modules/catalog/catalog.types";

@ObjectType()
export class WishType {
  @Field()
  wishId!: string;
  @Field()
  productId!: string;
  @Field()
  createdAt!: Date;
  @Field(() => ProductType)
  product!: ProductType;
}
