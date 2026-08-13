import { Module } from "@nestjs/common";
import { IdentityVerificationController } from "./identity-verification.controller";
import { IdentityVerificationRepository } from "./identity-verification.repository";
import { IdentityVerificationResolver } from "./identity-verification.resolver";
import { IdentityVerificationService } from "./identity-verification.service";
import { InicisIdentityAdapter } from "./inicis-identity.adapter";

@Module({
  controllers: [IdentityVerificationController],
  providers: [
    IdentityVerificationResolver,
    IdentityVerificationService,
    IdentityVerificationRepository,
    InicisIdentityAdapter,
  ],
  exports: [IdentityVerificationService],
})
export class IdentityVerificationModule {}
