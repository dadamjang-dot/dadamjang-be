import { Field, ObjectType } from "@nestjs/graphql";
import { ProductType } from "src/modules/catalog/catalog.types";

@ObjectType()
export class ComparisonItemType {
  @Field()
  comparisonItemId!: string;

  @Field()
  productId!: string;

  @Field(() => ProductType)
  product!: ProductType;

  @Field()
  createdAt!: Date;
}
