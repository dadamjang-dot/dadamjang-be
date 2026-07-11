import { Module } from "@nestjs/common";
import { CatalogModule } from "src/modules/catalog/catalog.module";
import { DatabaseModule } from "src/modules/database/database.module";
import { ComparisonResolver } from "./comparison.resolver";
import { ComparisonService } from "./comparison.service";

@Module({
  imports: [DatabaseModule, CatalogModule],
  providers: [ComparisonResolver, ComparisonService],
})
export class ComparisonModule {}
