import { Field, InputType, Int, ObjectType, registerEnumType } from "@nestjs/graphql";

export enum StylePostCategory {
  SNEAKERS = "SNEAKERS",
  CLOTHING = "CLOTHING",
  ACCESSORIES = "ACCESSORIES",
}

export enum StylePostSort {
  RECOMMENDED = "RECOMMENDED",
  POPULAR = "POPULAR",
  LATEST = "LATEST",
}

registerEnumType(StylePostCategory, { name: "StylePostCategory" });
registerEnumType(StylePostSort, { name: "StylePostSort" });

@InputType()
export class StylePostFilterInput {
  @Field(() => StylePostCategory, { nullable: true })
  category?: StylePostCategory;

  @Field(() => StylePostSort, { nullable: true })
  sort?: StylePostSort;
}

@ObjectType()
export class StylePostAuthorType {
  @Field()
  userId!: string;

  @Field()
  userid!: string;
}

@ObjectType()
export class StylePostBrandTagType {
  @Field()
  brandId!: string;

  @Field()
  name!: string;
}

@ObjectType()
export class StylePostProductType {
  @Field()
  productId!: string;

  @Field()
  title!: string;

  @Field(() => [String])
  imageUrls!: string[];

  @Field(() => String, { nullable: true })
  brandId!: string | null;

  @Field(() => String, { nullable: true })
  brandName!: string | null;

  @Field()
  categoryId!: string;
}

@ObjectType()
export class PurchasedStyleProductType extends StylePostProductType {
  @Field()
  lastPurchasedAt!: Date;
}

@ObjectType()
export class StylePostType {
  @Field()
  stylePostId!: string;

  @Field()
  authorId!: string;

  @Field(() => StylePostAuthorType)
  author!: StylePostAuthorType;

  @Field()
  title!: string;

  @Field()
  content!: string;

  @Field(() => StylePostCategory)
  category!: StylePostCategory;

  @Field(() => [String])
  imageUrls!: string[];

  @Field(() => String, { nullable: true })
  thumbnailUrl!: string | null;

  @Field(() => [String])
  hashtags!: string[];

  @Field(() => [StylePostBrandTagType])
  brandTags!: StylePostBrandTagType[];

  @Field(() => [StylePostProductType])
  products!: StylePostProductType[];

  @Field()
  isPartner!: boolean;

  @Field(() => Int)
  likeCount!: number;

  @Field()
  isLiked!: boolean;

  @Field()
  createdAt!: Date;

  @Field()
  updatedAt!: Date;
}

@ObjectType()
export class StylePostConnectionType {
  @Field(() => [StylePostType])
  nodes!: StylePostType[];

  @Field(() => String, { nullable: true })
  nextCursor!: string | null;

  @Field()
  hasNextPage!: boolean;
}

@InputType()
export class CreateStylePostInput {
  @Field(() => StylePostCategory)
  category!: StylePostCategory;

  @Field(() => [String])
  productIds!: string[];

  @Field(() => [String])
  imageKeys!: string[];

  @Field()
  content!: string;

  @Field(() => [String], { nullable: true })
  hashtags?: string[];

  @Field(() => [String], { nullable: true })
  brandTagIds?: string[];

  @Field()
  idempotencyKey!: string;
}
