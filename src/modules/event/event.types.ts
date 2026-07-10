import { Field, InputType, ObjectType } from "@nestjs/graphql";

@InputType()
export class RecordActivityEventInput {
  @Field()
  eventType!: string;
  @Field()
  subjectType!: string;
  @Field()
  subjectId!: string;
}

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
