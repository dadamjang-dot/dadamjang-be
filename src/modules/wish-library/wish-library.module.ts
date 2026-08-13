import { Module } from "@nestjs/common";

import { CatalogModule } from "src/modules/catalog/catalog.module";
import { WishLibraryResolver } from "./wish-library.resolver";
import { WishLibraryService } from "./wish-library.service";

@Module({
  imports: [CatalogModule],
  providers: [WishLibraryService, WishLibraryResolver],
})
export class WishLibraryModule {}
