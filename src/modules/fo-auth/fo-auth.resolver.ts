import { Args, Context, Mutation, Query, Resolver } from "@nestjs/graphql";
import { UseGuards } from "@nestjs/common";
import type { Request, Response } from "express";
import { JwtAccessTokenGuard } from "src/guards/accessToken.guard";
import { deviceIdFromRequest, setTokenCookies } from "src/modules/auth/auth-http";
import type { AuthRequest } from "src/modules/auth/auth.types";
import { TokenPayload } from "src/modules/auth/auth.types";
import { FoAuthService } from "./fo-auth.service";
import {
  FindFoEmailPayload,
  MarketingConsentPayload,
  SigninFoInput,
  SignupConsentDocument,
  SignupFoInput,
} from "./fo-auth.types";

@Resolver()
export class FoAuthResolver {
  constructor(private readonly service: FoAuthService) {}

  @Mutation(() => TokenPayload)
  async signinFo(@Args("input") input: SigninFoInput, @Context("req") req: Request, @Context("res") res: Response) {
    const result = await this.service.signin(input, deviceIdFromRequest(req));
    setTokenCookies(res, result);
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
