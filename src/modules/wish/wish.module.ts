import { Module } from "@nestjs/common";
import { CatalogModule } from "src/modules/catalog/catalog.module";
import { WishResolver } from "./wish.resolver";
import { WishService } from "./wish.service";

@Module({
  imports: [CatalogModule],
  providers: [WishService, WishResolver],
  exports: [WishService],
})
export class WishModule {}
