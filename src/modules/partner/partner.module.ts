import { Module } from "@nestjs/common";
import { CatalogModule } from "src/modules/catalog/catalog.module";
import { EmailModule } from "src/modules/email/email.module";
import { PartnerResolver } from "./partner.resolver";
import { PartnerService } from "./partner.service";

@Module({
  imports: [CatalogModule, EmailModule],
  providers: [PartnerService, PartnerResolver],
  exports: [PartnerService],
})
export class PartnerModule {}
