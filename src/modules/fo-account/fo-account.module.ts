import { Module } from "@nestjs/common";
import { AuthModule } from "src/modules/auth/auth.module";
import { FoAccountRepository } from "./fo-account.repository";
import { FoAccountResolver } from "./fo-account.resolver";
import { FoAccountService } from "./fo-account.service";
import { FoAccountWorker } from "./fo-account.worker";

@Module({
  imports: [AuthModule],
  providers: [FoAccountRepository, FoAccountResolver, FoAccountService, FoAccountWorker],
  exports: [FoAccountService],
})
export class FoAccountModule {}
