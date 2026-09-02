import { UseGuards } from "@nestjs/common";
import { Args, Context, ID, Int, Mutation, Query, Resolver } from "@nestjs/graphql";
import { UserRole } from "src/auth/role";
import { Roles } from "src/auth/roles.decorator";
import { JwtAccessTokenGuard } from "src/guards/access-token.guard";
import { RolesGuard } from "src/guards/roles.guard";
import { deviceIdFromRequest } from "src/modules/auth/auth-http";
import type { AuthRequest } from "src/modules/auth/auth.types";
import { NotificationService } from "./notification.service";
import {
  FoNotification,
  FoNotificationConnection,
  FoNotificationPreferences,
  RegisterFoPushDeviceInput,
  UpdateFoNotificationPreferencesInput,
} from "./notification.types";

@Resolver()
@UseGuards(JwtAccessTokenGuard, RolesGuard)
@Roles(UserRole.User, UserRole.Partner)
export class NotificationResolver {
  constructor(private readonly service: NotificationService) {}

  @Query(() => FoNotificationConnection)
  foNotifications(
    @Context("req") req: AuthRequest,
    @Args("first", { type: () => Int, nullable: true }) first?: number,
    @Args("after", { nullable: true }) after?: string,
  ) {
    return this.service.list(req.user.userId, first, after);
  }

  @Query(() => FoNotification)
  foNotification(@Context("req") req: AuthRequest, @Args("notificationId", { type: () => ID }) notificationId: string) {
    return this.service.get(req.user.userId, notificationId);
  }

  @Mutation(() => FoNotification)
  markFoNotificationRead(
    @Context("req") req: AuthRequest,
    @Args("notificationId", { type: () => ID }) notificationId: string,
  ) {
    return this.service.markRead(req.user.userId, notificationId);
  }

  @Mutation(() => Boolean)
  markAllFoNotificationsRead(@Context("req") req: AuthRequest) {
    return this.service.markAllRead(req.user.userId);
  }

  @Query(() => FoNotificationPreferences)
  foNotificationPreferences(@Context("req") req: AuthRequest) {
    return this.service.getPreferences(req.user.userId);
  }

  @Mutation(() => FoNotificationPreferences)
  updateFoNotificationPreferences(
    @Context("req") req: AuthRequest,
    @Args("input") input: UpdateFoNotificationPreferencesInput,
  ) {
    return this.service.updatePreferences(req.user.userId, input);
  }

  @Mutation(() => Boolean)
  registerFoPushDevice(@Context("req") req: AuthRequest, @Args("input") input: RegisterFoPushDeviceInput) {
    return this.service.registerDevice(req.user.userId, deviceIdFromRequest(req), input);
  }
}
