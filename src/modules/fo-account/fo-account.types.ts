import { Field, GraphQLISODateTime, ObjectType } from "@nestjs/graphql";

@ObjectType()
export class FoAccountDeactivationPayload {
  @Field()
  ok!: boolean;

  @Field(() => GraphQLISODateTime)
  scheduledAnonymizationAt!: Date;
}
