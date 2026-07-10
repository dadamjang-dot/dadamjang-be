import { Field, InputType, Int, ObjectType } from "@nestjs/graphql";

@ObjectType()
export class CategoryType {
  @Field()
  categoryId!: string;
  @Field()
  name!: string;
  @Field()
  slug!: string;
  @Field(() => String, { nullable: true })
  parentId!: string | null;
  @Field(() => Int)
  sortOrder!: number;
}

@ObjectType()
export class ProductSkuType {
  @Field()
  skuId!: string;
  @Field()
  code!: string;
  @Field()
  optionName!: string;
  @Field(() => Int)
  price!: number;
  @Field(() => Int)
  stock!: number;
}

@ObjectType()
export class ProductType {
  @Field()
  productId!: string;
  @Field()
  partnerId!: string;
  @Field()
  categoryId!: string;
  @Field()
  title!: string;
  @Field()
  description!: string;
  @Field(() => [String])
  imageUrls!: string[];
  @Field()
  status!: string;
  @Field(() => [ProductSkuType])
  skus!: ProductSkuType[];
  @Field()
  createdAt!: Date;
}

@ObjectType()
export class ProductConnectionType {
  @Field(() => [ProductType])
  nodes!: ProductType[];
  @Field(() => String, { nullable: true })
  nextCursor!: string | null;
  @Field()
  hasNextPage!: boolean;
}

@InputType()
export class ProductFilterInput {
  @Field(() => String, { nullable: true })
  categoryId?: string;
  @Field(() => String, { nullable: true })
  query?: string;
  @Field(() => String, { nullable: true })
  after?: string;
  @Field(() => Int, { nullable: true })
  first?: number;
}

@InputType()
export class CreateCategoryInput {
  @Field()
  name!: string;
  @Field()
  slug!: string;
  @Field(() => String, { nullable: true })
  parentId?: string;
  @Field(() => Int, { nullable: true })
  sortOrder?: number;
}

@InputType()
export class ProductSkuInput {
  @Field()
  code!: string;
  @Field()
  optionName!: string;
  @Field(() => Int)
  price!: number;
  @Field(() => Int)
  stock!: number;
}

@InputType()
export class CreateProductDraftInput {
  @Field()
  categoryId!: string;
  @Field()
  title!: string;
  @Field()
  description!: string;
  @Field(() => [String])
  imageUrls!: string[];
  @Field(() => [ProductSkuInput])
  skus!: ProductSkuInput[];
}
