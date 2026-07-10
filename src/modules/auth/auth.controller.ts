import { Controller, Get, Req, Res, UseGuards } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Response } from "express";
import { KakaoGuard } from "src/guards/kakao.guard";
import { AuthService } from "./auth.service";
import { KakaoRequest } from "./auth.types";

@Controller("api/auth")
export class AuthController {
  constructor(
    private readonly authService: AuthService,
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
    const deviceId = String(req.headers["x-device-id"] ?? "kakao-browser");
    const result = await this.authService.beginKakao(req.user, deviceId);
    const redirectBaseUrl = this.configService.get<string>("DADAMJANG_FO_AUTH_REDIRECT_URL");

    if (redirectBaseUrl) {
      const redirectUrl = new URL(redirectBaseUrl);

      if (result.existingUser) {
        redirectUrl.searchParams.set("accessToken", result.tokenPayload.accessToken);
        redirectUrl.searchParams.set("refreshToken", result.tokenPayload.refreshToken);
        redirectUrl.searchParams.set("role", result.tokenPayload.role);
      } else {
        redirectUrl.searchParams.set("kakaoSignupToken", result.kakaoSignupToken);
      }

      return res.redirect(redirectUrl.toString());
    }

    return result;
  }
}
