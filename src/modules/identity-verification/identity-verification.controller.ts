import { Body, Controller, Get, Param, Post, Res } from "@nestjs/common";
import type { Response } from "express";
import { ConfigService } from "@nestjs/config";
import { IdentityVerificationService } from "./identity-verification.service";

type CallbackBody = {
  readonly resultCode?: string;
  readonly authRequestUrl?: string;
  readonly txId?: string;
  readonly token?: string;
};

const escapeHtml = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

@Controller("api/auth/identity/inicis")
export class IdentityVerificationController {
  constructor(
    private readonly service: IdentityVerificationService,
    private readonly configService: ConfigService,
  ) {}

  @Get("start/:sessionId")
  async start(@Param("sessionId") sessionId: string, @Res() res: Response) {
    const page = await this.service.requestPage(sessionId);
    if (page.kind === "mock") return res.redirect(this.redirectUrl(sessionId, "verified", page.callbackToken));
    const inputs = Object.entries(page.request.fields)
      .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
      .join("");
    return res
      .type("html")
      .send(
        `<form id="identity" method="post" action="${page.request.action}">${inputs}</form><script>document.getElementById("identity").submit()</script>`,
      );
  }

  @Post("success/:sessionId")
  async success(@Param("sessionId") sessionId: string, @Body() body: CallbackBody, @Res() res: Response) {
    const { callbackToken } = await this.service.callback(sessionId, {
      resultCode: body.resultCode ?? "",
      ...(body.authRequestUrl === undefined ? {} : { authRequestUrl: body.authRequestUrl }),
      ...(body.txId === undefined ? {} : { transactionId: body.txId }),
      ...(body.token === undefined ? {} : { token: body.token }),
    });
    return res.redirect(this.redirectUrl(sessionId, "verified", callbackToken));
  }

  @Post("fail/:sessionId")
  async fail(@Param("sessionId") sessionId: string, @Body() body: CallbackBody, @Res() res: Response) {
    await this.service.fail(sessionId, body.resultCode ?? "CANCELED");
    return res.redirect(this.redirectUrl(sessionId, "failed"));
  }

  private redirectUrl = (sessionId: string, status: "verified" | "failed", callbackToken?: string) => {
    const target = new URL(
      this.configService.get<string>("DADAMJANG_FO_IDENTITY_REDIRECT_URL") ?? "dadamjang://auth/identity-callback",
    );
    target.searchParams.set("sessionId", sessionId);
    target.searchParams.set("status", status);
    if (callbackToken) target.searchParams.set("callbackToken", callbackToken);
    return target.toString();
  };
}
