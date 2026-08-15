import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PassportStrategy } from "@nestjs/passport";
import { Strategy } from "passport-kakao";
import { KakaoProfile, KakaoRawProfile } from "src/modules/auth/auth.types";

@Injectable()
export class KakaoStrategy extends PassportStrategy(Strategy, "kakao") {
  constructor(configService: ConfigService) {
    super({
      clientID: configService.getOrThrow<string>("KAKAO_CLIENT_ID"),
      clientSecret: configService.get<string>("KAKAO_CLIENT_SECRET"),
      callbackURL: configService.getOrThrow<string>("KAKAO_CALLBACK_URL"),
    });
  }

  validate(_accessToken: string, _refreshToken: string, profile: KakaoRawProfile): KakaoProfile {
    const account = profile._json?.kakao_account;
    return {
      providerUserId: String(profile.id),
      email: account?.email,
      emailVerified: account?.is_email_valid === true && account.is_email_verified === true,
    };
  }
}
