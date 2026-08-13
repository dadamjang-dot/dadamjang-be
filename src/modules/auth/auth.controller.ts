import { Controller, Get, Req, Res, UseGuards } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Response } from "express";
import { CustomUnauthorizedException } from "src/common/errors/custom-exceptions";
import { KakaoGuard } from "src/guards/kakao.guard";
import { KakaoFlowService } from "src/modules/fo-auth/kakao-flow.service";
import { AuthErrorMessage } from "./auth.error";
import { authCookieOptions } from "./cookie-options";
import { KakaoRequest } from "./auth.types";

@Controller("api/auth")
export class AuthController {
  constructor(
    private readonly kakaoFlowService: KakaoFlowService,
    private readonly configService: ConfigService,
  ) {}
  @UseGuards(KakaoGuard)
  @Get("kakao")
  kakaoLogin() {
    return;
  }
  @UseGuards(KakaoGuard)
  @Get("kakao/callback")
  async kakaoCallback(@Req() req: KakaoRequest, @Res({ passthrough: true }) res: Response) {
    const flowId = req.cookies.kakao_oauth_flow;
    if (!flowId) throw new CustomUnauthorizedException(AuthErrorMessage.InvalidOauthState);
    await this.kakaoFlowService.acceptCallback(flowId, req.user);
    const redirectUrl = new URL(
      this.configService.get<string>("DADAMJANG_FO_AUTH_REDIRECT_URL") ?? "dadamjang://auth/kakao-callback",
    );
    redirectUrl.searchParams.set("flowId", flowId);
    res.clearCookie("kakao_oauth_state", authCookieOptions);
    res.clearCookie("kakao_oauth_flow", authCookieOptions);
    return res.redirect(redirectUrl.toString());
  }
}
