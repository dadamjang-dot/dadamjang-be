import { Module } from "@nestjs/common";
import { AdmissionModule } from "src/modules/admission/admission.module";
import { MediaResolver } from "./media.resolver";
import { MediaService } from "./media.service";

@Module({
  imports: [AdmissionModule],
  providers: [MediaResolver, MediaService],
  exports: [MediaService],
})
export class MediaModule {}
