import { Field, ObjectType } from "@nestjs/graphql";

import { ProductType } from "src/modules/catalog/catalog.types";

@ObjectType()
export class RecentlyViewedProductType {
  @Field()
  productId!: string;

  @Field()
  viewedAt!: Date;

  @Field(() => ProductType)
  product!: ProductType;
}
