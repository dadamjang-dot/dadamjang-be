import { Module } from "@nestjs/common";
import { MediaModule } from "src/modules/media/media.module";
import { CatalogResolver } from "./catalog.resolver";
import { CatalogService } from "./catalog.service";

@Module({ imports: [MediaModule], providers: [CatalogService, CatalogResolver], exports: [CatalogService] })
export class CatalogModule {}
