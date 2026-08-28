import { Module } from "@nestjs/common";
import { AuthController } from "src/modules/auth/auth.controller";
import { AuthModule } from "src/modules/auth/auth.module";
import { AdmissionModule } from "src/modules/admission/admission.module";
import { EmailModule } from "src/modules/email/email.module";
import { FoAuthModule } from "./fo-auth.module";
import { KakaoFlowRepository } from "./kakao-flow.repository";
import { KakaoFlowResolver } from "./kakao-flow.resolver";
import { KakaoFlowService } from "./kakao-flow.service";

@Module({
  imports: [AdmissionModule, AuthModule, EmailModule, FoAuthModule],
  controllers: [AuthController],
  providers: [KakaoFlowResolver, KakaoFlowService, KakaoFlowRepository],
})
export class KakaoFlowModule {}
