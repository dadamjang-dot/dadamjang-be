import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

export interface EmailSender { sendCode(email: string, code: string): Promise<void>; sendLink(email: string, subject: string, path: string): Promise<void>; }

@Injectable()
export class DevEmailSender implements EmailSender {
  private readonly logger = new Logger(DevEmailSender.name);
  sendCode = async (email: string, code: string) => { this.logger.log(`email_code_dev recipient=${email} code=${code}`); };
  sendLink = async (email: string, subject: string, path: string) => { this.logger.log(`email_link_dev recipient=${email} subject=${subject} path=${path}`); };
}

@Injectable()
export class ResendEmailSender implements EmailSender {
  constructor(private readonly configService: ConfigService) {}
  sendCode = async (email: string, code: string) => this.send(email, "이메일 인증번호", `<p>인증번호: <strong>${code}</strong></p>`);
  sendLink = async (email: string, subject: string, path: string) => {
    const clientUrl = this.configService.getOrThrow<string>("CLIENT_URL").replace(/\/$/, "");
    await this.send(email, subject, `<p><a href="${clientUrl}${path}">계속하기</a></p>`);
  };
  private send = async (to: string, subject: string, html: string) => {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${this.configService.getOrThrow<string>("RESEND_API_KEY")}`, "content-type": "application/json" },
      body: JSON.stringify({ from: this.configService.getOrThrow<string>("RESEND_FROM_EMAIL"), to: [to], subject, html }),
    });
    if (!response.ok) throw new Error(`Resend failed: ${response.status}`);
  };
}
