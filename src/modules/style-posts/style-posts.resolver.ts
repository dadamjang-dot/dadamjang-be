import { Args, Context, Int, Mutation, Query, Resolver } from "@nestjs/graphql";
import { UseGuards } from "@nestjs/common";
import { UserRole } from "src/auth/role";
import { Roles } from "src/auth/roles.decorator";
import { CustomUnauthorizedException } from "src/common/errors/custom-exceptions";
import { JwtAccessTokenGuard } from "src/guards/accessToken.guard";
import { OptionalJwtAccessTokenGuard } from "src/guards/optionalAccessToken.guard";
import { RolesGuard } from "src/guards/roles.guard";
import { StylePostErrorMessage } from "./style-posts.error";
import { StylePostsService } from "./style-posts.service";
import {
  CreateStylePostInput,
  PurchasedStyleProductType,
  StylePostConnectionType,
  StylePostFilterInput,
  StylePostType,
} from "./style-posts.types";

const currentUser = (context: { req?: { user?: { userId?: string; role?: string } } }) => {
  const user = context.req?.user;
  if (!user?.userId) throw new CustomUnauthorizedException(StylePostErrorMessage.AuthenticationRequired);
  return { userId: user.userId, role: user.role ?? UserRole.User };
};

const optionalUserId = (context: { req?: { user?: { userId?: string } } }) => context.req?.user?.userId;

@Resolver()
export class StylePostsResolver {
  constructor(private readonly stylePostsService: StylePostsService) {}

  @Query(() => StylePostConnectionType)
  @UseGuards(OptionalJwtAccessTokenGuard)
  stylePosts(
    @Args("filter", { type: () => StylePostFilterInput, nullable: true }) filter: StylePostFilterInput | undefined,
    @Args("first", { type: () => Int, nullable: true }) first: number | undefined,
    @Args("after", { type: () => String, nullable: true }) after: string | undefined,
    @Context() context: { req?: { user?: { userId?: string } } },
  ) {
    return this.stylePostsService.list(filter, after, first, optionalUserId(context));
  }

  @Query(() => StylePostType)
  @UseGuards(OptionalJwtAccessTokenGuard)
  stylePost(@Args("stylePostId") stylePostId: string, @Context() context: { req?: { user?: { userId?: string } } }) {
    return this.stylePostsService.get(stylePostId, optionalUserId(context));
  }

  @Query(() => StylePostConnectionType)
  @UseGuards(JwtAccessTokenGuard, RolesGuard)
  @Roles(UserRole.User, UserRole.Partner)
  likedStylePosts(
    @Args("first", { type: () => Int, nullable: true }) first: number | undefined,
    @Args("after", { type: () => String, nullable: true }) after: string | undefined,
    @Context() context: { req?: { user?: { userId?: string; role?: string } } },
  ) {
    return this.stylePostsService.listLiked(currentUser(context).userId, after, first);
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

  @Query(() => [PurchasedStyleProductType])
  @UseGuards(JwtAccessTokenGuard, RolesGuard)
  @Roles(UserRole.User)
  purchasedStyleProducts(@Context() context: { req?: { user?: { userId?: string; role?: string } } }) {
    return this.stylePostsService.purchasedStyleProducts(currentUser(context).userId);
  }

  @Mutation(() => StylePostType)
  @UseGuards(JwtAccessTokenGuard, RolesGuard)
  @Roles(UserRole.User, UserRole.Partner)
  likeStylePost(
    @Args("stylePostId") stylePostId: string,
    @Context() context: { req?: { user?: { userId?: string; role?: string } } },
  ) {
    return this.stylePostsService.like(stylePostId, currentUser(context).userId);
  }

  @Mutation(() => StylePostType)
  @UseGuards(JwtAccessTokenGuard, RolesGuard)
  @Roles(UserRole.User, UserRole.Partner)
  unlikeStylePost(
    @Args("stylePostId") stylePostId: string,
    @Context() context: { req?: { user?: { userId?: string; role?: string } } },
  ) {
    return this.stylePostsService.unlike(stylePostId, currentUser(context).userId);
  }
}
