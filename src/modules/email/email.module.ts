import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { EmailRepository } from "./email.repository";
import { DevEmailSender, ResendEmailSender } from "./email.sender";
import { EmailResolver } from "./email.resolver";
import { EmailService } from "./email.service";

@Module({
  providers: [
    EmailResolver,
    EmailService,
    EmailRepository,
    {
      provide: "EmailSender",
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        if (config.get<string>("RESEND_API_KEY")?.trim()) return new ResendEmailSender(config);
        if (config.get<string>("NODE_ENV") === "production")
          throw new Error("RESEND_API_KEY is required in production");
        return new DevEmailSender(config);
      },
    },
  ],
  exports: [EmailService],
})
export class EmailModule {}
