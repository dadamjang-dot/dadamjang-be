import { Args, Context, Mutation, Query, Resolver } from "@nestjs/graphql";
import { UseGuards } from "@nestjs/common";
import { JwtAccessTokenGuard } from "src/guards/accessToken.guard";
import { RolesGuard } from "src/guards/roles.guard";
import { UserRole } from "src/auth/role";
import { Roles } from "src/auth/roles.decorator";
import { CustomUnauthorizedException } from "src/common/errors/custom-exceptions";
import { MediaErrorMessage } from "./media.error";
import {
  CreateProductImageUploadInput,
  CreateStylePostImageUploadInput,
  ProductImageUploadTarget,
  ProductImageUrlArgs,
} from "./media.types";
import { MediaService } from "./media.service";

const currentUserId = (context: { req?: { user?: { userId?: string } } }) => {
  const userId = context.req?.user?.userId;
  if (!userId) throw new CustomUnauthorizedException(MediaErrorMessage.InvalidKey);
  return userId;
};

@Resolver()
@UseGuards(JwtAccessTokenGuard, RolesGuard)
export class MediaResolver {
  constructor(private readonly mediaService: MediaService) {}

  @Mutation(() => ProductImageUploadTarget)
  @Roles(UserRole.Partner)
  async createProductImageUpload(@Args("input") input: CreateProductImageUploadInput) {
    return this.mediaService.createProductUpload(input);
  }

  @Mutation(() => ProductImageUploadTarget)
  @Roles(UserRole.User, UserRole.Partner)
  async createStylePostImageUpload(
    @Args("input") input: CreateStylePostImageUploadInput,
    @Context() context: { req?: { user?: { userId?: string } } },
  ) {
    return this.mediaService.createStylePostUpload(currentUserId(context), input);
  }

  @Query(() => String)
  @Roles(UserRole.Partner, UserRole.Admin)
  async productImageUrl(@Args() args: ProductImageUrlArgs) {
    return this.mediaService.getProductImageUrl(args.key, args.width);
  }
}
