import { Field, InputType, ObjectType } from "@nestjs/graphql";
import { PartnerType } from "src/modules/partner/partner.types";

@InputType()
export class ReviewPartnerInput {
  @Field()
  partnerId!: string;
  @Field()
  approved!: boolean;
  @Field(() => String, { nullable: true })
  rejectionReason?: string;
}

@InputType()
export class ReviewProductInput {
  @Field()
  productId!: string;
  @Field()
  approved!: boolean;
  @Field(() => String, { nullable: true })
  rejectionReason?: string;
}

@InputType()
export class TransitionOrderInput {
  @Field()
  orderId!: string;
  @Field()
  nextStatus!: string;
}

@InputType()
export class CreateAdminInviteInput {
  @Field()
  email!: string;
}

@InputType()
export class AcceptAdminInviteInput {
  @Field()
  token!: string;
  @Field()
  userid!: string;
  @Field()
  password!: string;
}

@ObjectType()
export class AdminInviteType {
  @Field()
  inviteId!: string;
  @Field()
  email!: string;
  @Field()
  expiresAt!: Date;
  @Field(() => String, { nullable: true })
  token!: string | null;
}

@ObjectType()
export class PartnerReviewType extends PartnerType {}
