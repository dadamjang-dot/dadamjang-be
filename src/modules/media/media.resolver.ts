import { Args, Mutation, Query, Resolver } from "@nestjs/graphql";
import { UseGuards } from "@nestjs/common";
import { JwtAccessTokenGuard } from "src/guards/accessToken.guard";
import { RolesGuard } from "src/guards/roles.guard";
import { UserRole } from "src/auth/role";
import { Roles } from "src/auth/roles.decorator";
import { CreateProductImageUploadInput, ProductImageUploadTarget, ProductImageUrlArgs } from "./media.types";
import { MediaService } from "./media.service";

@Resolver()
@UseGuards(JwtAccessTokenGuard, RolesGuard)
export class MediaResolver {
  constructor(private readonly mediaService: MediaService) {}

  @Mutation(() => ProductImageUploadTarget)
  @Roles(UserRole.Partner)
  async createProductImageUpload(@Args("input") input: CreateProductImageUploadInput) {
    return this.mediaService.createProductUpload(input);
  }

  @Query(() => String)
  @Roles(UserRole.Partner, UserRole.Admin)
  async productImageUrl(@Args() args: ProductImageUrlArgs) {
    return this.mediaService.getProductImageUrl(args.key, args.width);
  }
}
