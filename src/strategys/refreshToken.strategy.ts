import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PassportStrategy } from "@nestjs/passport";
import { Request } from "express";
import { ExtractJwt, Strategy, StrategyOptions } from "passport-jwt";
import { CustomUnauthorizedException } from "src/common/errors/custom-exceptions";
import { AuthErrorMessage } from "src/modules/auth/auth.error";
import { AuthService } from "src/modules/auth/auth.service";
import { AuthRequest, JwtPayload } from "src/modules/auth/auth.types";

type RefreshRequest = AuthRequest & { refreshToken?: string };

const refreshTokenFromRequest = (request: Request) => {
  const authorization = request.headers.authorization;

  if (authorization?.startsWith("Bearer ")) return authorization.slice("Bearer ".length);
  return request.cookies?.refresh_token ?? null;
};

@Injectable()
export class JwtRefreshTokenStrategy extends PassportStrategy(Strategy, "refresh_token") {
  /**
   * refresh token 쿠키 기반 JWT 전략을 설정한다.
   *
   * @param configService 환경 설정 서비스
   * @param authService 인증 서비스
   */
  constructor(
    private readonly configService: ConfigService,
    private readonly authService: AuthService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        (request: Request) => {
          return refreshTokenFromRequest(request);
        },
      ]),
      secretOrKey: configService.getOrThrow<string>("JWT_REFRESH_TOKEN_SECRET"),
      ignoreExpiration: false,
      passReqToCallback: true,
    } satisfies StrategyOptions);
  }

  /**
   * refresh token 쿠키와 저장된 해시를 검증하고 payload를 요청 객체에 주입한다.
   *
   * @param req 인증 요청 객체
   * @param payload refresh token payload
   * @returns refresh token payload
   * @throws {CustomUnauthorizedException} refresh token이 없거나 저장된 값과 다를 때
   */
  async validate(req: RefreshRequest, payload: JwtPayload & { deviceId: string }) {
    const refreshToken = refreshTokenFromRequest(req);

    if (!refreshToken) {
      throw new CustomUnauthorizedException(AuthErrorMessage.RefreshTokenUndefined);
    }

    const result = await this.authService.compareUserRefreshToken(payload.userId, payload.deviceId, refreshToken);

    if (!result) {
      throw new CustomUnauthorizedException(AuthErrorMessage.RefreshTokenWrong);
    }
    req.user = payload;
    req.refreshToken = refreshToken;

    return payload;
  }
}
