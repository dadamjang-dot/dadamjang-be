import { Args, Context, Mutation, Query, Resolver } from "@nestjs/graphql";
import { UseGuards } from "@nestjs/common";
import { UserRole } from "src/auth/role";
import { Roles } from "src/auth/roles.decorator";
import { CustomUnauthorizedException } from "src/common/errors/custom-exceptions";
import { JwtAccessTokenGuard } from "src/guards/accessToken.guard";
import { RolesGuard } from "src/guards/roles.guard";
import { EventService } from "./event.service";
import { ActivityEventType, RecordActivityEventInput } from "./event.types";

const currentUserId = (context: { req?: { user?: { userId?: string } } }) => {
  const userId = context.req?.user?.userId;
  if (!userId) throw new CustomUnauthorizedException("Authentication required");
  return userId;
};

@Resolver()
@UseGuards(JwtAccessTokenGuard, RolesGuard)
@Roles(UserRole.User)
export class EventResolver {
  constructor(private readonly eventService: EventService) {}
  @Query(() => [ActivityEventType])
  myActivity(@Context() context: { req?: { user?: { userId?: string } } }) {
    return this.eventService.listUserActivity(currentUserId(context));
  }
  @Mutation(() => ActivityEventType)
  recordActivity(
    @Args("input") input: RecordActivityEventInput,
    @Context() context: { req?: { user?: { userId?: string } } },
  ) {
    return this.eventService.recordActivity(
      currentUserId(context),
      input.eventType,
      input.subjectType,
      input.subjectId,
    );
  }
}
