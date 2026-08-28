import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PassportStrategy } from "@nestjs/passport";
import type { Request } from "express";
import { ExtractJwt, Strategy, type StrategyOptions } from "passport-jwt";
import { AuthRequest, JwtPayload } from "src/modules/auth/auth.types";

@Injectable()
export class JwtAccessTokenStrategy extends PassportStrategy(Strategy, "access_token") {
  constructor(private readonly configService: ConfigService) {
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
      passReqToCallback: true,
    } satisfies StrategyOptions);
  }

  validate(req: AuthRequest, payload: JwtPayload) {
    req.user = payload;
    return payload;
  }
}
