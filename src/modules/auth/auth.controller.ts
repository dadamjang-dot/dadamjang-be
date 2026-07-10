import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import { KakaoGuard } from "src/guards/kakao.guard";
import { AuthService } from "./auth.service";
import { KakaoRequest } from "./auth.types";

@Controller("api/auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}
  @UseGuards(KakaoGuard)
  @Get("kakao")
  kakaoLogin() { return; }
  @UseGuards(KakaoGuard) @Get("kakao/callback") async kakaoCallback(@Req() req: KakaoRequest) { const deviceId = String(req.headers["x-device-id"] ?? "kakao-browser"); const result = await this.authService.beginKakao(req.user, deviceId); return result; }
}
