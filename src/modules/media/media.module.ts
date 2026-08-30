import { Module } from "@nestjs/common";
import { AdmissionModule } from "src/modules/admission/admission.module";
import { MediaResolver } from "./media.resolver";
import { MediaRepository } from "./media.repository";
import { MediaService } from "./media.service";

@Module({
  imports: [AdmissionModule],
  providers: [MediaResolver, MediaRepository, MediaService],
  exports: [MediaService],
})
export class MediaModule {}
