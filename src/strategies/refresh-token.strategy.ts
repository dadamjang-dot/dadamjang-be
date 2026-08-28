import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PassportStrategy } from "@nestjs/passport";
import type { Request } from "express";
import { ExtractJwt, Strategy, type StrategyOptions } from "passport-jwt";
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
  constructor(
    configService: ConfigService,
    private readonly authService: AuthService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([refreshTokenFromRequest]),
      secretOrKey: configService.getOrThrow<string>("JWT_REFRESH_TOKEN_SECRET"),
      ignoreExpiration: false,
      passReqToCallback: true,
    } satisfies StrategyOptions);
  }

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
