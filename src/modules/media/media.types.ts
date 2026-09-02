import { Field, InputType, Int, ObjectType } from "@nestjs/graphql";

@InputType()
export class CreateProductImageUploadInput {
  @Field()
  filename!: string;

  @Field()
  contentType!: string;

  @Field(() => Int)
  fileSize!: number;
}

@InputType()
export class CreateStylePostImageUploadInput {
  @Field()
  filename!: string;

  @Field()
  contentType!: string;

  @Field(() => Int)
  fileSize!: number;
}

@ObjectType()
export class ProductImageUploadTarget {
  @Field()
  key!: string;

  @Field()
  uploadUrl!: string;

  @Field(() => String, { nullable: true })
  originalUrl!: string | null;

  @Field(() => String, { nullable: true })
  imageUrl!: string | null;
}
