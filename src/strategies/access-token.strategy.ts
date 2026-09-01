import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PassportStrategy } from "@nestjs/passport";
import type { Request } from "express";
import { ExtractJwt, Strategy, type StrategyOptions } from "passport-jwt";
import { CustomUnauthorizedException } from "src/common/errors/custom-exceptions";
import { AuthErrorMessage } from "src/modules/auth/auth.error";
import { AuthRepository } from "src/modules/auth/auth.repository";
import { AuthRequest, isAccessJwtPayload, JWT_ACCESS_AUDIENCE, JWT_ISSUER } from "src/modules/auth/auth.types";

@Injectable()
export class JwtAccessTokenStrategy extends PassportStrategy(Strategy, "access_token") {
  constructor(
    configService: ConfigService,
    private readonly authRepository: AuthRepository,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        (request: Request) => {
          const authorization = request.headers.authorization;
          if (authorization?.startsWith("Bearer ")) return authorization.slice("Bearer ".length);
          return request.cookies?.access_token ?? null;
        },
      ]),

      secretOrKey: configService.getOrThrow<string>("JWT_ACCESS_TOKEN_SECRET"),
      ignoreExpiration: false,
      issuer: JWT_ISSUER,
      audience: JWT_ACCESS_AUDIENCE,
      algorithms: ["HS256"],
      passReqToCallback: true,
    } satisfies StrategyOptions);
  }

  validate = async (req: AuthRequest, payload: unknown) => {
    if (!isAccessJwtPayload(payload)) throw new CustomUnauthorizedException(AuthErrorMessage.AuthRequired);
    const user = await this.authRepository.findUser(payload.userId);
    if (!user || user.deactivatedAt || user.anonymizedAt)
      throw new CustomUnauthorizedException(AuthErrorMessage.AuthRequired);
    req.user = payload;
    return payload;
  };
}
