import { Module } from "@nestjs/common";
import { CatalogModule } from "src/modules/catalog/catalog.module";
import { MediaModule } from "src/modules/media/media.module";
import { EmailModule } from "src/modules/email/email.module";
import { NotificationModule } from "src/modules/notification/notification.module";
import { PartnerResolver } from "./partner.resolver";
import { PartnerService } from "./partner.service";

@Module({
  imports: [CatalogModule, EmailModule, MediaModule, NotificationModule],
  providers: [PartnerService, PartnerResolver],
  exports: [PartnerService],
})
export class PartnerModule {}
