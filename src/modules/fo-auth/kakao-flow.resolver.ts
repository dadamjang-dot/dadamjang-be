import { Args, Context, Mutation, Resolver } from "@nestjs/graphql";
import type { Request, Response } from "express";
import { requestOriginFromRequest } from "src/modules/admission/admission-limiter";
import { deviceIdFromRequest, setTokenCookies } from "src/modules/auth/auth-http";
import { TokenPayload } from "src/modules/auth/auth.types";
import {
  CompleteKakaoLoginInput,
  CompleteKakaoSignupFoInput,
  KakaoLoginResult,
  KakaoLoginStartPayload,
} from "./fo-auth.types";
import { KakaoFlowService } from "./kakao-flow.service";

@Resolver()
export class KakaoFlowResolver {
  constructor(private readonly service: KakaoFlowService) {}

  @Mutation(() => KakaoLoginStartPayload)
  startKakaoLogin(@Context("req") req: Request) {
    return this.service.start(deviceIdFromRequest(req), requestOriginFromRequest(req));
  }

  @Mutation(() => KakaoLoginResult)
  async completeKakaoLogin(
    @Args("input") input: CompleteKakaoLoginInput,
    @Context("req") req: Request,
    @Context("res") res: Response,
  ) {
    const result = await this.service.completeLogin(input.flowId, deviceIdFromRequest(req), input.callbackToken);
    if (result.tokenPayload) setTokenCookies(res, result.tokenPayload);
    return result;
  }

  @Mutation(() => TokenPayload)
  async completeKakaoSignupFo(
    @Args("input") input: CompleteKakaoSignupFoInput,
    @Context("req") req: Request,
    @Context("res") res: Response,
  ) {
    const result = await this.service.completeSignup(input, deviceIdFromRequest(req));
    setTokenCookies(res, result);
    return result;
  }
}
