import { Module } from "@nestjs/common";
import { AdmissionLimiter } from "./admission-limiter";

@Module({ providers: [AdmissionLimiter], exports: [AdmissionLimiter] })
export class AdmissionModule {}
