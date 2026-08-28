import { Module } from "@nestjs/common";
import { AuthModule } from "src/modules/auth/auth.module";
import { EmailModule } from "src/modules/email/email.module";
import { AdmissionModule } from "src/modules/admission/admission.module";
import { FoAuthRepository } from "./fo-auth.repository";
import { FoAuthResolver } from "./fo-auth.resolver";
import { FoAuthService } from "./fo-auth.service";

@Module({
  imports: [AuthModule, EmailModule, AdmissionModule],
  providers: [FoAuthResolver, FoAuthService, FoAuthRepository],
  exports: [FoAuthService],
})
export class FoAuthModule {}
