import { Module } from "@nestjs/common";
import { AuthModule } from "src/modules/auth/auth.module";
import { FoAccountRepository } from "./fo-account.repository";
import { FoAccountResolver } from "./fo-account.resolver";
import { FoAccountService } from "./fo-account.service";

@Module({
  imports: [AuthModule],
  providers: [FoAccountRepository, FoAccountResolver, FoAccountService],
  exports: [FoAccountService],
})
export class FoAccountModule {}
