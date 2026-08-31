import { Module } from "@nestjs/common";
import { FoAccountRepository } from "./fo-account.repository";
import { FoAccountService } from "./fo-account.service";

@Module({
  providers: [FoAccountRepository, FoAccountService],
  exports: [FoAccountService],
})
export class FoAccountModule {}
