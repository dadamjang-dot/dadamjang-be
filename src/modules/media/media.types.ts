import { ArgsType, Field, InputType, Int, ObjectType } from "@nestjs/graphql";

@InputType()
export class CreateProductImageUploadInput {
  @Field()
  filename!: string;

  @Field()
  contentType!: string;
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

  @Field()
  originalUrl!: string;

  @Field()
  imageUrl!: string;
}

@ArgsType()
export class ProductImageUrlArgs {
  @Field()
  key!: string;

  @Field(() => Int, { nullable: true })
  width?: number;
}
