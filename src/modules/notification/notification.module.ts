import { Module } from "@nestjs/common";
import { NotificationRepository } from "./notification.repository";
import { NotificationOutboxWorker } from "./notification.outbox";
import { NotificationResolver } from "./notification.resolver";
import { ExpoPushSender } from "./notification.sender";
import { NotificationService } from "./notification.service";

@Module({
  providers: [
    ExpoPushSender,
    NotificationOutboxWorker,
    NotificationRepository,
    NotificationResolver,
    NotificationService,
  ],
  exports: [NotificationOutboxWorker, NotificationRepository, NotificationService],
})
export class NotificationModule {}
