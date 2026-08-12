import { Field, InputType, Int, ObjectType, registerEnumType } from "@nestjs/graphql";

export enum ProductSort {
  RECOMMENDED = "RECOMMENDED",
  LATEST = "LATEST",
  LOW_PRICE = "LOW_PRICE",
  HIGH_PRICE = "HIGH_PRICE",
  POPULAR = "POPULAR",
}

registerEnumType(ProductSort, { name: "ProductSort" });

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
export class BrandType {
  @Field()
  brandId!: string;
  @Field()
  name!: string;
  @Field()
  slug!: string;
}

@ObjectType()
export class ColorType {
  @Field()
  colorId!: string;
  @Field()
  name!: string;
  @Field()
  slug!: string;
  @Field(() => String, { nullable: true })
  hexCode!: string | null;
}

@ObjectType()
export class SizeType {
  @Field()
  sizeId!: string;
  @Field()
  name!: string;
  @Field()
  slug!: string;
  @Field(() => Int)
  sortOrder!: number;
}

@ObjectType()
export class CatalogFilterOptionsType {
  @Field(() => [CategoryType])
  categories!: CategoryType[];
  @Field(() => [BrandType])
  brands!: BrandType[];
  @Field(() => [ColorType])
  colors!: ColorType[];
  @Field(() => [SizeType])
  sizes!: SizeType[];
}

@ObjectType()
export class ProductSkuType {
  @Field()
  skuId!: string;
  @Field()
  code!: string;
  @Field(() => String, { nullable: true })
  colorId!: string | null;
  @Field(() => String, { nullable: true })
  sizeId!: string | null;
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
  @Field(() => String, { nullable: true })
  brandId!: string | null;
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
  @Field()
  isOnSale!: boolean;
  @Field()
  isExpressDelivery!: boolean;
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
  @Field(() => Int)
  totalCount!: number;
}

@ObjectType()
export class ProductPriceSummaryType {
  @Field()
  productId!: string;
  @Field()
  name!: string;
  @Field(() => String, { nullable: true })
  thumbnail!: string | null;
  @Field()
  isOnSale!: boolean;
  @Field()
  isExpressDelivery!: boolean;
  @Field(() => Int)
  basePrice!: number;
  @Field(() => Int)
  finalPrice!: number;
  @Field()
  priceRevision!: string;
  @Field()
  lowestPriceEvidenceSummary!: string;
}

@ObjectType()
export class ProductPriceSummaryConnectionType {
  @Field(() => [ProductPriceSummaryType])
  nodes!: ProductPriceSummaryType[];
  @Field(() => String, { nullable: true })
  nextCursor!: string | null;
  @Field()
  hasNextPage!: boolean;
  @Field(() => Int)
  totalCount!: number;
}

@ObjectType()
export class ProductPriceHistoryItemType {
  @Field()
  label!: string;
  @Field(() => Int)
  price!: number;
  @Field()
  recordedAt!: Date;
}

@ObjectType()
export class ProductCouponConditionType {
  @Field()
  title!: string;
  @Field(() => Int)
  discountAmount!: number;
  @Field()
  condition!: string;
}

@ObjectType()
export class ProductShippingPolicyType {
  @Field()
  title!: string;
  @Field(() => Int)
  shippingFee!: number;
  @Field()
  condition!: string;
}

@ObjectType()
export class ProductPriceEvidenceType {
  @Field()
  productId!: string;
  @Field()
  priceRevision!: string;
  @Field(() => [ProductPriceHistoryItemType])
  priceHistory!: ProductPriceHistoryItemType[];
  @Field(() => [ProductCouponConditionType])
  couponConditions!: ProductCouponConditionType[];
  @Field(() => ProductShippingPolicyType)
  shippingPolicy!: ProductShippingPolicyType;
  @Field()
  offerSource!: string;
  @Field()
  calculatedAt!: Date;
}

@InputType()
export class ProductFilterInput {
  @Field(() => String, { nullable: true })
  categoryId?: string;
  @Field(() => [String], { nullable: true })
  categoryIds?: string[];
  @Field(() => String, { nullable: true })
  query?: string;
  @Field(() => [String], { nullable: true })
  brandIds?: string[];
  @Field(() => [String], { nullable: true })
  colorIds?: string[];
  @Field(() => [String], { nullable: true })
  sizeIds?: string[];
  @Field(() => Int, { nullable: true })
  minPrice?: number;
  @Field(() => Int, { nullable: true })
  maxPrice?: number;
  @Field(() => Boolean, { nullable: true })
  saleOnly?: boolean;
  @Field(() => Boolean, { nullable: true })
  expressOnly?: boolean;
  @Field(() => ProductSort, { nullable: true })
  sort?: ProductSort;
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
  @Field(() => String, { nullable: true })
  colorId?: string;
  @Field(() => String, { nullable: true })
  sizeId?: string;
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
  @Field(() => String, { nullable: true })
  brandId?: string;
  @Field()
  title!: string;
  @Field()
  description!: string;
  @Field(() => [String])
  imageUrls!: string[];
  @Field(() => [ProductSkuInput])
  skus!: ProductSkuInput[];
  @Field(() => Boolean, { nullable: true })
  isOnSale?: boolean;
  @Field(() => Boolean, { nullable: true })
  isExpressDelivery?: boolean;
}
