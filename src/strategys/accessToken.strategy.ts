import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PassportStrategy } from "@nestjs/passport";
import { Request } from "express";
import { ExtractJwt, Strategy, StrategyOptions } from "passport-jwt";
import { AuthRequest, JwtPayload } from "src/modules/auth/auth.types";

@Injectable()
export class JwtAccessTokenStrategy extends PassportStrategy(Strategy, "access_token") {
  /**
   * access token 쿠키 기반 JWT 전략을 설정한다.
   *
   * @param configService 환경 설정 서비스
   */
  constructor(private readonly configService: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        (request: Request) => {
          return request.cookies?.access_token ?? null;
        },
      ]),

      secretOrKey: configService.getOrThrow<string>("JWT_ACCESS_TOKEN_SECRET"),
      ignoreExpiration: false,
      passReqToCallback: true,
    } satisfies StrategyOptions);
  }

  /**
   * access token payload를 요청 객체에 주입한다.
   *
   * @param req 인증 요청 객체
   * @param payload access token payload
   * @returns access token payload
   */
  validate(req: AuthRequest, payload: JwtPayload) {
    req.user = payload;
    return payload;
  }
}
