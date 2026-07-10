import { Module } from "@nestjs/common";
import { CatalogModule } from "src/modules/catalog/catalog.module";
import { OrderModule } from "src/modules/order/order.module";
import { AdminResolver } from "./admin.resolver";
import { AdminService } from "./admin.service";

@Module({
  imports: [CatalogModule, OrderModule],
  providers: [AdminService, AdminResolver],
  exports: [AdminService],
})
export class AdminModule {}
