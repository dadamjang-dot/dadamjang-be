import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { EmailRepository } from "./email.repository";
import { DevEmailSender, ResendEmailSender } from "./email.sender";
import { EmailResolver } from "./email.resolver";
import { EmailService } from "./email.service";

@Module({ providers: [EmailResolver, EmailService, EmailRepository, { provide: "EmailSender", inject: [ConfigService], useFactory: (config: ConfigService) => config.get<string>("RESEND_API_KEY") ? new ResendEmailSender(config) : new DevEmailSender() }], exports: [EmailService] })
export class EmailModule {}
