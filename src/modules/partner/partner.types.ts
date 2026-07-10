import { Field, InputType, ObjectType } from "@nestjs/graphql";
import { ProductType } from "src/modules/catalog/catalog.types";

@InputType()
export class ApplyPartnerInput {
  @Field()
  businessEmail!: string;
  @Field()
  businessRegistrationNumber!: string;
  @Field()
  tradeName!: string;
  @Field()
  businessEmailVerificationToken!: string;
}

@ObjectType()
export class PartnerType {
  @Field()
  partnerId!: string;
  @Field()
  ownerUserId!: string;
  @Field()
  businessEmail!: string;
  @Field()
  businessRegistrationNumber!: string;
  @Field()
  tradeName!: string;
  @Field()
  status!: string;
  @Field(() => String, { nullable: true })
  rejectionReason!: string | null;
}

@ObjectType()
export class PartnerProductType extends ProductType {}
