import { Module } from "@nestjs/common";
import { NotificationRepository } from "./notification.repository";
import { NotificationResolver } from "./notification.resolver";
import { NotificationService } from "./notification.service";

@Module({
  providers: [NotificationRepository, NotificationResolver, NotificationService],
  exports: [NotificationRepository, NotificationService],
})
export class NotificationModule {}
