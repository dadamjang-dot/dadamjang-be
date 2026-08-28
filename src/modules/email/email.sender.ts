import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

export interface EmailSender {
  sendCode(email: string, code: string): Promise<void>;
  sendLink(email: string, subject: string, url: string): Promise<void>;
}

@Injectable()
export class DevEmailSender implements EmailSender {
  constructor(private readonly configService: ConfigService) {}
  sendCode = async (email: string, _code: string) => {
    this.assertDelivery(email);
  };
  sendLink = async (email: string, _subject: string, _url: string) => {
    this.assertDelivery(email);
  };
  private assertDelivery = (email: string) => {
    if (this.configService.get<string>("EMAIL_DEV_FAIL_RECIPIENT") === email)
      throw new Error("Simulated development email failure");
  };
}

@Injectable()
export class ResendEmailSender implements EmailSender {
  constructor(private readonly configService: ConfigService) {}
  sendCode = async (email: string, code: string) =>
    this.send(email, "이메일 인증번호", `<p>인증번호: <strong>${code}</strong></p>`);
  sendLink = async (email: string, subject: string, url: string) =>
    this.send(email, subject, `<p><a href="${url}">계속하기</a></p>`);
  private send = async (to: string, subject: string, html: string) => {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.configService.getOrThrow<string>("RESEND_API_KEY").trim()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: this.configService.getOrThrow<string>("RESEND_FROM_EMAIL").trim(),
        to: [to],
        subject,
        html,
      }),
    });
    if (!response.ok) throw new Error(`Resend failed: ${response.status}`);
  };
}
