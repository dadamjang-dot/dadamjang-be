import { Module } from "@nestjs/common";
import { EmailModule } from "src/modules/email/email.module";
import { AdminResolver } from "./admin.resolver";
import { AdminService } from "./admin.service";

@Module({
  imports: [EmailModule],
  providers: [AdminService, AdminResolver],
  exports: [AdminService],
})
export class AdminModule {}
