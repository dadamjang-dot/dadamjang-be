import { Args, Context, Int, Query, Resolver } from "@nestjs/graphql";
import { UseGuards } from "@nestjs/common";
import { UserRole } from "src/auth/role";
import { Roles } from "src/auth/roles.decorator";
import { CustomUnauthorizedException } from "src/common/errors/custom-exceptions";
import { JwtAccessTokenGuard } from "src/guards/accessToken.guard";
import { RolesGuard } from "src/guards/roles.guard";
import { FeedErrorMessage } from "./feed.error";
import { FeedService } from "./feed.service";
import { FeedConnectionType } from "./feed.types";

const currentUserId = (context: { req?: { user?: { userId?: string } } }) => {
  const userId = context.req?.user?.userId;
  if (!userId) throw new CustomUnauthorizedException(FeedErrorMessage.AuthenticationRequired);
  return userId;
};

@Resolver()
@UseGuards(JwtAccessTokenGuard, RolesGuard)
@Roles(UserRole.User)
export class FeedResolver {
  constructor(private readonly feedService: FeedService) {}
  @Query(() => FeedConnectionType)
  personalizedFeed(
    @Args("first", { type: () => Int, nullable: true }) first: number | undefined,
    @Args("after", { type: () => String, nullable: true }) after: string | undefined,
    @Context() context: { req?: { user?: { userId?: string } } },
  ) {
    return this.feedService.personalizedFeed(currentUserId(context), first, after);
  }
}
