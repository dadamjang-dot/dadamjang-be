import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PassportStrategy } from "@nestjs/passport";
import type { Request } from "express";
import { ExtractJwt, Strategy, type StrategyOptions } from "passport-jwt";
import { CustomUnauthorizedException } from "src/common/errors/custom-exceptions";
import { AuthErrorMessage } from "src/modules/auth/auth.error";
import { isRefreshJwtPayload, JWT_ISSUER, JWT_REFRESH_AUDIENCE, RefreshJwtPayload } from "src/modules/auth/auth.types";

type RefreshRequest = Request & {
  cookies: { refresh_token?: string };
  user: RefreshJwtPayload;
  refreshToken?: string;
};

const refreshTokenFromRequest = (request: Request) => {
  const authorization = request.headers.authorization;

  if (authorization?.startsWith("Bearer ")) return authorization.slice("Bearer ".length);
  return request.cookies?.refresh_token ?? null;
};

@Injectable()
export class JwtRefreshTokenStrategy extends PassportStrategy(Strategy, "refresh_token") {
  constructor(configService: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([refreshTokenFromRequest]),
      secretOrKey: configService.getOrThrow<string>("JWT_REFRESH_TOKEN_SECRET"),
      ignoreExpiration: false,
      issuer: JWT_ISSUER,
      audience: JWT_REFRESH_AUDIENCE,
      algorithms: ["HS256"],
      passReqToCallback: true,
    } satisfies StrategyOptions);
  }

  validate = (req: RefreshRequest, payload: unknown) => {
    const refreshToken = refreshTokenFromRequest(req);

    if (!refreshToken) {
      throw new CustomUnauthorizedException(AuthErrorMessage.RefreshTokenUndefined);
    }
    if (!isRefreshJwtPayload(payload)) throw new CustomUnauthorizedException(AuthErrorMessage.AuthRequired);

    req.user = payload;
    req.refreshToken = refreshToken;

    return payload;
  };
}
