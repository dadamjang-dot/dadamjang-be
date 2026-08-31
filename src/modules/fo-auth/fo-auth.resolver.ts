import { Args, Context, Mutation, Query, Resolver } from "@nestjs/graphql";
import { UseGuards } from "@nestjs/common";
import type { Request, Response } from "express";
import { JwtAccessTokenGuard } from "src/guards/access-token.guard";
import { requestOriginFromRequest } from "src/modules/admission/admission-limiter";
import { deviceIdFromRequest, setTokenCookies } from "src/modules/auth/auth-http";
import type { AuthRequest } from "src/modules/auth/auth.types";
import { TokenPayload } from "src/modules/auth/auth.types";
import { FoAuthService } from "./fo-auth.service";
import {
  FindFoEmailPayload,
  FoSigninResult,
  MarketingConsentPayload,
  SigninFoInput,
  SignupConsentDocument,
  SignupFoInput,
} from "./fo-auth.types";

@Resolver()
export class FoAuthResolver {
  constructor(private readonly service: FoAuthService) {}

  @Mutation(() => FoSigninResult)
  async signinFo(@Args("input") input: SigninFoInput, @Context("req") req: Request, @Context("res") res: Response) {
    const result = await this.service.signin(input, deviceIdFromRequest(req), requestOriginFromRequest(req));
    if ("tokenPayload" in result && result.tokenPayload) setTokenCookies(res, result.tokenPayload);
    return result;
  }

  @Mutation(() => TokenPayload)
  async signupFo(@Args("input") input: SignupFoInput, @Context("req") req: Request, @Context("res") res: Response) {
    const result = await this.service.signup(input, deviceIdFromRequest(req));
    setTokenCookies(res, result);
    return result;
  }

  @Query(() => [SignupConsentDocument])
  activeSignupConsentDocuments() {
    return this.service.activeConsentDocuments();
  }

  @Mutation(() => FindFoEmailPayload)
  findFoEmail(@Args("identityVerificationToken") identityVerificationToken: string, @Context("req") req: Request) {
    return this.service.findEmail(identityVerificationToken, deviceIdFromRequest(req));
  }

  @UseGuards(JwtAccessTokenGuard)
  @Mutation(() => MarketingConsentPayload)
  updateMarketingConsent(@Args("agreed") agreed: boolean, @Context("req") req: AuthRequest) {
    return this.service.updateMarketingConsent(req.user.userId, agreed);
  }
}
