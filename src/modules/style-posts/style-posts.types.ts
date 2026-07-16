import { Field, InputType, ObjectType } from "@nestjs/graphql";

@ObjectType()
export class StylePostType {
  @Field()
  stylePostId!: string;
  @Field()
  authorId!: string;
  @Field()
  title!: string;
  @Field()
  content!: string;
  @Field(() => [String])
  imageUrls!: string[];
  @Field()
  isPartner!: boolean;
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
  @Field()
  title!: string;
  @Field()
  content!: string;
  @Field(() => [String])
  imageUrls!: string[];
}
