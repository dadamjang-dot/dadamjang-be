import { Module } from "@nestjs/common";
import { CatalogResolver } from "./catalog.resolver";
import { CatalogService } from "./catalog.service";

@Module({ providers: [CatalogService, CatalogResolver], exports: [CatalogService] })
export class CatalogModule {}
