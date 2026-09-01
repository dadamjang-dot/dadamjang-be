import { Module } from "@nestjs/common";
import { MediaModule } from "src/modules/media/media.module";
import { NotificationModule } from "src/modules/notification/notification.module";
import { StylePostsResolver } from "./style-posts.resolver";
import { StylePostsService } from "./style-posts.service";

@Module({
  imports: [MediaModule, NotificationModule],
  providers: [StylePostsService, StylePostsResolver],
  exports: [StylePostsService],
})
export class StylePostsModule {}
