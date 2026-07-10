import { Module } from "@nestjs/common";
import { CatalogModule } from "src/modules/catalog/catalog.module";
import { WishlistResolver } from "./wishlist.resolver";
import { WishlistService } from "./wishlist.service";

@Module({
  imports: [CatalogModule],
  providers: [WishlistService, WishlistResolver],
  exports: [WishlistService],
})
export class WishlistModule {}
