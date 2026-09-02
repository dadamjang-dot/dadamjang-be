import { Args, Context, Mutation, Resolver } from "@nestjs/graphql";
import { UseGuards } from "@nestjs/common";
import { JwtAccessTokenGuard } from "src/guards/access-token.guard";
import { RolesGuard } from "src/guards/roles.guard";
import { UserRole } from "src/auth/role";
import { Roles } from "src/auth/roles.decorator";
import { CustomUnauthorizedException } from "src/common/errors/custom-exceptions";
import { requestOriginFromRequest } from "src/modules/admission/admission-limiter";
import type { Request } from "express";
import { MediaErrorMessage } from "./media.error";
import {
  CreateProductImageUploadInput,
  CreateStylePostImageUploadInput,
  ProductImageUploadTarget,
} from "./media.types";
import { MediaService } from "./media.service";

type MediaRequest = Pick<Request, "headers" | "ip"> & { user?: { userId?: string } };
type MediaContext = { req?: MediaRequest };

const currentRequest = (context: MediaContext) => {
  const req = context.req;
  const userId = req?.user?.userId;
  if (!userId) throw new CustomUnauthorizedException(MediaErrorMessage.InvalidKey);
  return { req, userId };
};

@Resolver()
@UseGuards(JwtAccessTokenGuard, RolesGuard)
export class MediaResolver {
  constructor(private readonly mediaService: MediaService) {}

  @Mutation(() => ProductImageUploadTarget)
  @Roles(UserRole.Partner)
  async createProductImageUpload(
    @Args("input") input: CreateProductImageUploadInput,
    @Context() context: MediaContext,
  ) {
    const { req, userId } = currentRequest(context);
    return this.mediaService.createProductUpload(userId, input, requestOriginFromRequest(req));
  }

  @Mutation(() => ProductImageUploadTarget)
  @Roles(UserRole.User, UserRole.Partner)
  async createStylePostImageUpload(
    @Args("input") input: CreateStylePostImageUploadInput,
    @Context() context: MediaContext,
  ) {
    const { req, userId } = currentRequest(context);
    return this.mediaService.createStylePostUpload(userId, input, requestOriginFromRequest(req));
  }
}
