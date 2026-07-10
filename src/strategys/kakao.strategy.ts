import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PassportStrategy } from "@nestjs/passport";
import { Strategy } from "passport-kakao";
import { KakaoProfile, KakaoRawProfile } from "src/modules/auth/auth.types";

@Injectable()
export class KakaoStrategy extends PassportStrategy(Strategy, "kakao") {
  /**
   * 카카오 OAuth 전략을 설정한다.
   *
   * @param configService 환경 설정 서비스
   */
  constructor(configService: ConfigService) {
    super({
      clientID: configService.getOrThrow<string>("KAKAO_CLIENT_ID"),
      clientSecret: configService.get<string>("KAKAO_CLIENT_SECRET"),
      callbackURL: configService.getOrThrow<string>("KAKAO_CALLBACK_URL"),
    });
  }

  /**
   * 카카오 프로필을 내부 인증 프로필 형태로 변환한다.
   *
   * @param _accessToken 카카오 access token
   * @param _refreshToken 카카오 refresh token
   * @param profile 카카오 원본 프로필
   * @returns 내부 카카오 프로필
   */
  validate(_accessToken: string, _refreshToken: string, profile: KakaoRawProfile): KakaoProfile {
    return {
      providerUserId: String(profile.id),
      email: profile._json?.kakao_account?.email,
    };
  }
}
