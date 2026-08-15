import { ExecutionContext, Injectable } from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { randomBytes } from "crypto";
import { Request, Response } from "express";
import { CustomUnauthorizedException } from "src/common/errors/custom-exceptions";
import { AuthErrorMessage } from "src/modules/auth/auth.error";
import { authCookieOptions } from "src/modules/auth/cookie-options";

@Injectable()
export class KakaoGuard extends AuthGuard("kakao") {
  getAuthenticateOptions(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();

    if (request.path.endsWith("/kakao/callback")) {
      const state = request.query.state;
      const savedState = request.cookies?.kakao_oauth_state;
      if (typeof request.query.code !== "string" || typeof state !== "string" || !savedState || state !== savedState) {
        throw new CustomUnauthorizedException(AuthErrorMessage.InvalidOauthState);
      }

      return { state };
    }

    const state = randomBytes(32).toString("hex");
    const flowId = request.query.flowId;
    if (typeof flowId !== "string" || !/^[0-9a-f-]{36}$/iu.test(flowId))
      throw new CustomUnauthorizedException(AuthErrorMessage.InvalidOauthState);
    response.cookie("kakao_oauth_state", state, { ...authCookieOptions, maxAge: 5 * 60 * 1000 });
    response.cookie("kakao_oauth_flow", flowId, { ...authCookieOptions, maxAge: 5 * 60 * 1000 });
    return { state };
  }
}
