import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AdmissionModule } from "src/modules/admission/admission.module";
import { EmailRepository } from "./email.repository";
import { DevEmailSender, ResendEmailSender } from "./email.sender";
import { EmailResolver } from "./email.resolver";
import { EmailService } from "./email.service";

@Module({
  imports: [AdmissionModule],
  providers: [
    EmailResolver,
    EmailService,
    EmailRepository,
    {
      provide: "EmailSender",
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const apiKey = config.get<string>("RESEND_API_KEY")?.trim();
        const fromEmail = config.get<string>("RESEND_FROM_EMAIL")?.trim();
        if (apiKey && fromEmail) return new ResendEmailSender(config);
        if (config.get<string>("NODE_ENV") === "production") {
          const missing = [apiKey ? undefined : "RESEND_API_KEY", fromEmail ? undefined : "RESEND_FROM_EMAIL"].filter(
            (name): name is string => name !== undefined,
          );
          throw new Error(`${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} required in production`);
        }
        return new DevEmailSender(config);
      },
    },
  ],
  exports: [EmailService],
})
export class EmailModule {}
