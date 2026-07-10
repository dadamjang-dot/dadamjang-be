import { Module } from "@nestjs/common";
import { CatalogModule } from "src/modules/catalog/catalog.module";
import { FeedResolver } from "./feed.resolver";
import { FeedService } from "./feed.service";

@Module({ imports: [CatalogModule], providers: [FeedService, FeedResolver] })
export class FeedModule {}
