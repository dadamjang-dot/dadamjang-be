import { Args, Context, Int, Mutation, Query, Resolver } from "@nestjs/graphql";
import { UseGuards } from "@nestjs/common";
import { UserRole } from "src/auth/role";
import { Roles } from "src/auth/roles.decorator";
import { CustomUnauthorizedException } from "src/common/errors/custom-exceptions";
import { JwtAccessTokenGuard } from "src/guards/accessToken.guard";
import { RolesGuard } from "src/guards/roles.guard";
import { StylePostErrorMessage } from "./style-posts.error";
import { StylePostsService } from "./style-posts.service";
import { CreateStylePostInput, StylePostConnectionType, StylePostType } from "./style-posts.types";

const currentUser = (context: { req?: { user?: { userId?: string; role?: string } } }) => {
  const user = context.req?.user;
  if (!user?.userId) throw new CustomUnauthorizedException(StylePostErrorMessage.AuthenticationRequired);
  return { userId: user.userId, role: user.role ?? UserRole.User };
};

@Resolver()
export class StylePostsResolver {
  constructor(private readonly stylePostsService: StylePostsService) {}

  @Query(() => StylePostConnectionType)
  stylePosts(
    @Args("first", { type: () => Int, nullable: true }) first: number | undefined,
    @Args("after", { type: () => String, nullable: true }) after: string | undefined,
  ) {
    return this.stylePostsService.list(after, first);
  }

  @Query(() => StylePostType)
  stylePost(@Args("stylePostId") stylePostId: string) {
    return this.stylePostsService.get(stylePostId);
  }

  @Mutation(() => StylePostType)
  @UseGuards(JwtAccessTokenGuard, RolesGuard)
  @Roles(UserRole.User, UserRole.Partner)
  createStylePost(
    @Args("input") input: CreateStylePostInput,
    @Context() context: { req?: { user?: { userId?: string; role?: string } } },
  ) {
    const user = currentUser(context);
    return this.stylePostsService.create(user.userId, user.role === UserRole.Partner, input);
  }
}
