import { Field, Int, ObjectType } from "@nestjs/graphql";
import { ProductType } from "src/modules/catalog/catalog.types";

@ObjectType()
export class FeedConnectionType {
  @Field(() => [ProductType])
  nodes!: ProductType[];
  @Field(() => String, { nullable: true })
  nextCursor!: string | null;
  @Field()
  hasNextPage!: boolean;
  @Field(() => Int)
  personalizedCategoryCount!: number;
}
