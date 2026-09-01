import { Field, ID, InputType, Int, ObjectType, registerEnumType } from "@nestjs/graphql";
import { BrandType, ProductSkuInput, ProductType } from "src/modules/catalog/catalog.types";

@InputType()
export class ApplyPartnerInput {
  @Field() businessEmail!: string;
  @Field() businessRegistrationNumber!: string;
  @Field() tradeName!: string;
  @Field() businessEmailVerificationToken!: string;
}

export enum PartnerProductState {
  Draft = "DRAFT",
  Pending = "PENDING",
  Rejected = "REJECTED",
  Approved = "APPROVED",
  Published = "PUBLISHED",
}
registerEnumType(PartnerProductState, { name: "PartnerProductState" });

@InputType()
export class PartnerProductInput {
  @Field() categoryId!: string;
  @Field() title!: string;
  @Field() description!: string;
  @Field(() => [String]) imageKeys!: string[];
  @Field(() => [ProductSkuInput]) skus!: ProductSkuInput[];
  @Field(() => Boolean, { nullable: true }) isOnSale?: boolean;
  @Field(() => Boolean, { nullable: true }) isExpressDelivery?: boolean;
}

@InputType()
export class UpdatePublishedProductSkuInput {
  @Field(() => ID) skuId!: string;
  @Field(() => Int) price!: number;
  @Field(() => Int) stock!: number;
}

@InputType()
export class UpdatePublishedProductSkusInput {
  @Field(() => ID) productId!: string;
  @Field(() => [UpdatePublishedProductSkuInput]) skus!: UpdatePublishedProductSkuInput[];
}

@InputType()
export class PartnerProductFilterInput {
  @Field({ nullable: true }) query?: string;
  @Field(() => PartnerProductState, { nullable: true }) state?: PartnerProductState;
  @Field({ nullable: true }) categoryId?: string;
  @Field({ nullable: true }) after?: string;
  @Field(() => Int, { nullable: true }) first?: number;
}

@ObjectType()
export class PartnerType {
  @Field() partnerId!: string;
  @Field() tradeName!: string;
  @Field() status!: string;
  @Field(() => BrandType, { nullable: true }) brand!: BrandType | null;
}

@ObjectType()
export class PartnerProductType extends ProductType {
  @Field(() => [String]) imageKeys!: string[];
  @Field() approvalStatus!: string;
  @Field(() => String, { nullable: true }) rejectionReason!: string | null;
  @Field() updatedAt!: Date;
}

@ObjectType()
export class PartnerProductConnectionType {
  @Field(() => [PartnerProductType]) nodes!: PartnerProductType[];
  @Field(() => String, { nullable: true }) nextCursor!: string | null;
  @Field() hasNextPage!: boolean;
  @Field(() => Int) totalCount!: number;
}

@ObjectType()
export class PartnerDashboardType {
  @Field(() => Int) draftCount!: number;
  @Field(() => Int) pendingCount!: number;
  @Field(() => Int) rejectedCount!: number;
  @Field(() => Int) approvedCount!: number;
  @Field(() => Int) publishedCount!: number;
}
