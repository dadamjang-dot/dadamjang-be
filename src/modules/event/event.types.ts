import { Field, ObjectType } from "@nestjs/graphql";

@ObjectType()
export class ActivityEventType {
  @Field()
  eventId!: string;
  @Field()
  eventType!: string;
  @Field()
  subjectType!: string;
  @Field()
  subjectId!: string;
  @Field()
  createdAt!: Date;
}
